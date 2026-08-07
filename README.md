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

## Local enrichment worker

The **Enrichment** workspace creates persistent, resumable jobs in DuckDB. A
job takes a bounded set of deduplicated part-application candidates from an imported dataset,
normalizes manufacturer and OEM numbers, checks each public source URL, and
extracts product evidence from structured page metadata. Source pages are cached
for seven days, so parts from the same diagram reuse one online request instead
of downloading the page for every row. High-confidence exact matches are
promoted automatically; missing, conflicting, blocked, and weaker results stay
in an evidence-review queue.

Approved records are stored at two levels:

- `partmaster_canonical_parts`: one row per manufacturer and normalized OEM
  part number.
- `partmaster_part_applications`: vehicle, assembly, item number, side,
  position, quantity, required/excluded option codes, fitment explanation, and
  source relationships for each part.
- `partmaster_part_families` and `partmaster_variant_attributes`: groups related
  parts while preserving differences such as heated, auto-dimming, power-fold,
  memory, blind-spot, camera, turn signal, connector pins, and component scope.
- `partmaster_part_relationships`: explicit supersession and interchange rules,
  including conditional and not-interchangeable relationships.
- `partmaster_part_compatibility`: the expanded year, model, model-code, and
  assembly list from OEM “where used” pages. These rows reference one canonical
  part instead of duplicating the part for every compatible vehicle.

The evidence-review screen supports checkbox-based bulk approval, compares a
candidate with existing variants in its family, and makes unknown features
visible instead of assuming two similar part numbers are interchangeable. It
can fetch a supported compatibility page or import a pasted linked “Assemblies
where used” list when the supplier blocks automated access. Use **Export master
CSVs** to create part-master, application, compatibility, and relationship files in
`local_data/exports/`. The original imported rows are never overwritten.

Start with 1,000 candidates. The worker is deliberately conservative and
currently verifies the source URLs already present in imported catalogs; it
does not scrape general-purpose search-engine result pages. Configure memory,
threads, page-size, and fetch timeouts with the `PARTMASTER_*` values shown in
`.env.example`.

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
