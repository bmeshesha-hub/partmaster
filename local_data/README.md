# Partmaster local data

This directory is intentionally excluded from Git.

- Put large `.csv`, `.tsv`, or `.txt` source files in `inbox/`.
- The local service stores imported tables in `partmaster.duckdb`.
- Filtered exports are written to `exports/`.

Do not remove the DuckDB file while Partmaster is running.
Run `npm run dev:local` from the repository root to start both the local data
service and the React application.
