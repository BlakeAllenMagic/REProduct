// Settings the rep (or a later phase) may want to change, kept in one place.

// Vite fills in import.meta.env; plain Node (unit tests) has none.
const env = import.meta.env ?? {};

export const config = {
  // Where datasheet PDFs are downloaded from. A part's file is
  // `${datasheetBase}${sha256}.pdf`.
  //   npm run dev:    ./datasheets/ (the dev server serves dev-datasheets/)
  //   built app:      the datasheet Pages site, filled by the weekly sync job
  //   built-app tests: set VITE_DATASHEET_BASE to use a local copy
  datasheetBase:
    env.VITE_DATASHEET_BASE ??
    (env.DEV ? './datasheets/' : 'https://rf-datasheets.pages.dev/datasheets/'),

  // The app's data file, relative to the page.
  linecardUrl: './linecard.json',

  // ---------------------------------------------------------------------
  // "Send datasheet" email text. Edit freely.
  //
  // These words are replaced for each part:
  //   {mpn}           part number, e.g. ALM-1234
  //   {manufacturer}  e.g. Acme RF
  //   {description}   the description from the parts spreadsheet
  //   {datasheetUrl}  the manufacturer's link to the datasheet
  // Use \n for a new line. After editing, rebuild and publish the app.
  // ---------------------------------------------------------------------
  email: {
    subject: '{mpn} datasheet ({manufacturer})',

    // Used when the PDF itself is attached (Send datasheet).
    bodyWithAttachment:
      'Hello,\n\nAs discussed, attached is the datasheet for the {manufacturer} {mpn} ({description}).\n\nBest regards,',

    // Used when only a link is sent (Email link, or a browser that can't attach files).
    bodyWithLink:
      'Hello,\n\nAs discussed, here is the datasheet for the {manufacturer} {mpn} ({description}):\n{datasheetUrl}\n\nBest regards,',

    // Added under "Best regards," in every email. For example:
    // 'Jane Smith\nSmith RF Sales\n+1 555 0100'
    signature: '',
  },
};
