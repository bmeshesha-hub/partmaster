import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const inputPath = process.argv[2] || "public/data/master-catalog.json";
const outputDirectory = process.argv[3] || "public/data";
const chunkDirectory = join(outputDirectory, "master-catalog-chunks");
const chunkSize = 20000;
const payload = JSON.parse(await readFile(inputPath, "utf8"));
const rows = Array.isArray(payload.rows) ? payload.rows : [];

await mkdir(chunkDirectory, { recursive: true });
const chunks = [];
for (let offset = 0; offset < rows.length; offset += chunkSize) {
  const filename = `master-catalog-${String(chunks.length).padStart(3, "0")}.json`;
  await writeFile(join(chunkDirectory, filename), JSON.stringify({ rows: rows.slice(offset, offset + chunkSize) }));
  chunks.push(`data/master-catalog-chunks/${filename}`);
}
await writeFile(join(outputDirectory, "master-catalog-index.json"), JSON.stringify({
  generated_at: payload.generated_at || new Date().toISOString(),
  filters: payload.filters || { manufacturers: [], families: [] },
  summary: payload.summary || { unique_parts: rows.length, parts_with_facts: 0 },
  chunks,
}));
console.log(`Split ${rows.length.toLocaleString()} rows into ${chunks.length} chunks.`);
