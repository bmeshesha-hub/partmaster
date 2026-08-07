# Partmaster local data

This directory is intentionally excluded from Git.

- Put large `.csv`, `.tsv`, or `.txt` source files in `inbox/`.
- The local service stores imported tables in `partmaster.duckdb`.
- Filtered exports are written to `exports/`.
- Optional vehicle-mapping reference CSVs are stored in `reference/`.

To extract the local ePID workbook into vehicle reference tables:

```sh
npm run vehicle:mapping:extract
```

This reads `local_data/inbox/Vehicle Mapping ePID.xlsx` and creates
`vehicle_master.csv` plus `vehicle_source_aliases.csv`. Restart the local
service afterward so Partmaster reloads the references.

Do not remove the DuckDB file while Partmaster is running.
Run `npm run dev:local` from the repository root to start both the local data
service and the React application.
