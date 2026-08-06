# Partmaster

Partmaster is a static React dashboard for researching, normalizing, and
reviewing OEM parts data stored in the sibling `partmaster_data` GitHub
repository. It reads and writes JSON using the authenticated GitHub API, so
there is no conventional backend or database.

The **Dashboard** combines `input.json`, `queue.json`, `approved.json`, and
`analyses.json` into progress metrics for waiting, pending, and completed work.
The **Library** combines approved variants and finalized analysis batches into
one searchable table. Filters apply to the on-screen records and to the CSV
export, making it possible to download only the current result set.

The **Analyze parts** workflow has three stages:

1. Import a CSV/text file or paste messy OCR data and select a catalog scope.
2. Copy the generated automotive-research prompt to GPT, then paste its answer
   back into Partmaster.
3. Review/edit the normalized results, export a four-column CSV, or save the
   analysis to `data/analyses.json` in `partmaster_data`.

The separate **Review** workflow continues to handle records in `queue.json`
and moves human-approved variants to `approved.json`.

## Large local datasets

The **Local data** workspace is designed for CSV/TSV files that are far too
large for GitHub or browser memory (including 10 GB catalogs). It uses DuckDB
on the Mac and sends only one filtered page of rows to React at a time.

1. Start the local web app and data service together with `npm run dev:local`.
2. Open `http://127.0.0.1:5173/partmaster/` and choose **Local data**.
3. Click **Open in Finder** and copy the large file into `local_data/inbox/`.
4. Refresh the inbox, select the file, and start the import.

The service automatically distinguishes comma-separated and tab-separated
headers, preserves catalog fields as text, and stores imported tables in
`local_data/partmaster.duckdb`. Search, filters, paging, edits, row deletion,
and filtered CSV exports run against that local database. Exports are written
to `local_data/exports/`.

Everything inside `local_data/` except the small directory instructions and
placeholder files is ignored by Git. The GitHub Pages build includes the UI,
but the local-data screen can only connect when the Mac service is running.

## Local development

1. Copy `.env.example` to `.env` and adjust the repository values if needed.
2. Run `npm install`.
3. Run `npm run dev:local` for the complete app, including large local data.
4. In Settings, add a fine-grained GitHub PAT with **Contents: Read and write**
   access to `partmaster_data`.

The PAT is saved in browser localStorage. This is appropriate only for a trusted
internal deployment: treat the static site and every dependency as security
sensitive, keep the token repository-scoped, and clear it on shared machines.

## GitHub Pages

In repository settings, set Pages **Source** to **GitHub Actions**. The included
workflow builds and publishes the `dist` artifact whenever `main` changes.

## Data consistency

An approval reads `queue.json` and `approved.json` at one branch commit, captures
both file SHAs, and writes both files in one new Git commit. A non-forced branch
update rejects a stale approval if another reviewer changed the data first.
