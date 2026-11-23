// Email text for "Send datasheet": fills the templates in src/config.js and
// builds mailto links. Pure functions, no browser APIs, so they're unit tested.

/** Replace {name} placeholders. Unknown ones are left as-is so typos show up. */
export function fillTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.hasOwn(values, key) ? String(values[key] ?? '') : match,
  );
}

function valuesFor(part) {
  return {
    mpn: part.mpn,
    manufacturer: part.manufacturer,
    description: part.description || part.mpn,
    datasheetUrl: part.datasheet?.sourceUrl ?? '',
  };
}

function withSignature(body, signature) {
  return signature ? `${body}\n${signature}` : body;
}

/**
 * { subject, text } for one part.
 * kind: 'attachment' (the PDF is attached) or 'link' (only a link).
 */
export function emailFor(part, email, kind) {
  const values = valuesFor(part);
  const body = kind === 'attachment' ? email.bodyWithAttachment : email.bodyWithLink;
  return {
    subject: fillTemplate(email.subject, values),
    text: withSignature(fillTemplate(body, values), email.signature),
  };
}

/**
 * A mailto: link that opens a new, prefilled email (no recipient: the rep
 * fills that in). Line breaks become CRLF, as the mailto standard asks.
 */
export function mailtoUrl({ subject, text }) {
  const body = text.replace(/\r?\n/g, '\r\n');
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** "Acme RF ALM-1234 datasheet.pdf", safe as a file name on every system. */
export function datasheetFileName(part) {
  const name = `${part.manufacturer} ${part.mpn} datasheet`
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${name || 'datasheet'}.pdf`;
}
