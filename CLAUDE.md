# CLAUDE.md: RF Line Card App

## What this is

An offline-first web app (PWA) that a manufacturer's sales rep uses during customer visits to present his line card. The rep firm focuses on RF front-end components.

**Core flow:**

1. The rep opens an interactive RF block diagram (receiver chain to start).
2. He taps a block, for example the LNA.
3. A table shows every line card part in that category with its key specs.
4. He taps a part, and its datasheet opens inside the app.
5. He taps "Send datasheet," and the PDF goes to the customer by email.

All of this must work with no internet connection. When the device is online, the app quietly checks for updated datasheets and downloads only the ones that changed.

## Users and context

- **Primary user:** one sales rep (the firm owner), often in secure customer facilities with no Wi-Fi or cell signal.
- **Audience:** customer engineers looking over his shoulder. It has to look professional and respond quickly.
- **Scale:** about 500 parts eventually. Plan for 500 to 1,000 parts and roughly 1.5 to 3 GB of datasheets.
- **Redistribution:** the rep has permission to redistribute every datasheet. Bundling and emailing PDFs is allowed.

## Target platforms (in priority order)

1. iPad, Safari, installed to the Home Screen (iPadOS 18 or newer)
2. Mac, Safari "Add to Dock" (macOS Sonoma or newer, with Safari 18 or newer); Chrome on Mac is a secondary option

The Safari 18 baseline comes from PDF.js, whose FAQ lists its legacy build as supporting Safari 18 and newer.

Do not add Android or Windows workarounds yet. Use standard web APIs so those platforms can be added later.

## Testing devices

- **Day to day:** no iPad or Mac is available for development, so testing happens on Windows in Chrome or Edge, plus automated tap-flow tests (`npm run test:e2e`) that run in Chromium and in WebKit, the engine inside Safari. Playwright runs WebKit on Windows too.
- **Windows is a test bench, not a target platform.** Never write code that only exists to make Windows work. If something works on Windows but would behave differently on an iPad, say so.
- **What Windows can't show:** Safari's pinch gesture events, Home Screen app storage, iOS storage limits and eviction, iPad canvas memory limits, and sharing from an installed iPad app. These are covered by the Apple device check below, which must pass on a real iPad (borrowed, or a cloud device service) before the rep relies on the app.

## Non-negotiables

- **Offline first.** Every feature in the core flow works in airplane mode once datasheets are downloaded. Network access is an enhancement and never a requirement.
- **No server at runtime.** The app is static files. The only "backend" is a scheduled build job (see Datasheet update pipeline).
- **Minimal dependencies.** Vanilla JS with ES modules, plain CSS, and an SVG diagram. Vite is allowed as the dev server and bundler. Do not use a UI framework unless I approve one. PDF.js is the only expected runtime library.
- **Never lose downloaded data.** A failed update must not delete or corrupt datasheets that are already cached.
- **Touch first.** Tap targets are at least 44x44 pt, nothing depends on hover, and it works in both portrait and landscape on iPad.

## Architecture

### Data source of truth

- `data/categories.yaml` defines each category: id, display name, which diagram blocks map to it, and its spec columns (key, label, unit, sort direction, number or text).
- `data/parts/<category>.csv` has one CSV per category, because each category has different spec columns. The rep can edit these in Numbers or Excel.
- `tools/build_linecard.py` validates the CSVs against `categories.yaml` and generates `public/linecard.json`. Validation fails loudly on unknown columns, missing required fields, duplicate part numbers, or bad units.

### linecard.json (generated, never hand-edited)

```json
{
  "dataVersion": "2026-11-18T14:00:00Z",
  "categories": [
    {
      "id": "lna",
      "name": "Low Noise Amplifiers",
      "specs": [
        { "key": "freq_min_ghz", "label": "Freq Min", "unit": "GHz", "type": "number" },
        { "key": "nf_db", "label": "NF", "unit": "dB", "type": "number", "sort": "asc" }
      ]
    }
  ],
  "parts": [
    {
      "id": "acme-alm1234",
      "category": "lna",
      "manufacturer": "Acme RF",
      "mpn": "ALM-1234",
      "description": "0.5 to 6 GHz LNA, 0.6 dB NF",
      "specs": { "freq_min_ghz": 0.5, "nf_db": 0.6 },
      "datasheet": {
        "sourceUrl": "https://manufacturer.example/ALM-1234.pdf",
        "file": "datasheets/<sha256>.pdf",
        "sha256": "<hex>",
        "bytes": 2483112,
        "updated": "2026-10-02"
      }
    }
  ]
}
```

Datasheet files are content addressed: the filename is the SHA-256 of the PDF. When a datasheet changes, its URL changes. Cached files never go stale, and the app finds updates by comparing hash sets.

### Block diagram

- A hand-built SVG in `src/diagram/receiver.svg`. Each clickable block has `data-block="<block id>"`.
- `categories.yaml` decides which category each block opens, through each category's `blocks` list. The SVG holds no category ids, so remapping a block never means editing the drawing.
- A category can appear in more than one block (for example, amplifiers at RF and IF).
- Each block shows a part count badge, and blocks with zero parts look visibly disabled.
- Later: transmitter and transceiver diagrams that use the same mechanism.

## Offline strategy (most important section)

Use two separate caches with different lifecycles:

- **App shell cache (`shell-v<N>`):** HTML, CSS, JS, the SVG, icons, the PDF.js build, and `linecard.json`. It is precached in the service worker install event. It stays small, under 10 MB.
- **Datasheet cache (`datasheets`, not versioned):** PDFs keyed by their content-addressed URL. It is filled by an in-app download manager, never by the service worker install event. If one file fails during precache, the whole install fails, and with 1.5 GB that is guaranteed to happen.

**Download manager requirements:**

- "Download all" and "Download this category" buttons
- Concurrency of 3, retries with backoff, resumable. On restart it skips hashes that are already cached.
- Progress UI showing files done, total, and MB, plus a clear error list
- Before a large download, call `navigator.storage.estimate()` and warn if there isn't enough room
- After the first successful download, call `navigator.storage.persist()`
- Show storage used and a "last synced" timestamp on a Settings screen

**Update flow when online:**

1. Fetch `linecard.json` network-first, falling back to the cached copy.
2. Compare its datasheet hashes with what's in the datasheet cache.
3. Queue only new or changed hashes. Delete orphaned hashes only after the new files are cached successfully.
4. Mark parts whose datasheet changed in the last 30 days with an "Updated" badge.

**Service worker routing:**

- App shell: cache-first
- `linecard.json`: network-first with a cache fallback and a short timeout of about 3 seconds, so a weak signal doesn't hang the app
- `datasheets/*`: cache-first, with network fallback only when online

**iOS notes:**

- Safari has no install prompt. Show a one-time "Share, then Add to Home Screen" instruction when the app isn't running in standalone mode.
- Home Screen web apps get their own storage, separate from Safari. Datasheets must be downloaded inside the installed app, not in a Safari tab.

## PDF viewing

- Use a locally vendored PDF.js (`pdfjs-dist`) build, included in the app shell, so viewing works offline and looks the same on iPad and Mac. Do not rely on opening blob URLs in a new tab, because that behaves inconsistently in iOS standalone mode.
- Read the PDF from the datasheet cache, render with PDF.js, and support pinch zoom and page navigation.
- If a datasheet isn't downloaded yet, show "Not downloaded." Offer to download it when online, or show the manufacturer link when offline.

## Send datasheet (email)

- **Primary:** `navigator.share({ files: [pdfFile], title, text })`, guarded by `navigator.canShare({ files })`. This works in iPad and Mac Safari and attaches the actual PDF through Mail or any other app.
- **Gotcha:** sharing requires a recent user gesture. Build the `File` object when the part is selected, not after the button tap, so the share call runs right away.
- **Fallback:** a `mailto:` link with the subject, part number, a short message, and the manufacturer's datasheet URL. mailto links cannot attach files.
- The default message text lives in one config file so the rep can edit it.

## Datasheet update pipeline (build time, not in the app)

- `tools/sync_datasheets.py` is run on a schedule by a GitHub Action, weekly by default, with manual dispatch also allowed.
- For each part, download `sourceUrl`, compute its SHA-256, and upload to storage under `datasheets/<sha256>.pdf` if that file is new.
- Write the new hash, size, and date into the build data, then regenerate `linecard.json` and bump `dataVersion`.
- Some manufacturer sites block scripts or require a login. Log those failures, keep the previous version, and list them in a summary report. Never fail the whole run because of one part.
- Send a real browser User-Agent, rate limit requests, and check that each response is actually a PDF (magic bytes `%PDF`) and not an HTML error page.
- Browsers can't fetch manufacturer PDFs directly because of CORS. That is why this happens at build time.

## Hosting

- **App:** Cloudflare Pages, free tier
- **Datasheets:** Cloudflare R2 bucket on a custom subdomain, with CORS allowing the app's origin
- Do not commit PDFs to git. 1.5 GB or more doesn't belong in a repo. Keep `datasheets/` in `.gitignore`. For local development, use a small sample set in `dev-datasheets/`.

## Project structure

```
/
├── CLAUDE.md
├── data/
│   ├── categories.yaml
│   └── parts/*.csv
├── tools/
│   ├── build_linecard.py
│   └── sync_datasheets.py
├── public/
│   ├── manifest.webmanifest
│   ├── icons/
│   └── linecard.json        (generated)
├── src/
│   ├── main.js
│   ├── sw.js                (service worker)
│   ├── diagram/
│   ├── views/               (diagram, parts table, viewer, settings)
│   ├── offline/             (download manager, cache helpers, storage)
│   ├── share/
│   └── styles/
├── vendor/pdfjs/
└── dev-datasheets/          (small sample set, about 5 PDFs)
```

## Build phases

Do one phase at a time, and don't start the next until the current one's "done when" passes. "Done when" is checked on Windows (see Testing devices); the Apple device check is separate and must pass before the rep uses the app.

| Phase | Scope | Done when |
|---|---|---|
| 0 | Schema, `categories.yaml`, 3 categories (LNA, mixer, filter) with 3 to 5 sample parts each, `build_linecard.py` | `linecard.json` builds and validation catches a deliberately broken CSV |
| 1 | SVG diagram, parts table, PDF.js viewer, local sample PDFs | Full tap flow works in Chrome or Edge on Windows, and the tap-flow tests pass in Chromium and WebKit |
| 2 | Manifest, service worker, app shell cache, download manager, Settings screen | Installed from Chrome or Edge on Windows, all sample PDFs downloaded, full flow works offline after closing and reopening the app |
| 3 | Send datasheet (Web Share plus mailto fallback) | On Windows, the share sheet attaches the PDF while offline, and the mailto fallback opens a prefilled email |
| 4 | `sync_datasheets.py`, GitHub Action, R2 upload, in-app update flow | Changing a sample PDF upstream leads to exactly one re-download on the test device |
| 5 | Search by part number, sort and filter, compare, branding, more diagrams | As agreed per feature |

**Current phase: 3**

## Coding conventions

- ES modules and modern JS (Safari 18 baseline), no transpiling unless needed.
- Small, single-purpose modules. Keep service worker logic in `sw.js` and cache helpers in `src/offline/`.
- All async errors are caught and shown in the UI, never swallowed silently.
- Python tools use the standard library first. If a third-party package is needed, list it in `tools/requirements.txt`. Use type hints and argparse.
- No secrets in the repo. R2 credentials come from GitHub Action secrets only.

## Testing checklist (run before calling a phase done)

- [ ] `npm test` and `npm run test:e2e` pass (Chromium and WebKit)
- [ ] Chrome or Edge dev tools: service worker is active and the caches contain what's expected
- [ ] Network set to Offline, then a hard reload: app still loads
- [ ] Installed from Chrome or Edge on Windows, offline, app closed and reopened: full flow works
- [ ] Interrupt a "Download all" halfway, then resume: no duplicate files and no corrupted files
- [ ] Simulate a storage quota error: the app shows a clear message and doesn't crash
- [ ] Dev tools device emulation, iPad size, portrait and landscape: layout works and tap targets are big enough

## Apple device check (real iPad, before the rep relies on the app)

- [ ] Safari tab: full tap flow, pinch zoom on a datasheet
- [ ] Installed to the Home Screen, datasheets downloaded inside the installed app
- [ ] Airplane mode, force-quit, reopen: full flow works
- [ ] Send datasheet while offline composes an email with the PDF attached
- [ ] In Mail, the share's title shows up as the email subject (if not, note it; the rep types a subject)
- [ ] Portrait and landscape layouts
- [ ] A long real datasheet (50+ pages): scroll through it, no blank pages
- [ ] Mac Safari (if available): Add to Dock, same flow, trackpad pinch

## How to work with me

- I want to understand and own this code. Explain the reasoning behind design choices, especially for service workers, caching, and storage.
- Start every phase in plan mode. Propose the approach and file changes, and wait for my approval.
- Make small, reviewable changes. After each step, tell me how to test it.
- If a requirement here conflicts with what I ask for in a prompt, point out the conflict instead of quietly choosing one.
- If you're unsure about a browser API's support in Safari, say so and suggest a quick test rather than guessing.

## Out of scope for now

- User accounts, login, or multiple reps
- Analytics or tracking of customer views
- Native App Store apps
- Android or Windows specific work
- Editing parts inside the app (the CSVs are the source of truth)
