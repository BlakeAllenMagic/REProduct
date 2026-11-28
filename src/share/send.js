// "Send datasheet": share the PDF file through the device's share sheet, or
// fall back to an email with a link.
//
// The share sheet is the operating system's (Mail, Outlook, Messages,
// AirDrop...). The file goes to it straight from the device, so it works with
// no internet; the email itself goes out once there's a signal.
//
// Browsers only allow navigator.share() during a tap. Any `await` before it
// (reading the PDF from storage, for example) can use up the tap, and Safari
// then refuses with NotAllowedError. That's why the viewer builds the File
// as soon as the datasheet opens, and sendDatasheet() calls share() first
// thing.

import { config } from '../config.js';
import { datasheetFileName, emailFor, mailtoUrl, shortlistEmail } from './message.js';

/** Wrap the saved PDF as a File with a friendly name. */
export function makeDatasheetFile(part, blob) {
  return new File([blob], datasheetFileName(part), { type: 'application/pdf' });
}

/** Can this browser share this file through the share sheet? */
export function canShareFile(file) {
  try {
    return Boolean(file) && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/**
 * Call directly from a tap handler, with no await before it.
 * Resolves to 'shared', 'cancelled' (the rep closed the share sheet) or
 * 'link' (no file sharing, an email with a link was opened instead).
 * Rejects if the browser refuses or the share fails.
 */
export function sendDatasheet(part, file) {
  if (!canShareFile(file)) {
    emailLink(part);
    return Promise.resolve('link');
  }
  const { subject, text } = emailFor(part, config.email, 'attachment');
  return navigator.share({ files: [file], title: subject, text }).then(
    () => 'shared',
    (error) => {
      if (error?.name === 'AbortError') return 'cancelled'; // closed without sending: normal
      throw error;
    },
  );
}

/**
 * Open a new prefilled email with the manufacturer's link.
 * A link click (rather than changing the page's address) keeps the
 * installed app open on iPad while Mail opens.
 */
export function emailLink(part) {
  const link = document.createElement('a');
  link.href = mailtoUrl(emailFor(part, config.email, 'link'));
  link.click();
}

/** A human message for a failed share. */
export function describeShareError(error) {
  if (error?.name === 'NotAllowedError') {
    return 'The browser blocked the share sheet. Tap "Send datasheet" again, or use "Email link".';
  }
  return `${error instanceof Error ? error.message : String(error)}. You can use "Email link" instead.`;
}

/** Can this browser share these files together through the share sheet? */
export function canShareFiles(files) {
  try {
    return files.length > 0 && typeof navigator.canShare === 'function' && navigator.canShare({ files });
  } catch {
    return false;
  }
}

/**
 * The shortlist's "Send all": one share with every saved PDF attached and an
 * email text listing all the parts (links for those without a PDF here).
 * files: [{ part, file }] for the parts whose PDF is on this device.
 * Same rule as sendDatasheet(): call straight from a tap, no await before it.
 * Resolves to 'shared', 'cancelled' or 'link' (no file sharing: an email
 * with links was opened instead).
 */
export function sendShortlist(parts, files) {
  const list = files.map((f) => f.file);
  if (!canShareFiles(list)) {
    emailShortlistLinks(parts);
    return Promise.resolve('link');
  }
  const { subject, text } = shortlistEmail(parts, config.email, new Set(files.map((f) => f.part.id)));
  return navigator.share({ files: list, title: subject, text }).then(
    () => 'shared',
    (error) => {
      if (error?.name === 'AbortError') return 'cancelled';
      throw error;
    },
  );
}

/** A new prefilled email listing every shortlisted part with its link. */
export function emailShortlistLinks(parts) {
  const link = document.createElement('a');
  link.href = mailtoUrl(shortlistEmail(parts, config.email));
  link.click();
}
