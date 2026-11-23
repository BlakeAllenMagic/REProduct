// Unit tests for the "Send datasheet" email text and mailto links.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import { datasheetFileName, emailFor, fillTemplate, mailtoUrl } from '../src/share/message.js';

const part = {
  mpn: 'ALM-1234',
  manufacturer: 'Acme RF',
  description: '0.5 to 6 GHz LNA, 0.6 dB NF',
  datasheet: { sourceUrl: 'https://manufacturer.example/ALM-1234.pdf' },
};

test('fillTemplate replaces known placeholders and keeps unknown ones visible', () => {
  assert.equal(fillTemplate('{mpn} by {manufacturer}', part), 'ALM-1234 by Acme RF');
  assert.equal(fillTemplate('{mpm}', part), '{mpm}');
});

test('attachment email mentions the attachment, link email carries the link', () => {
  const attached = emailFor(part, config.email, 'attachment');
  assert.equal(attached.subject, 'ALM-1234 datasheet (Acme RF)');
  assert.match(attached.text, /attached is the datasheet for the Acme RF ALM-1234/);
  assert.doesNotMatch(attached.text, /https:/);

  const link = emailFor(part, config.email, 'link');
  assert.match(link.text, /https:\/\/manufacturer\.example\/ALM-1234\.pdf/);
  assert.doesNotMatch(link.text, /\{/);
});

test('signature is added when set', () => {
  const email = { ...config.email, signature: 'Jane Smith\nSmith RF Sales' };
  assert.match(emailFor(part, email, 'attachment').text, /Best regards,\nJane Smith\nSmith RF Sales$/);
});

test('mailto link encodes special characters and uses CRLF line breaks', () => {
  const url = mailtoUrl({ subject: 'A&B #1 Größe', text: 'line one\nline two?x=1&y=2' });
  assert.ok(url.startsWith('mailto:?subject='));
  const params = new URLSearchParams(url.slice('mailto:?'.length));
  assert.equal(params.get('subject'), 'A&B #1 Größe');
  assert.equal(params.get('body'), 'line one\r\nline two?x=1&y=2');
  assert.doesNotMatch(url, /[ \n#]/); // nothing that would break the link
});

test('file names are safe on every system', () => {
  assert.equal(datasheetFileName(part), 'Acme RF ALM-1234 datasheet.pdf');
  assert.equal(
    datasheetFileName({ manufacturer: 'X/Y Corp', mpn: 'AB:12*"?' }),
    'X-Y Corp AB-12--- datasheet.pdf',
  );
});
