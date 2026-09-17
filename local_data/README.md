# Partmaster local data

This directory is intentionally excluded from Git.

- Put large `.csv`, `.tsv`, or `.txt` source files in `inbox/`.
- The local service stores imported tables in `partmaster.duckdb`.
- Filtered exports are written to `exports/`.
- Optional vehicle-mapping reference CSVs are stored in `reference/`.

The raw imported table is the source of truth. Indexing promotes normalized
identity, part type/category, price/MSRP, fitment, and product facts into the
master layers, but it keeps the original source row as `Raw Record JSON` and
keeps the original source files unchanged. The master export contains only
verified canonical identities; source traceability and one-row-per-fitment
exports retain the supporting raw values.

To extract the local ePID workbook into vehicle reference tables:

```sh
npm run vehicle:mapping:extract
```

This reads `local_data/inbox/Vehicle Mapping ePID.xlsx` and creates
`vehicle_master.csv`, `vehicle_source_aliases.csv`, and
`vehicle_mapping_validation.json`. The extractor validates both workbook tabs:
the wide VCDB/ARI/NADA crosswalk supplies canonical vehicles, while the
MPSOV Source tab supplies the row-wise lookup aliases. The local service also
refreshes these files automatically when the workbook is newer, and the Local
Data screen has a **Validate / reload mapping** action that reloads both tabs
and backfills existing applications when safe.

Do not remove the DuckDB file while Partmaster is running.
Run `npm run dev:local` from the repository root to start both the local data
service and the React application.
