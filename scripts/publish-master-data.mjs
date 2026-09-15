import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { DuckDBInstance } from "@duckdb/node-api";
import { catalogPart, catalogQuery } from "../server/masterCatalog.js";
import { basename, dirname, join } from "node:path";

// Publish only the finished, consumer-safe catalog. Raw files, evidence cache,
// jobs, and the DuckDB database stay local and are never copied to public/.
const databasePath = process.env.PARTMASTER_DATABASE_PATH || "local_data/partmaster.duckdb";
const outputPath = process.env.PARTMASTER_MASTER_OUTPUT || "public/data/master-catalog.json";
const driveOutputDirectory = process.env.PARTMASTER_DRIVE_MASTERDATA_DIR || "";
const publicDataDirectory = dirname(outputPath);
const chunkDirectory = join(publicDataDirectory, "master-catalog-chunks");
const chunkSize = 20000;
const instance = await DuckDBInstance.create(databasePath, { access_mode: "READ_ONLY", threads: "1", memory_limit: process.env.PARTMASTER_PUBLISH_MEMORY || "2GB" });
const connection = await instance.connect();

const rows = [];
const batchSize = 25000;
const total = Number((await connection.runAndReadAll(`SELECT count(*) AS count FROM (${catalogQuery({}, "")}) catalog`)).getRowObjectsJson()[0]?.count || 0);
for (let offset = 0; offset < total; offset += batchSize) {
  const query = catalogQuery({ sort: "part_number", direction: "asc" }, `LIMIT ${batchSize} OFFSET ${offset}`);
  const batch = (await connection.runAndReadAll(query)).getRowObjectsJson();
  rows.push(...batch.map((row) => catalogPart(row)));
  console.log(`Published ${Math.min(offset + batch.length, total).toLocaleString()} / ${total.toLocaleString()} parts`);
}
const manufacturers = [...new Set(rows.map((row) => row.manufacturer).filter(Boolean))].sort();
const families = [...new Set(rows.map((row) => row.family_name || "Unclassified"))].sort();
const payload = {
  generated_at: new Date().toISOString(),
  rows,
  filters: { manufacturers, families },
  summary: { unique_parts: rows.length, parts_with_facts: rows.filter((row) => row.attributes.length).length },
};

await mkdir(publicDataDirectory, { recursive: true });
await writeFile(outputPath, JSON.stringify(payload));
console.log(`Published ${rows.length.toLocaleString()} master parts to ${outputPath}`);

// GitHub rejects individual files over 100 MB. Keep the compatibility file
// for local/Drive use, and publish smaller static chunks for GitHub Pages.
await mkdir(chunkDirectory, { recursive: true });
const chunks = [];
for (let offset = 0; offset < rows.length; offset += chunkSize) {
  const filename = `master-catalog-${String(chunks.length).padStart(3, "0")}.json`;
  await writeFile(join(chunkDirectory, filename), JSON.stringify({ rows: rows.slice(offset, offset + chunkSize) }));
  chunks.push(`data/master-catalog-chunks/${filename}`);
}
await writeFile(join(publicDataDirectory, "master-catalog-index.json"), JSON.stringify({
  generated_at: payload.generated_at,
  filters: payload.filters,
  summary: payload.summary,
  chunks,
}));
console.log(`Published ${chunks.length} GitHub Pages catalog chunks (${chunkSize.toLocaleString()} rows each)`);

// Google Drive is an optional archive/distribution target. The app continues
// to use the repository snapshot even when Drive is unavailable or offline.
if (driveOutputDirectory) {
  await mkdir(driveOutputDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const datedPath = `${driveOutputDirectory}/master-catalog-${stamp}.json`;
  const latestPath = `${driveOutputDirectory}/master-catalog-latest.json`;
  await copyFile(outputPath, datedPath);
  await copyFile(outputPath, latestPath);
  console.log(`Archived Drive snapshot at ${datedPath}`);
  console.log(`Updated Drive latest snapshot at ${latestPath}`);
}
connection.closeSync();
instance.closeSync();
