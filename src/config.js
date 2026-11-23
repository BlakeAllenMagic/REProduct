// Settings the rep (or a later phase) may want to change, kept in one place.

export const config = {
  // Where datasheet PDFs are fetched from. A part's file is
  // `${datasheetBase}${sha256}.pdf`. In development the Vite server maps
  // /datasheets/ to the dev-datasheets/ folder. Phase 4 points this at R2.
  datasheetBase: './datasheets/',

  // The app's data file, relative to the page.
  linecardUrl: './linecard.json',
};
