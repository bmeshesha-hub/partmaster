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

Master Data includes a **Revalidate part numbers** action. It quarantines
placeholder, alpha-only, zero-only, and other non-OEM identity values while
preserving the original source rows. It separately flags extraction punctuation,
missing descriptions, and fallback classification for review. Availability,
canceled, and discontinued descriptions do not remove a valid part identity.
Future full source rebuilds apply the same identity validation before creating
master identities.

## Shared parts catalog

Master Data serves Partout Pro and other applications with reusable part
definitions. The **Parts catalog** view prioritizes identity, category, recorded
vehicle fitment, side/position, and specifications. Expand a part to inspect all
attributes, alternate numbers, directional replacement/interchange relationships,
and installation details. Search includes recorded vehicle models, confirmed
alternate numbers, and variant attributes.

The **Export for apps** download and **Export matching parts** use the same
catalog projection and eligibility rules. Rejected identities and non-product
records are excluded. Missing specifications do not exclude an otherwise usable
part. Price, condition, and stock for a particular item belong in seller listings.

- `GET /api/local/master-catalog` returns a page of product records with
  `attributes`, `fitments`, `additional_fitments`, `alternate_numbers`,
  `relationships`, and `unresolved_details` arrays. Each attribute has a `name`
  and `values` array; multiple distinct values require confirmation. Missing
  scalar fields are `null`, and missing collections are empty arrays.
- `POST /api/local/master-catalog/export` accepts the same search/filter fields
  and exports **all** matching parts, regardless of the current page. CSV columns
  ending in `JSON` contain those structured collections. Parse these columns as
  JSON instead of splitting them on commas or combining independent year/model
  lists. Fitment rows retain their trim, ePID, assembly, quantity, location notes,
  and required/excluded options together. Additional catalog fitments retain
  their recorded year, model, model code, and assembly without inventing options.
- The default sort is OEM number ascending. Filters include `q`, `manufacturer`,
  `family`, `fitmentStatus` (`present`/`missing`), `factStatus`
  (`with_facts`/`missing_facts`), and `descriptionStatus` (`present`/`missing`).
  `page` and `pageSize` control API pagination.
- Add `view=audit` to the GET query, or `"view": "audit"` to the export body,
  to include internal provenance and quality fields. The UI exposes these in
  **Data quality**. Existing callers that used top-level collection counts or
  processing scores should read the GET response's `audit` object instead.
  The legacy FPA download retains its existing schema for current integrations.

Recorded fitment and a mapped vehicle reference are not guarantees of universal
compatibility. Consumers must retain restrictions, unresolved details, and
relationship conditions. A missing option or specification is unknown; it must
not be treated as a confirmed absence. No new part facts are invented by the UI.

Run `node --test server/masterCatalog.test.mjs` for catalog query and CSV
round-trip checks, plus `npm run lint` and `npm run build` for application checks.

Everything inside `local_data/` except the small directory instructions and
placeholder files is ignored by Git. The GitHub Pages build includes the UI,
but the local-data screen can only connect when the Mac service is running.

### Publishing the finished master catalog

After enrichment has finished, stop the local worker cleanly so DuckDB
checkpoints its WAL, then run:

```bash
npm run publish:master
git add public/data/master-catalog.json
git commit -m "Publish enriched master catalog"
git push
```

The command writes a read-only catalog snapshot for GitHub Pages. Raw CSVs,
DuckDB, source-page cache, jobs, and evidence-review internals remain in
`local_data/` and are never uploaded. Pages supports catalog search, filters,
paging, fitments, specifications, aliases, and relationships; enrichment,
revalidation, and CSV exports remain local-only.

After enrichment and review are complete, the one-command portal update is:

```bash
npm run publish:portal
```

It publishes the catalog, commits only the GitHub Pages snapshot chunks, and
pushes them to the `public-backup` remote. It stops without committing or
pushing if the local database cannot be opened.

### Google Drive snapshots

Google Drive can be used as the shared archive for approved exports without
becoming a dependency of the app. Copy `.env.example` to `.env` and set
`PARTMASTER_DRIVE_MASTERDATA_DIR` to the local Google Drive `Masterdata/exports`
folder. `npm run publish:master` will then write both:

- `master-catalog-<timestamp>.json`, an immutable dated snapshot; and
- `master-catalog-latest.json`, the current approved snapshot.

The app and GitHub Pages continue to read `public/data/master-catalog.json`, so
Drive sync outages or an incomplete upload cannot break catalog browsing. If
desired, set `VITE_GOOGLE_DRIVE_MASTERDATA_URL` to the Drive share link for the
latest approved export; the Master Data export screen will show a link to it.
Share only the exported snapshot, never the working database or raw-data
folder. Keep `local_data/partmaster.duckdb` on local disk. For GitHub Pages,
the publisher also creates `public/data/master-catalog-index.json` and smaller
files under `public/data/master-catalog-chunks/`; commit those files with the
app so the portal can serve the large catalog without exceeding GitHub's
single-file limit. The app transparently loads the chunks and retains the
search, filters, expandable details, fitments, and specifications.

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

### Scheduled enrichment

Open **Settings → Scheduler & jobs** in the local app to start an ad-hoc online
enrichment job, schedule one future run, or create a recurring daily run. The
schedule, last result, and next run time are stored in the local DuckDB database.
Daily schedules create at most one pipeline job at a time and automatically
advance to the next day after starting. If the service was closed at the due
time, the overdue job starts after `npm run dev:local` is opened again.

The Mac must remain awake and `npm run dev:local` must keep running. A daily
limit of 10,000 source pages is the recommended starting point; the UI also
supports a selected CSV source and an explicit all-remaining mode.

For row-based work, **Settings → Scheduler & jobs → Resumable row batches**
creates a persistent schedule for all imported CSV sources (or a selected CSV
when needed). Set the rows per batch and the interval (for example, 1,000 rows every 20 minutes). The Dashboard and
Enrichment pages show total rows, completed rows, rows still open, queued/in-
progress rows, the next run, and a Resume action for paused or failed batches.
The schedule advances from the last saved source-row checkpoint and disables
itself when no further processable candidates remain.

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
