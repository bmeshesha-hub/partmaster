import { DuckDBInstance } from "@duckdb/node-api";
import express from "express";
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const APP_ROOT = resolve(import.meta.dirname, "..");
const DATA_ROOT = join(APP_ROOT, "local_data");
const INBOX_ROOT = join(DATA_ROOT, "inbox");
const EXPORT_ROOT = join(DATA_ROOT, "exports");
const DATABASE_PATH = join(DATA_ROOT, "partmaster.duckdb");
const PORT = Number(process.env.PARTMASTER_DATA_PORT || 8787);
const importJobs = new Map();

await Promise.all([
  mkdir(INBOX_ROOT, { recursive: true }),
  mkdir(EXPORT_ROOT, { recursive: true }),
]);

const instance = await DuckDBInstance.create(DATABASE_PATH, {
  threads: String(Math.max(2, Math.min(8, Number(process.env.PARTMASTER_THREADS) || 4))),
  memory_limit: process.env.PARTMASTER_MEMORY_LIMIT || "4GB",
});

async function withConnection(callback) {
  const connection = await instance.connect();
  try {
    await connection.run("SET preserve_insertion_order = false");
    return await callback(connection);
  } finally {
    connection.closeSync();
  }
}

await withConnection((connection) => connection.run(`
  CREATE TABLE IF NOT EXISTS partmaster_datasets (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    table_name VARCHAR NOT NULL UNIQUE,
    source_file VARCHAR NOT NULL,
    source_bytes BIGINT NOT NULL,
    row_count BIGINT NOT NULL,
    imported_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  )
`));

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function quoteString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function safeInboxFile(filename) {
  const cleanName = basename(String(filename || ""));
  if (!cleanName || cleanName !== filename) throw new Error("Choose a file from the Partmaster inbox.");
  const extension = extname(cleanName).toLowerCase();
  if (![".csv", ".tsv", ".txt"].includes(extension)) throw new Error("Only CSV, TSV, and text files can be imported.");
  return join(INBOX_ROOT, cleanName);
}

async function detectDelimiter(filePath) {
  const file = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
    const tabs = (firstLine.match(/\t/g) || []).length;
    const commas = (firstLine.match(/,/g) || []).length;
    return tabs > commas ? "\t" : ",";
  } finally {
    await file.close();
  }
}

async function getDataset(connection, id) {
  const reader = await connection.runAndReadAll(
    "SELECT * FROM partmaster_datasets WHERE id = $id",
    { id },
  );
  const dataset = reader.getRowObjectsJson()[0];
  if (!dataset) {
    const error = new Error("Dataset not found.");
    error.status = 404;
    throw error;
  }
  return dataset;
}

async function getColumns(connection, tableName) {
  const reader = await connection.runAndReadAll(`DESCRIBE ${quoteIdentifier(tableName)}`);
  return reader.getRowObjectsJson().map((column) => column.column_name);
}

function buildWhere(columns, input = {}) {
  const conditions = [];
  const values = {};
  const searchable = ["year", "brand", "model", "part_number", "category", "part_name", "msrp", "url", "epid", "source"].filter((column) => columns.includes(column));
  if (input.q && searchable.length) {
    conditions.push(`(${searchable.map((column) => `lower(coalesce(CAST(${quoteIdentifier(column)} AS VARCHAR), '')) LIKE $query`).join(" OR ")})`);
    values.query = `%${String(input.q).toLowerCase()}%`;
  }
  for (const column of ["year", "brand", "category"]) {
    if (input[column] && columns.includes(column)) {
      conditions.push(`${quoteIdentifier(column)} = $${column}`);
      values[column] = String(input[column]);
    }
  }
  return { clause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", values };
}

async function importDataset(jobId, options) {
  const job = importJobs.get(jobId);
  job.status = "importing";
  job.startedAt = new Date().toISOString();
  const sourcePath = safeInboxFile(options.filename);
  const fileStats = await stat(sourcePath);
  if (!fileStats.isFile()) throw new Error("The selected inbox item is not a file.");
  const delimiter = await detectDelimiter(sourcePath);
  const id = randomUUID();
  const tableName = `dataset_${id.replaceAll("-", "")}`;
  const displayName = String(options.name || options.filename.replace(/\.[^.]+$/, "")).trim();

  try {
    await withConnection(async (connection) => {
      const createImportedTable = (parallel) => connection.run(
        `CREATE TABLE ${quoteIdentifier(tableName)} AS
         SELECT row_number() OVER ()::BIGINT AS _row_id, *
         FROM read_csv($sourcePath,
           header = true,
           delim = ${quoteString(delimiter)},
           auto_detect = true,
           all_varchar = true,
           normalize_names = true,
           null_padding = true,
           parallel = ${parallel},
           strict_mode = false
         )`,
        { sourcePath },
      );
      try {
        await createImportedTable(true);
        job.readerMode = "parallel";
      } catch (error) {
        const requiresSingleThread = /Parallel CSV Reader.*does not support a full read|parallel\s*=\s*false/i.test(error.message);
        if (!requiresSingleThread) throw error;
        await connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
        job.readerMode = "single-threaded fallback";
        await createImportedTable(false);
      }
      // DuckDB prefixes SQL keywords such as Year and Source with an underscore
      // when normalizing headers. Restore the expected catalog field names so
      // filters and the UI remain consistent.
      const importedColumns = await getColumns(connection, tableName);
      for (const expected of ["year", "brand", "model", "part_number", "category", "part_name", "msrp", "quantity", "url", "epid", "source"]) {
        const prefixed = `_${expected}`;
        if (importedColumns.includes(prefixed) && !importedColumns.includes(expected)) {
          await connection.run(`ALTER TABLE ${quoteIdentifier(tableName)} RENAME COLUMN ${quoteIdentifier(prefixed)} TO ${quoteIdentifier(expected)}`);
        }
      }
      await connection.run(`CREATE INDEX ${quoteIdentifier(`${tableName}_row_id_idx`)} ON ${quoteIdentifier(tableName)} (_row_id)`);
      const countReader = await connection.runAndReadAll(`SELECT count(*) AS count FROM ${quoteIdentifier(tableName)}`);
      const rowCount = countReader.getRowObjectsJson()[0].count;
      await connection.run(
        `INSERT INTO partmaster_datasets (id, name, table_name, source_file, source_bytes, row_count)
         VALUES ($id, $name, $tableName, $sourceFile, $sourceBytes, $rowCount)`,
        {
          id,
          name: displayName || options.filename,
          tableName,
          sourceFile: options.filename,
          sourceBytes: fileStats.size,
          rowCount,
        },
      );
      job.datasetId = id;
      job.rowCount = rowCount;
    });
    job.status = "complete";
    job.completedAt = new Date().toISOString();
  } catch (error) {
    job.status = "failed";
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    try {
      await withConnection((connection) => connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`));
    } catch {
      // Preserve the original import error; a partial table is not registered.
    }
  }
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/local/health", (_request, response) => {
  response.json({ ok: true, dataRoot: DATA_ROOT, databasePath: DATABASE_PATH });
});

app.post("/api/local/open-folder", (_request, response) => {
  const child = spawn("open", [INBOX_ROOT], { detached: true, stdio: "ignore" });
  child.unref();
  response.json({ ok: true, path: INBOX_ROOT });
});

app.get("/api/local/files", asyncRoute(async (_request, response) => {
  const entries = await readdir(INBOX_ROOT, { withFileTypes: true });
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile() && [".csv", ".tsv", ".txt"].includes(extname(entry.name).toLowerCase()))
    .map(async (entry) => {
      const details = await stat(join(INBOX_ROOT, entry.name));
      return { name: entry.name, bytes: details.size, modifiedAt: details.mtime.toISOString() };
    }));
  files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  response.json({ files, inboxPath: INBOX_ROOT });
}));

app.get("/api/local/datasets", asyncRoute(async (_request, response) => {
  const datasets = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll("SELECT * FROM partmaster_datasets ORDER BY imported_at DESC");
    return reader.getRowObjectsJson();
  });
  response.json({ datasets, databasePath: DATABASE_PATH });
}));

app.post("/api/local/imports", asyncRoute(async (request, response) => {
  const filename = String(request.body.filename || "");
  const sourcePath = safeInboxFile(filename);
  await stat(sourcePath);
  if ([...importJobs.values()].some((job) => ["queued", "importing"].includes(job.status))) {
    return response.status(409).json({ error: "Another CSV import is already running." });
  }
  const jobId = randomUUID();
  importJobs.set(jobId, { id: jobId, filename, status: "queued", createdAt: new Date().toISOString() });
  setImmediate(() => importDataset(jobId, { filename, name: request.body.name }).catch((error) => {
    const job = importJobs.get(jobId);
    job.status = "failed";
    job.error = error.message;
  }));
  response.status(202).json({ job: importJobs.get(jobId) });
}));

app.get("/api/local/imports/:jobId", (request, response) => {
  const job = importJobs.get(request.params.jobId);
  if (!job) return response.status(404).json({ error: "Import job not found." });
  response.json({ job });
});

app.get("/api/local/datasets/:id/filters", asyncRoute(async (request, response) => {
  const filters = await withConnection(async (connection) => {
    const dataset = await getDataset(connection, request.params.id);
    const columns = await getColumns(connection, dataset.table_name);
    const output = {};
    for (const column of ["year", "brand", "category"]) {
      if (!columns.includes(column)) continue;
      const reader = await connection.runAndReadAll(`SELECT DISTINCT ${quoteIdentifier(column)} AS value FROM ${quoteIdentifier(dataset.table_name)} WHERE ${quoteIdentifier(column)} IS NOT NULL AND ${quoteIdentifier(column)} != '' ORDER BY value LIMIT 500`);
      output[column] = reader.getRowObjectsJson().map((row) => row.value);
    }
    return output;
  });
  response.json({ filters });
}));

app.get("/api/local/datasets/:id/rows", asyncRoute(async (request, response) => {
  const result = await withConnection(async (connection) => {
    const dataset = await getDataset(connection, request.params.id);
    const columns = await getColumns(connection, dataset.table_name);
    const pageSize = Math.max(10, Math.min(500, Number(request.query.pageSize) || 100));
    const page = Math.max(1, Number(request.query.page) || 1);
    const { clause, values } = buildWhere(columns, request.query);
    const requestedSort = String(request.query.sort || "_row_id");
    const sortColumn = columns.includes(requestedSort) ? requestedSort : "_row_id";
    const direction = request.query.direction === "desc" ? "DESC" : "ASC";
    const countReader = await connection.runAndReadAll(`SELECT count(*) AS count FROM ${quoteIdentifier(dataset.table_name)} ${clause}`, values);
    const rowsReader = await connection.runAndReadAll(
      `SELECT * FROM ${quoteIdentifier(dataset.table_name)} ${clause} ORDER BY ${quoteIdentifier(sortColumn)} ${direction} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      values,
    );
    return { dataset, columns, rows: rowsReader.getRowObjectsJson(), total: countReader.getRowObjectsJson()[0].count, page, pageSize };
  });
  response.json(result);
}));

app.patch("/api/local/datasets/:id/rows/:rowId", asyncRoute(async (request, response) => {
  await withConnection(async (connection) => {
    const dataset = await getDataset(connection, request.params.id);
    const columns = await getColumns(connection, dataset.table_name);
    const changes = Object.entries(request.body.changes || {}).filter(([column]) => column !== "_row_id" && columns.includes(column));
    if (!changes.length) throw new Error("No valid changes were supplied.");
    const values = { rowId: request.params.rowId };
    const assignments = changes.map(([column, value], index) => {
      const key = `value${index}`;
      values[key] = value === "" ? null : value;
      return `${quoteIdentifier(column)} = $${key}`;
    });
    await connection.run(`UPDATE ${quoteIdentifier(dataset.table_name)} SET ${assignments.join(", ")} WHERE _row_id = $rowId`, values);
  });
  response.json({ ok: true });
}));

app.delete("/api/local/datasets/:id/rows/:rowId", asyncRoute(async (request, response) => {
  await withConnection(async (connection) => {
    const dataset = await getDataset(connection, request.params.id);
    await connection.run(`DELETE FROM ${quoteIdentifier(dataset.table_name)} WHERE _row_id = $rowId`, { rowId: request.params.rowId });
    await connection.run("UPDATE partmaster_datasets SET row_count = row_count - 1 WHERE id = $id AND row_count > 0", { id: request.params.id });
  });
  response.json({ ok: true });
}));

app.post("/api/local/datasets/:id/exports", asyncRoute(async (request, response) => {
  const result = await withConnection(async (connection) => {
    const dataset = await getDataset(connection, request.params.id);
    const columns = await getColumns(connection, dataset.table_name);
    const { clause, values } = buildWhere(columns, request.body || {});
    const filename = `${dataset.name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "dataset"}-${Date.now()}.csv`;
    const outputPath = join(EXPORT_ROOT, filename);
    await connection.run(
      `COPY (SELECT * EXCLUDE (_row_id) FROM ${quoteIdentifier(dataset.table_name)} ${clause} ORDER BY _row_id) TO ${quoteString(outputPath)} (FORMAT CSV, HEADER true)`,
      values,
    );
    const outputStats = await stat(outputPath);
    return { filename, path: outputPath, bytes: outputStats.size };
  });
  response.json({ export: result });
}));

app.delete("/api/local/datasets/:id", asyncRoute(async (request, response) => {
  await withConnection(async (connection) => {
    const dataset = await getDataset(connection, request.params.id);
    await connection.run("BEGIN TRANSACTION");
    try {
      await connection.run(`DROP TABLE ${quoteIdentifier(dataset.table_name)}`);
      await connection.run("DELETE FROM partmaster_datasets WHERE id = $id", { id: request.params.id });
      await connection.run("COMMIT");
    } catch (error) {
      await connection.run("ROLLBACK");
      throw error;
    }
  });
  response.json({ ok: true, rawFilePreserved: true });
}));

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.status || 500).json({ error: error.message || "Local data service error." });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Partmaster local data service: http://127.0.0.1:${PORT}`);
  console.log(`Local data directory: ${DATA_ROOT}`);
});
