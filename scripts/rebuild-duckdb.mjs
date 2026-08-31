import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

const sourcePath = process.env.PARTMASTER_SOURCE_DB || "local_data/partmaster.duckdb";
const targetPath = process.env.PARTMASTER_TARGET_DB || "local_data/partmaster.rebuilt.duckdb";
const staging = process.env.PARTMASTER_REBUILD_STAGING || "local_data/rebuild_tables";

const source = await DuckDBInstance.create(sourcePath, { access_mode: "READ_ONLY", threads: "1", memory_limit: process.env.PARTMASTER_REBUILD_MEMORY || "4GB" });
const target = await DuckDBInstance.create(targetPath, { threads: "1", memory_limit: process.env.PARTMASTER_REBUILD_MEMORY || "4GB" });
const read = await source.connect();
const write = await target.connect();
await mkdir(staging, { recursive: true });
await write.run("SET preserve_insertion_order=false");

const tableResult = await read.runAndReadAll(`
  SELECT table_schema, table_name
  FROM information_schema.tables
  WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('information_schema', 'pg_catalog')
  ORDER BY table_schema, table_name
`);
const tables = tableResult.getRowObjectsJson();
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const fileQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;

for (let index = 0; index < tables.length; index += 1) {
  const table = tables[index];
  const qualified = `${quote(table.table_schema)}.${quote(table.table_name)}`;
  const file = join(staging, `${index}.parquet`);
  const fileSql = fileQuote(file);
  console.log(`[${index + 1}/${tables.length}] exporting ${table.table_schema}.${table.table_name}`);
  // HTTP evidence cache is disposable and can be rebuilt on demand. It is
  // also the only oversized table that cannot be copied within the memory
  // budget, so intentionally omit it from the durable-data rebuild.
  if (table.table_name === "partmaster_page_cache") continue;
  const existing = await write.runAndReadAll(`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = ${fileQuote(table.table_schema)} AND table_name = ${fileQuote(table.table_name)}`);
  if (Number(existing.getRowObjectsJson()[0]?.n || 0)) continue;
  try {
    await read.run(`COPY ${qualified} TO ${fileSql} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    await write.run(`CREATE TABLE ${qualified} AS SELECT * FROM read_parquet(${fileSql})`);
  } catch (error) {
    console.log(`  large table; retrying in 25,000-row chunks: ${error.message.split("\\n")[0]}`);
    const count = Number((await read.runAndReadAll(`SELECT count(*) AS n FROM ${qualified}`)).getRowObjectsJson()[0]?.n || 0);
    for (let offset = 0; offset < count; offset += 25000) {
      const chunkFile = join(staging, `${index}-${offset}.parquet`);
      const chunkSql = fileQuote(chunkFile);
      await read.run(`COPY (SELECT * FROM ${qualified} LIMIT 25000 OFFSET ${offset}) TO ${chunkSql} (FORMAT PARQUET, COMPRESSION ZSTD)`);
      if (offset === 0) await write.run(`CREATE TABLE ${qualified} AS SELECT * FROM read_parquet(${chunkSql})`);
      else await write.run(`INSERT INTO ${qualified} SELECT * FROM read_parquet(${chunkSql})`);
    }
  }
}

await write.run("CHECKPOINT");
console.log(`REBUILD COMPLETE: ${targetPath}`);
read.closeSync();
write.closeSync();
