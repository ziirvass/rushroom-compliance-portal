# Migrate the document library into Supabase (one-time)

This moves the 13 library documents out of Google Drive and into your Supabase
`documents` bucket, then repoints the portal's library at the in-house copies —
so the portal no longer depends on Google Drive for documents.

It streams each file straight from Drive to Supabase. Google Docs become `.docx`
and Google Sheets become `.xlsx` (still editable off Google); the PDF copies as-is.

## Before you run
1. **Supabase is set up** — you've created the project and run `../supabase/schema.sql`
   (so the `documents` table and `documents` bucket exist). See `../SUPABASE_SETUP.md`.
2. **Share the source files** — each Google file must be **Anyone with the link →
   Viewer** so the export download works. (Sharing for *download* only; the portal
   itself serves them privately via signed links afterwards.) The script names any
   file it can't fetch so you can share it and re-run.
3. **Node 18+**.

## Run
```bash
cd migration
npm install
SUPABASE_URL="https://<your-ref>.supabase.co" \
SUPABASE_SERVICE_KEY="<service-role key — Project Settings → API → service_role>" \
node migrate-docs.mjs
```

You'll see a `✓` per file. Re-running is safe — it upserts the files and replaces
the matching library rows (so the Drive-linked seed rows are swapped for the
in-house copies).

> The **service-role key** is highly privileged — run this locally, don't commit it,
> and don't paste it anywhere public. It's only needed for this one migration.

## After
Open the portal as Rushroom → **Documents** — the items now open from Supabase
(signed links), and Google Drive is no longer in the path. You can add or delete
documents from the **Manage documents** panel from here on.
