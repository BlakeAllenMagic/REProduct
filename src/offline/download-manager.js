// Downloads datasheets into the datasheet cache.
//
// For each file: fetch it, check that its SHA-256 matches the hash in its
// name, and only then save it. A cut-off or damaged download can never end
// up in the cache, which is what makes resuming safe: anything in the cache
// is known to be complete.
//
// Everything the manager touches (network, cache, hashing, timers) is passed
// in, so the logic can be tested in Node with fakes (tests/offline.test.js).
//
// Events (it's an EventTarget):
//   'progress'  detail: current state (see #snapshot)
//   'saved'     detail: { sha, item } after each file lands in the cache
//   'finished'  detail: final state, plus { cancelled, quotaExceeded }

import { savedHashes } from './caches.js';

const CONCURRENCY = 3;
const RETRY_DELAYS_MS = [1000, 4000]; // so up to 3 tries per file

export class PermanentError extends Error {}

export class DownloadManager extends EventTarget {
  /**
   * @param {object} deps
   * @param {(url: string, init: object) => Promise<Response>} deps.fetch
   * @param {() => Promise<Cache>} deps.openCache
   * @param {(sha: string) => string} deps.urlFor where to download a file from
   * @param {(sha: string) => string} [deps.keyFor] its key in the cache (default: urlFor)
   * @param {(buffer: ArrayBuffer) => Promise<string>} deps.sha256
   * @param {(ms: number, signal: AbortSignal) => Promise<void>} deps.sleep
   * @param {() => Promise<unknown>} deps.onFirstSave called once, after the first file is saved
   * @param {() => void} deps.onSyncComplete called when a run finishes with nothing missing
   */
  constructor(deps) {
    super();
    this.deps = deps;
    this.#reset();
    this.firstSaveDone = false;
  }

  get running() {
    return this.state.running;
  }

  #reset() {
    this.queue = [];
    this.queued = new Set();
    this.state = {
      running: false,
      total: 0,
      done: 0,
      bytesTotal: 0,
      bytesDone: 0,
      failed: [], // { sha, label, bytes, error }
      error: null, // a problem that stopped the whole run
    };
    this.cancelled = false;
    this.quotaExceeded = false;
  }

  #snapshot() {
    return { ...this.state, failed: [...this.state.failed] };
  }

  #emit(type, extra = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail: { ...this.#snapshot(), ...extra } }));
  }

  /**
   * Download every item not already in the cache.
   * Items: { sha, bytes, label }. Duplicates (same sha) download once.
   * If a run is already going, new items join it.
   * Resolves when the whole run is finished.
   */
  download(items) {
    if (this.state.running) {
      this.#add(items);
      return this.finished;
    }
    // Everything up to here is synchronous, so cancel() works immediately.
    this.#reset();
    this.state.running = true;
    this.abort = new AbortController();
    this.adding = Promise.resolve();
    this.finished = this.#run(items);
    return this.finished;
  }

  async #run(items) {
    try {
      this.cache = await this.deps.openCache();
      await this.#add(items);
      // Workers stop when the queue is empty. Files added meanwhile (another
      // "Download" tap) restart them, so nothing added mid-run is dropped.
      do {
        const workers = Array.from({ length: CONCURRENCY }, () => this.#worker(this.cache));
        await Promise.all(workers);
        await this.adding;
      } while (this.queue.length > 0 && !this.cancelled && !this.quotaExceeded);
    } catch (error) {
      // e.g. storage blocked entirely; report it instead of hanging.
      this.state.error = describe(error);
    }
    this.state.running = false;
    const complete =
      !this.cancelled && !this.quotaExceeded && !this.state.error && this.state.failed.length === 0;
    if (complete) this.deps.onSyncComplete?.();
    this.#emit('finished', { cancelled: this.cancelled, quotaExceeded: this.quotaExceeded });
    return this.#snapshot();
  }

  /** Queue the items that aren't saved yet (resuming = skipping saved ones). */
  #add(items) {
    const step = (async () => {
      const cache = this.cache ?? (await this.deps.openCache());
      const saved = await savedHashes(cache);
      if (this.cancelled) return;
      this.#enqueue(items.filter((item) => !saved.has(item.sha)));
      this.#emit('progress');
    })();
    this.adding = Promise.all([this.adding, step]);
    return step;
  }

  /** Stop after the files in progress are abandoned. Saved files stay saved. */
  cancel() {
    if (!this.state.running) return;
    this.cancelled = true;
    this.queue.length = 0;
    this.abort.abort();
  }

  /** Download again the files that failed in the last run. */
  retryFailed() {
    const items = this.state.failed.map(({ error, ...item }) => item);
    return this.download(items);
  }

  #enqueue(items) {
    for (const item of items) {
      if (this.queued.has(item.sha)) continue;
      this.queued.add(item.sha);
      this.queue.push(item);
      this.state.total += 1;
      this.state.bytesTotal += item.bytes ?? 0;
    }
  }

  async #worker(cache) {
    while (this.queue.length > 0 && !this.cancelled && !this.quotaExceeded) {
      const item = this.queue.shift();
      try {
        const size = await this.#downloadOne(cache, item);
        this.state.done += 1;
        this.state.bytesDone += size;
        this.dispatchEvent(new CustomEvent('saved', { detail: { sha: item.sha, item } }));
        if (!this.firstSaveDone) {
          this.firstSaveDone = true;
          this.deps.onFirstSave?.();
        }
      } catch (error) {
        // Stopped by cancel() or by a full disk: not a failure of this file.
        if (error?.name === 'AbortError') break;
        if (error?.name === 'QuotaExceededError') {
          this.quotaExceeded = true;
          this.state.failed.push({ ...item, error: 'Device storage is full' });
          this.queue.length = 0;
          this.abort.abort();
        } else {
          this.state.failed.push({ ...item, error: describe(error) });
        }
      }
      this.#emit('progress');
    }
  }

  /** One file, with retries. Returns its size in bytes. */
  async #downloadOne(cache, item) {
    const url = this.deps.urlFor(item.sha);
    const { signal } = this.abort;
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.deps.fetch(url, { signal, cache: 'no-store' });
        if (response.status === 404) throw new PermanentError('Not found on the server');
        if (!response.ok) throw new Error(`Server error (HTTP ${response.status})`);
        const buffer = await response.arrayBuffer();
        const actual = await this.deps.sha256(buffer);
        if (actual !== item.sha) throw new Error('Download was damaged (checksum mismatch)');

        await cache.put(
          this.deps.keyFor ? this.deps.keyFor(item.sha) : url,
          new Response(buffer, {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Length': String(buffer.byteLength),
            },
          }),
        );
        return buffer.byteLength;
      } catch (error) {
        const retryable =
          !(error instanceof PermanentError) &&
          error?.name !== 'AbortError' &&
          error?.name !== 'QuotaExceededError';
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw error;
        await this.deps.sleep(RETRY_DELAYS_MS[attempt], signal);
      }
    }
  }
}

function describe(error) {
  if (error instanceof TypeError) return 'No connection to the server';
  return error instanceof Error ? error.message : String(error);
}

/** Hex SHA-256 of an ArrayBuffer, using the browser's built-in crypto. */
export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A sleep that ends early (with an AbortError) when the signal fires. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
