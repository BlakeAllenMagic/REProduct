# Parts list: don't edit these files

The parts list lives in the **Google Sheet** (one tab per product type).
These CSV files are an automatic copy of it, written by `tools/import_sheet.py`
every time the sheet changes. Any edit made here is overwritten by the next import.

To change parts, edit the Google Sheet. To add a new product type (a new tab),
`data/categories.yaml` needs a new category first.
