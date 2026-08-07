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
const DATABASE_PATH = resolve(process.env.PARTMASTER_DATABASE_PATH || join(DATA_ROOT, "partmaster.duckdb"));
const PORT = Number(process.env.PARTMASTER_DATA_PORT || 8787);
const importJobs = new Map();
const activeEnrichmentJobs = new Set();
let shuttingDown = false;
const ENRICHMENT_FETCH_TIMEOUT_MS = Math.max(3000, Number(process.env.PARTMASTER_FETCH_TIMEOUT_MS) || 15000);
const ENRICHMENT_MAX_PAGE_BYTES = Math.max(100000, Number(process.env.PARTMASTER_MAX_PAGE_BYTES) || 2_000_000);

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
  );

  CREATE TABLE IF NOT EXISTS partmaster_enrichment_jobs (
    id VARCHAR PRIMARY KEY,
    dataset_id VARCHAR NOT NULL,
    name VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    batch_size INTEGER NOT NULL,
    start_row_id BIGINT NOT NULL DEFAULT 0,
    requested_candidates INTEGER NOT NULL,
    auto_accept_threshold DOUBLE NOT NULL,
    queued_count BIGINT NOT NULL DEFAULT 0,
    processed_count BIGINT NOT NULL DEFAULT 0,
    enriched_count BIGINT NOT NULL DEFAULT 0,
    review_count BIGINT NOT NULL DEFAULT 0,
    conflict_count BIGINT NOT NULL DEFAULT 0,
    not_found_count BIGINT NOT NULL DEFAULT 0,
    failed_count BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    last_error VARCHAR
  );

  CREATE TABLE IF NOT EXISTS partmaster_enrichment_candidates (
    id VARCHAR PRIMARY KEY,
    job_id VARCHAR NOT NULL,
    dataset_id VARCHAR NOT NULL,
    source_row_id BIGINT NOT NULL,
    manufacturer_raw VARCHAR,
    manufacturer_norm VARCHAR,
    year VARCHAR,
    model VARCHAR,
    assembly VARCHAR,
    item_number VARCHAR,
    part_number_raw VARCHAR,
    part_number_norm VARCHAR,
    description_raw VARCHAR,
    quantity VARCHAR,
    source_url VARCHAR,
    enriched_part_number VARCHAR,
    enriched_description VARCHAR,
    side VARCHAR,
    position VARCHAR,
    location_notes VARCHAR,
    evidence_url VARCHAR,
    evidence_title VARCHAR,
    confidence DOUBLE,
    status VARCHAR NOT NULL DEFAULT 'pending',
    decision VARCHAR,
    decision_notes VARCHAR,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    processed_at TIMESTAMP,
    reviewed_at TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS partmaster_canonical_parts (
    id VARCHAR PRIMARY KEY,
    manufacturer VARCHAR NOT NULL,
    manufacturer_norm VARCHAR NOT NULL,
    part_number VARCHAR NOT NULL,
    part_number_norm VARCHAR NOT NULL,
    description VARCHAR,
    confidence DOUBLE,
    verification_status VARCHAR NOT NULL,
    evidence_url VARCHAR,
    verified_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    UNIQUE (manufacturer_norm, part_number_norm)
  );

  CREATE TABLE IF NOT EXISTS partmaster_part_applications (
    id VARCHAR PRIMARY KEY,
    application_key VARCHAR NOT NULL UNIQUE,
    part_id VARCHAR NOT NULL,
    dataset_id VARCHAR NOT NULL,
    source_row_id BIGINT NOT NULL,
    year VARCHAR,
    model VARCHAR,
    assembly VARCHAR,
    item_number VARCHAR,
    side VARCHAR,
    position VARCHAR,
    location_notes VARCHAR,
    quantity VARCHAR,
    source_url VARCHAR,
    evidence_url VARCHAR,
    confidence DOUBLE,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    UNIQUE (part_id, dataset_id, source_row_id)
  );

  CREATE INDEX IF NOT EXISTS enrichment_candidates_job_status_idx
    ON partmaster_enrichment_candidates (job_id, status);
  CREATE INDEX IF NOT EXISTS canonical_parts_lookup_idx
    ON partmaster_canonical_parts (manufacturer_norm, part_number_norm);
  CREATE INDEX IF NOT EXISTS part_applications_part_idx
    ON partmaster_part_applications (part_id)
`));

await withConnection((connection) => connection.run(`
  ALTER TABLE partmaster_enrichment_jobs ADD COLUMN IF NOT EXISTS start_row_id BIGINT DEFAULT 0;
  ALTER TABLE partmaster_part_applications ADD COLUMN IF NOT EXISTS application_key VARCHAR;
  CREATE UNIQUE INDEX IF NOT EXISTS part_applications_key_idx
    ON partmaster_part_applications (application_key)
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

function firstColumnExpression(columns, names) {
  const available = names.filter((name) => columns.includes(name));
  if (!available.length) return "NULL::VARCHAR";
  return `coalesce(${available.map((name) => `nullif(trim(CAST(${quoteIdentifier(name)} AS VARCHAR)), '')`).join(", ")})`;
}

function normalizeManufacturer(value) {
  const cleaned = String(value || "").trim().replace(/\s+/g, " ");
  const key = cleaned.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const aliases = {
    HARVEYDAVISON: "Harley-Davidson",
    HARLEYDAVISON: "Harley-Davidson",
    HARLEYDAVIDSON: "Harley-Davidson",
    BMW: "BMW",
    HONDA: "Honda",
    KTM: "KTM",
    KAWASAKI: "Kawasaki",
  };
  return aliases[key] || cleaned;
}

function normalizePartNumber(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeApplicationValue(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function cleanText(value) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function inferLocation(...values) {
  const text = values.filter(Boolean).join(" | ");
  const upper = text.toUpperCase();
  let side = "Unknown";
  if (/\b(LEFT|LH|L\/H)\b/.test(upper)) side = "Left";
  else if (/\b(RIGHT|RH|R\/H)\b/.test(upper)) side = "Right";
  else if (/\b(UNIVERSAL|BOTH SIDES|LH\s*&\s*RH|LEFT\s*&\s*RIGHT)\b/.test(upper)) side = "Universal";
  else if (/\b(CENTER|CENTRE)\b/.test(upper)) side = "Center";

  const numbered = text.match(/\b(?:position|pos(?:ition)?\.?|item)\s*#?\s*(\d+[A-Z]?)\b/i);
  let position = numbered ? `Position ${numbered[1]}` : "";
  if (!position) {
    const qualifiers = ["Front", "Rear", "Upper", "Lower", "Inner", "Outer"]
      .filter((term) => new RegExp(`\\b${term}\\b`, "i").test(text));
    position = qualifiers.join(" ");
  }
  return { side, position };
}

function walkJson(value, callback) {
  if (!value || typeof value !== "object") return;
  callback(value);
  if (Array.isArray(value)) value.forEach((item) => walkJson(item, callback));
  else Object.values(value).forEach((item) => walkJson(item, callback));
}

function extractPageEvidence(html, knownPartNumber) {
  const products = [];
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1]);
      walkJson(parsed, (item) => {
        const type = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
        if (type.some((entry) => String(entry || "").toLowerCase() === "product")) products.push(item);
      });
    } catch {
      // Invalid JSON-LD is common; the title and visible text still provide evidence.
    }
  }
  const titleMatch = html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = cleanText(titleMatch?.[1] || "").slice(0, 500);
  const knownNorm = normalizePartNumber(knownPartNumber);
  const product = products.find((item) => {
    const numbers = [item.mpn, item.sku, item.productID].map(normalizePartNumber).filter(Boolean);
    return knownNorm ? numbers.includes(knownNorm) : numbers.length;
  });
  const productNumber = String(product?.mpn || product?.sku || product?.productID || "").trim();
  const description = cleanText(product?.name || product?.description || "").slice(0, 1000);
  const visibleText = cleanText(html).slice(0, ENRICHMENT_MAX_PAGE_BYTES);
  const exactNumberFound = Boolean(knownNorm && normalizePartNumber(visibleText).includes(knownNorm));
  const structuredExact = Boolean(knownNorm && [product?.mpn, product?.sku, product?.productID].map(normalizePartNumber).includes(knownNorm));
  return { title, productNumber, description, exactNumberFound, structuredExact, hasProductData: Boolean(product) };
}

function pageTitleMatchesContext(candidate, title) {
  const normalizedTitle = normalizeApplicationValue(title);
  if (!normalizedTitle) return false;
  const required = [candidate.manufacturer_raw, candidate.year]
    .map(normalizeApplicationValue)
    .filter(Boolean);
  const contextual = [candidate.model, candidate.assembly]
    .map(normalizeApplicationValue)
    .filter((value) => value.length >= 4);
  return required.every((value) => normalizedTitle.includes(value))
    && (!contextual.length || contextual.some((value) => normalizedTitle.includes(value)));
}

function isSafeEvidenceUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "::1" || host.endsWith(".local")) return false;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
    const private172 = host.match(/^172\.(\d+)\./);
    return !(private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31);
  } catch {
    return false;
  }
}

async function fetchEvidence(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENRICHMENT_FETCH_TIMEOUT_MS);
  try {
    let currentUrl = url;
    let response;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      if (!isSafeEvidenceUrl(currentUrl)) throw new Error("The source URL is not a permitted public HTTP address.");
      response = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "PartmasterLocalEnrichment/1.0 (+local catalog verification)",
        },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) throw new Error("Source returned an invalid redirect.");
      currentUrl = new URL(location, currentUrl).toString();
      if (redirects === 5) throw new Error("Source returned too many redirects.");
    }
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
    const type = response.headers.get("content-type") || "";
    if (!type.includes("text/html") && !type.includes("application/xhtml+xml")) throw new Error("Source did not return an HTML page.");
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > ENRICHMENT_MAX_PAGE_BYTES) throw new Error("Source page is larger than the configured evidence limit.");
    const html = (await response.text()).slice(0, ENRICHMENT_MAX_PAGE_BYTES);
    return { html, finalUrl: response.url || currentUrl };
  } finally {
    clearTimeout(timeout);
  }
}

async function promoteCandidate(connection, candidate, verificationStatus) {
  const partNumber = candidate.enriched_part_number || candidate.part_number_raw;
  const partNumberNorm = normalizePartNumber(partNumber);
  if (!partNumberNorm || !candidate.manufacturer_norm) return null;
  const existingReader = await connection.runAndReadAll(
    `SELECT id, confidence FROM partmaster_canonical_parts
     WHERE manufacturer_norm = $manufacturer AND part_number_norm = $partNumber`,
    { manufacturer: candidate.manufacturer_norm, partNumber: partNumberNorm },
  );
  let partId = existingReader.getRowObjectsJson()[0]?.id;
  if (!partId) {
    partId = randomUUID();
    await connection.run(
      `INSERT INTO partmaster_canonical_parts
       (id, manufacturer, manufacturer_norm, part_number, part_number_norm, description, confidence, verification_status, evidence_url, verified_at)
       VALUES ($id, $manufacturer, $manufacturerNorm, $partNumber, $partNumberNorm, $description, $confidence, $status, $evidenceUrl, current_timestamp)`,
      {
        id: partId,
        manufacturer: candidate.manufacturer_raw || candidate.manufacturer_norm,
        manufacturerNorm: candidate.manufacturer_norm,
        partNumber,
        partNumberNorm,
        description: candidate.enriched_description || candidate.description_raw || null,
        confidence: candidate.confidence || 0,
        status: verificationStatus,
        evidenceUrl: candidate.evidence_url || candidate.source_url || null,
      },
    );
  } else {
    await connection.run(
      `UPDATE partmaster_canonical_parts SET
         description = CASE WHEN $confidence >= coalesce(confidence, 0) THEN coalesce($description, description) ELSE description END,
         confidence = greatest(coalesce(confidence, 0), $confidence),
         verification_status = CASE WHEN $confidence >= coalesce(confidence, 0) THEN $status ELSE verification_status END,
         evidence_url = CASE WHEN $confidence >= coalesce(confidence, 0) THEN coalesce($evidenceUrl, evidence_url) ELSE evidence_url END,
         verified_at = current_timestamp,
         updated_at = current_timestamp
       WHERE id = $id`,
      {
        id: partId,
        confidence: candidate.confidence || 0,
        description: candidate.enriched_description || candidate.description_raw || null,
        status: verificationStatus,
        evidenceUrl: candidate.evidence_url || candidate.source_url || null,
      },
    );
  }

  const applicationKey = [
    partId,
    candidate.year,
    candidate.model,
    candidate.assembly,
    candidate.item_number,
    candidate.side,
    candidate.position,
  ].map(normalizeApplicationValue).join(":");
  const applicationReader = await connection.runAndReadAll(
    "SELECT id FROM partmaster_part_applications WHERE application_key = $applicationKey",
    { applicationKey },
  );
  const applicationId = applicationReader.getRowObjectsJson()[0]?.id;
  const applicationValues = {
    id: applicationId || randomUUID(),
    applicationKey,
    partId,
    datasetId: candidate.dataset_id,
    sourceRowId: candidate.source_row_id,
    year: candidate.year || null,
    model: candidate.model || null,
    assembly: candidate.assembly || null,
    itemNumber: candidate.item_number || null,
    side: candidate.side || "Unknown",
    position: candidate.position || null,
    locationNotes: candidate.location_notes || null,
    quantity: candidate.quantity || null,
    sourceUrl: candidate.source_url || null,
    evidenceUrl: candidate.evidence_url || null,
    confidence: candidate.confidence || 0,
  };
  if (applicationId) {
    await connection.run(
      `UPDATE partmaster_part_applications SET
       year = $year, model = $model, assembly = $assembly, item_number = $itemNumber,
       side = $side, position = $position, location_notes = $locationNotes, quantity = $quantity,
       source_url = $sourceUrl, evidence_url = $evidenceUrl, confidence = $confidence,
       updated_at = current_timestamp WHERE id = $id`,
      applicationValues,
    );
  } else {
    await connection.run(
      `INSERT INTO partmaster_part_applications
       (id, application_key, part_id, dataset_id, source_row_id, year, model, assembly, item_number, side, position,
        location_notes, quantity, source_url, evidence_url, confidence)
       VALUES ($id, $applicationKey, $partId, $datasetId, $sourceRowId, $year, $model, $assembly, $itemNumber, $side,
        $position, $locationNotes, $quantity, $sourceUrl, $evidenceUrl, $confidence)`,
      applicationValues,
    );
  }
  return partId;
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

async function refreshEnrichmentJobStats(connection, jobId) {
  const reader = await connection.runAndReadAll(
    `SELECT
       count(*) AS queued_count,
       count(*) FILTER (WHERE status NOT IN ('pending', 'processing')) AS processed_count,
       count(*) FILTER (WHERE status = 'enriched') AS enriched_count,
       count(*) FILTER (WHERE status = 'needs_review') AS review_count,
       count(*) FILTER (WHERE status = 'conflict') AS conflict_count,
       count(*) FILTER (WHERE status = 'not_found') AS not_found_count,
       count(*) FILTER (WHERE status = 'failed') AS failed_count,
       count(*) FILTER (WHERE status IN ('pending', 'processing')) AS remaining_count
     FROM partmaster_enrichment_candidates WHERE job_id = $jobId`,
    { jobId },
  );
  const stats = reader.getRowObjectsJson()[0];
  await connection.run(
    `UPDATE partmaster_enrichment_jobs SET
       queued_count = $queued, processed_count = $processed, enriched_count = $enriched,
       review_count = $review, conflict_count = $conflict, not_found_count = $notFound,
       failed_count = $failed
     WHERE id = $jobId`,
    {
      jobId,
      queued: stats.queued_count,
      processed: stats.processed_count,
      enriched: stats.enriched_count,
      review: stats.review_count,
      conflict: stats.conflict_count,
      notFound: stats.not_found_count,
      failed: stats.failed_count,
    },
  );
  return stats;
}

async function createEnrichmentJob(options) {
  return withConnection(async (connection) => {
    const dataset = await getDataset(connection, options.datasetId);
    const columns = await getColumns(connection, dataset.table_name);
    const requestedCandidates = Math.max(1, Math.min(10000, Number(options.requestedCandidates) || 1000));
    const startRowId = Math.max(0, Number(options.startRowId) || 0);
    const batchSize = Math.max(1, Math.min(50, Number(options.batchSize) || 10));
    const threshold = Math.max(0.8, Math.min(1, Number(options.autoAcceptThreshold) || 0.94));
    const jobId = randomUUID();
    const manufacturer = firstColumnExpression(columns, ["brand", "make", "manufacturer"]);
    const year = firstColumnExpression(columns, ["year"]);
    const model = firstColumnExpression(columns, ["model", "model_name"]);
    const assembly = firstColumnExpression(columns, ["category", "part_category", "assembly_category", "diagram_title"]);
    const itemNumber = firstColumnExpression(columns, ["pos", "item_number", "reference_number"]);
    const partNumber = firstColumnExpression(columns, ["part_number", "code", "oem_part_number"]);
    const description = firstColumnExpression(columns, ["part_name", "description"]);
    const quantity = firstColumnExpression(columns, ["quantity", "qty", "quatity"]);
    const sourceUrl = firstColumnExpression(columns, ["url", "source_url"]);
    const scanLimit = Math.min(500000, Math.max(requestedCandidates * 30, requestedCandidates));
    const query = `
      WITH source_rows AS (
        SELECT
          _row_id AS source_row_id,
          ${manufacturer} AS manufacturer_raw,
          ${year} AS year,
          ${model} AS model,
          ${assembly} AS assembly,
          ${itemNumber} AS item_number,
          ${partNumber} AS part_number_raw,
          ${description} AS description_raw,
          ${quantity} AS quantity,
          ${sourceUrl} AS source_url
        FROM ${quoteIdentifier(dataset.table_name)} source
        WHERE _row_id > $startRowId
          AND (${partNumber} IS NOT NULL OR ${description} IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM partmaster_enrichment_candidates prior
            WHERE prior.dataset_id = $datasetId AND prior.source_row_id = source._row_id
          )
        ORDER BY _row_id
        LIMIT ${scanLimit}
      ), keyed AS (
        SELECT *,
          CASE WHEN part_number_raw IS NOT NULL
            THEN upper(regexp_replace(
              coalesce(manufacturer_raw, '') || ':' || part_number_raw || ':' || coalesce(year, '') || ':' ||
              coalesce(model, '') || ':' || coalesce(assembly, '') || ':' || coalesce(item_number, ''),
              '[^A-Za-z0-9]', '', 'g'))
            ELSE upper(regexp_replace(coalesce(manufacturer_raw, '') || ':' || coalesce(assembly, '') || ':' || coalesce(item_number, '') || ':' || coalesce(description_raw, ''), '[^A-Za-z0-9]', '', 'g'))
          END AS candidate_key
        FROM source_rows
      )
      SELECT * EXCLUDE (candidate_key) FROM keyed
      QUALIFY row_number() OVER (PARTITION BY candidate_key ORDER BY source_row_id) = 1
      ORDER BY source_row_id
      LIMIT ${requestedCandidates}
    `;
    const reader = await connection.runAndReadAll(query, { startRowId, datasetId: dataset.id });
    const candidates = reader.getRowObjectsJson();
    await connection.run("BEGIN TRANSACTION");
    try {
      await connection.run(
        `INSERT INTO partmaster_enrichment_jobs
         (id, dataset_id, name, status, batch_size, start_row_id, requested_candidates, auto_accept_threshold, queued_count)
         VALUES ($id, $datasetId, $name, $status, $batchSize, $startRowId, $requested, $threshold, $queued)`,
        {
          id: jobId,
          datasetId: dataset.id,
          name: String(options.name || `${dataset.name} enrichment`).trim().slice(0, 200),
          status: candidates.length ? "queued" : "completed",
          batchSize,
          startRowId,
          requested: requestedCandidates,
          threshold,
          queued: candidates.length,
        },
      );
      for (const candidate of candidates) {
        const manufacturerNorm = normalizeManufacturer(candidate.manufacturer_raw);
        await connection.run(
          `INSERT INTO partmaster_enrichment_candidates
           (id, job_id, dataset_id, source_row_id, manufacturer_raw, manufacturer_norm, year, model,
            assembly, item_number, part_number_raw, part_number_norm, description_raw, quantity, source_url)
           VALUES ($id, $jobId, $datasetId, $sourceRowId, $manufacturerRaw, $manufacturerNorm, $year, $model,
            $assembly, $itemNumber, $partNumberRaw, $partNumberNorm, $descriptionRaw, $quantity, $sourceUrl)`,
          {
            id: randomUUID(),
            jobId,
            datasetId: dataset.id,
            sourceRowId: candidate.source_row_id,
            manufacturerRaw: candidate.manufacturer_raw || null,
            manufacturerNorm: manufacturerNorm || null,
            year: candidate.year || null,
            model: candidate.model || null,
            assembly: candidate.assembly || null,
            itemNumber: candidate.item_number || null,
            partNumberRaw: candidate.part_number_raw || null,
            partNumberNorm: normalizePartNumber(candidate.part_number_raw) || null,
            descriptionRaw: candidate.description_raw || null,
            quantity: candidate.quantity || null,
            sourceUrl: candidate.source_url || null,
          },
        );
      }
      await connection.run("COMMIT");
    } catch (error) {
      await connection.run("ROLLBACK");
      throw error;
    }
    return { id: jobId, candidateCount: candidates.length };
  });
}

async function processEnrichmentCandidate(candidate, threshold) {
  const localLocation = inferLocation(candidate.description_raw, candidate.assembly, candidate.item_number);
  let update = {
    enrichedPartNumber: candidate.part_number_raw || null,
    enrichedDescription: candidate.description_raw || null,
    side: localLocation.side,
    position: localLocation.position || (candidate.item_number ? `Position ${candidate.item_number}` : null),
    locationNotes: candidate.assembly || null,
    evidenceUrl: candidate.source_url || null,
    evidenceTitle: null,
    confidence: candidate.part_number_norm && candidate.description_raw ? 0.6 : 0.35,
    status: "needs_review",
    decision: null,
  };

  if (!candidate.source_url) {
    if (!candidate.part_number_norm) update.status = "not_found";
    return update;
  }

  const { html, finalUrl } = await fetchEvidence(candidate.source_url);
  const evidence = extractPageEvidence(html, candidate.part_number_raw);
  const evidenceLocation = inferLocation(evidence.description, evidence.title);
  update = {
    ...update,
    enrichedPartNumber: candidate.part_number_raw || evidence.productNumber || null,
    enrichedDescription: evidence.description || candidate.description_raw || null,
    side: evidenceLocation.side !== "Unknown" ? evidenceLocation.side : localLocation.side,
    position: evidenceLocation.position || localLocation.position || (candidate.item_number ? `Position ${candidate.item_number}` : null),
    evidenceUrl: finalUrl,
    evidenceTitle: evidence.title || null,
  };

  const onlinePartNorm = normalizePartNumber(evidence.productNumber);
  if (candidate.part_number_norm && onlinePartNorm && onlinePartNorm !== candidate.part_number_norm) {
    update.confidence = 0.2;
    update.status = "conflict";
    update.decision = "Online structured part number conflicts with the source record.";
    return update;
  }
  if (localLocation.side !== "Unknown" && evidenceLocation.side !== "Unknown"
    && localLocation.side !== evidenceLocation.side && evidenceLocation.side !== "Universal") {
    update.confidence = 0.2;
    update.status = "conflict";
    update.decision = `Source side (${localLocation.side}) conflicts with online evidence (${evidenceLocation.side}).`;
    return update;
  }
  if (candidate.part_number_norm && evidence.structuredExact) update.confidence = 0.98;
  else if (candidate.part_number_norm && evidence.exactNumberFound && pageTitleMatchesContext(candidate, evidence.title)) update.confidence = 0.96;
  else if (candidate.part_number_norm && evidence.exactNumberFound) update.confidence = 0.9;
  else if (!candidate.part_number_norm && onlinePartNorm && evidence.hasProductData) update.confidence = 0.86;
  else if (!candidate.part_number_norm) update.status = "not_found";

  if (localLocation.side !== "Unknown" && evidenceLocation.side === "Unknown") {
    update.confidence = Math.min(update.confidence, 0.88);
    update.decision = "The source supplies a side, but the online evidence does not confirm it.";
  }

  if (update.status !== "not_found") {
    update.status = update.confidence >= threshold && Boolean(normalizePartNumber(update.enrichedPartNumber)) ? "enriched" : "needs_review";
  }
  return update;
}

async function runEnrichmentJob(jobId) {
  if (activeEnrichmentJobs.has(jobId)) return;
  activeEnrichmentJobs.add(jobId);
  try {
    await withConnection((connection) => connection.run(
      `UPDATE partmaster_enrichment_jobs SET status = 'running', started_at = coalesce(started_at, current_timestamp), last_error = NULL
       WHERE id = $jobId AND status IN ('queued', 'running')`,
      { jobId },
    ));
    while (true) {
      if (shuttingDown) break;
      const state = await withConnection(async (connection) => {
        const jobReader = await connection.runAndReadAll("SELECT * FROM partmaster_enrichment_jobs WHERE id = $jobId", { jobId });
        const job = jobReader.getRowObjectsJson()[0];
        if (!job || job.status !== "running") return { done: true };
        const candidateReader = await connection.runAndReadAll(
          `SELECT * FROM partmaster_enrichment_candidates
           WHERE job_id = $jobId AND status = 'pending'
           ORDER BY source_row_id LIMIT ${Math.max(1, Math.min(50, Number(job.batch_size) || 10))}`,
          { jobId },
        );
        return { job, candidates: candidateReader.getRowObjectsJson() };
      });
      if (state.done) break;
      if (!state.candidates.length) {
        await withConnection(async (connection) => {
          const stats = await refreshEnrichmentJobStats(connection, jobId);
          if (Number(stats.remaining_count) === 0) {
            await connection.run(
              "UPDATE partmaster_enrichment_jobs SET status = 'completed', completed_at = current_timestamp WHERE id = $jobId",
              { jobId },
            );
          }
        });
        break;
      }

      for (const candidate of state.candidates) {
        const stillRunning = await withConnection(async (connection) => {
          const reader = await connection.runAndReadAll("SELECT status FROM partmaster_enrichment_jobs WHERE id = $jobId", { jobId });
          return reader.getRowObjectsJson()[0]?.status === "running";
        });
        if (!stillRunning) break;
        await withConnection((connection) => connection.run(
          "UPDATE partmaster_enrichment_candidates SET status = 'processing', attempts = attempts + 1 WHERE id = $id AND status = 'pending'",
          { id: candidate.id },
        ));
        try {
          const result = await processEnrichmentCandidate(candidate, Number(state.job.auto_accept_threshold));
          await withConnection(async (connection) => {
            await connection.run(
              `UPDATE partmaster_enrichment_candidates SET
               enriched_part_number = $partNumber, enriched_description = $description,
               side = $side, position = $position, location_notes = $locationNotes,
               evidence_url = $evidenceUrl, evidence_title = $evidenceTitle,
               confidence = $confidence, status = $status, decision_notes = $decision,
               processed_at = current_timestamp
               WHERE id = $id`,
              {
                id: candidate.id,
                partNumber: result.enrichedPartNumber,
                description: result.enrichedDescription,
                side: result.side,
                position: result.position,
                locationNotes: result.locationNotes,
                evidenceUrl: result.evidenceUrl,
                evidenceTitle: result.evidenceTitle,
                confidence: result.confidence,
                status: result.status,
                decision: result.decision,
              },
            );
            if (result.status === "enriched") {
              await promoteCandidate(connection, { ...candidate, ...{
                enriched_part_number: result.enrichedPartNumber,
                enriched_description: result.enrichedDescription,
                side: result.side,
                position: result.position,
                location_notes: result.locationNotes,
                evidence_url: result.evidenceUrl,
                confidence: result.confidence,
              } }, "online_verified");
            }
          });
        } catch (error) {
          const status = candidate.attempts >= 2 ? "failed" : "needs_review";
          await withConnection((connection) => connection.run(
            `UPDATE partmaster_enrichment_candidates SET status = $status, decision_notes = $error,
             confidence = coalesce(confidence, 0), processed_at = current_timestamp WHERE id = $id`,
            { id: candidate.id, status, error: error.message },
          ));
        }
      }
      await withConnection((connection) => refreshEnrichmentJobStats(connection, jobId));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    }
  } catch (error) {
    await withConnection((connection) => connection.run(
      "UPDATE partmaster_enrichment_jobs SET status = 'failed', last_error = $error, completed_at = current_timestamp WHERE id = $jobId",
      { jobId, error: error.message },
    )).catch(() => {});
  } finally {
    activeEnrichmentJobs.delete(jobId);
  }
}

function scheduleEnrichmentJob(jobId) {
  setImmediate(() => runEnrichmentJob(jobId));
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

app.get("/api/local/enrichment/jobs", asyncRoute(async (_request, response) => {
  const jobs = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      `SELECT jobs.*, datasets.name AS dataset_name,
       (SELECT max(candidate.source_row_id) FROM partmaster_enrichment_candidates candidate WHERE candidate.job_id = jobs.id) AS last_source_row_id
       FROM partmaster_enrichment_jobs jobs
       LEFT JOIN partmaster_datasets datasets ON datasets.id = jobs.dataset_id
       ORDER BY jobs.created_at DESC LIMIT 100`,
    );
    return reader.getRowObjectsJson();
  });
  response.json({ jobs });
}));

app.post("/api/local/enrichment/jobs", asyncRoute(async (request, response) => {
  if ([...importJobs.values()].some((job) => ["queued", "importing"].includes(job.status))) {
    return response.status(409).json({ error: "Wait for the active CSV import to finish before starting enrichment." });
  }
  const result = await createEnrichmentJob({
    datasetId: String(request.body.datasetId || ""),
    name: request.body.name,
    requestedCandidates: request.body.requestedCandidates,
    startRowId: request.body.startRowId,
    batchSize: request.body.batchSize,
    autoAcceptThreshold: request.body.autoAcceptThreshold,
  });
  if (result.candidateCount) scheduleEnrichmentJob(result.id);
  response.status(202).json({ jobId: result.id, candidateCount: result.candidateCount });
}));

app.get("/api/local/enrichment/jobs/:id", asyncRoute(async (request, response) => {
  const result = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      `SELECT jobs.*,
       (SELECT max(candidate.source_row_id) FROM partmaster_enrichment_candidates candidate WHERE candidate.job_id = jobs.id) AS last_source_row_id
       FROM partmaster_enrichment_jobs jobs WHERE jobs.id = $id`,
      { id: request.params.id },
    );
    const job = reader.getRowObjectsJson()[0];
    if (!job) {
      const error = new Error("Enrichment job not found.");
      error.status = 404;
      throw error;
    }
    return job;
  });
  response.json({ job: result });
}));

app.post("/api/local/enrichment/jobs/:id/pause", asyncRoute(async (request, response) => {
  await withConnection((connection) => connection.run(
    "UPDATE partmaster_enrichment_jobs SET status = 'paused' WHERE id = $id AND status IN ('queued', 'running')",
    { id: request.params.id },
  ));
  response.json({ ok: true });
}));

app.post("/api/local/enrichment/jobs/:id/resume", asyncRoute(async (request, response) => {
  const resumable = await withConnection(async (connection) => {
    await connection.run(
      "UPDATE partmaster_enrichment_candidates SET status = 'pending' WHERE job_id = $id AND status = 'processing'",
      { id: request.params.id },
    );
    await connection.run(
      "UPDATE partmaster_enrichment_jobs SET status = 'queued', completed_at = NULL, last_error = NULL WHERE id = $id AND status IN ('paused', 'failed')",
      { id: request.params.id },
    );
    const reader = await connection.runAndReadAll("SELECT status FROM partmaster_enrichment_jobs WHERE id = $id", { id: request.params.id });
    return reader.getRowObjectsJson()[0]?.status === "queued";
  });
  if (resumable) scheduleEnrichmentJob(request.params.id);
  response.json({ ok: true, resumed: resumable });
}));

app.post("/api/local/enrichment/jobs/:id/reprocess-review", asyncRoute(async (request, response) => {
  const resumable = await withConnection(async (connection) => {
    const jobReader = await connection.runAndReadAll("SELECT status FROM partmaster_enrichment_jobs WHERE id = $id", { id: request.params.id });
    const job = jobReader.getRowObjectsJson()[0];
    if (!job || !["completed", "paused", "failed"].includes(job.status)) return false;
    await connection.run(
      `UPDATE partmaster_enrichment_candidates SET status = 'pending', processed_at = NULL, decision_notes = NULL
       WHERE job_id = $id AND status IN ('needs_review', 'not_found', 'failed') AND decision IS NULL`,
      { id: request.params.id },
    );
    await connection.run(
      "UPDATE partmaster_enrichment_jobs SET status = 'queued', completed_at = NULL, last_error = NULL WHERE id = $id",
      { id: request.params.id },
    );
    await refreshEnrichmentJobStats(connection, request.params.id);
    return true;
  });
  if (resumable) scheduleEnrichmentJob(request.params.id);
  response.json({ ok: true, resumed: resumable });
}));

app.get("/api/local/enrichment/candidates", asyncRoute(async (request, response) => {
  const result = await withConnection(async (connection) => {
    const conditions = [];
    const values = {};
    if (request.query.jobId) {
      conditions.push("job_id = $jobId");
      values.jobId = String(request.query.jobId);
    }
    if (request.query.status) {
      conditions.push("status = $status");
      values.status = String(request.query.status);
    }
    const clause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.max(10, Math.min(500, Number(request.query.limit) || 100));
    const reader = await connection.runAndReadAll(
      `SELECT * FROM partmaster_enrichment_candidates ${clause}
       ORDER BY coalesce(processed_at, created_at) DESC, source_row_id LIMIT ${limit}`,
      values,
    );
    const countReader = await connection.runAndReadAll(
      `SELECT count(*) AS count FROM partmaster_enrichment_candidates ${clause}`,
      values,
    );
    return { candidates: reader.getRowObjectsJson(), total: countReader.getRowObjectsJson()[0].count };
  });
  response.json(result);
}));

app.patch("/api/local/enrichment/candidates/:id", asyncRoute(async (request, response) => {
  const decision = String(request.body.decision || "");
  if (!["approve", "reject"].includes(decision)) {
    return response.status(400).json({ error: "Decision must be approve or reject." });
  }
  await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      "SELECT * FROM partmaster_enrichment_candidates WHERE id = $id",
      { id: request.params.id },
    );
    const candidate = reader.getRowObjectsJson()[0];
    if (!candidate) {
      const error = new Error("Enrichment candidate not found.");
      error.status = 404;
      throw error;
    }
    const edited = {
      ...candidate,
      enriched_part_number: String(request.body.partNumber || candidate.enriched_part_number || candidate.part_number_raw || "").trim() || null,
      enriched_description: String(request.body.description || candidate.enriched_description || candidate.description_raw || "").trim() || null,
      side: String(request.body.side || candidate.side || "Unknown").trim(),
      position: String(request.body.position || candidate.position || "").trim() || null,
      location_notes: String(request.body.locationNotes || candidate.location_notes || "").trim() || null,
      confidence: decision === "approve" ? Math.max(Number(candidate.confidence) || 0, 0.9) : Number(candidate.confidence) || 0,
    };
    if (decision === "approve") {
      if (!normalizePartNumber(edited.enriched_part_number)) throw new Error("An OEM part number is required before approval.");
      await promoteCandidate(connection, edited, "human_verified");
    }
    await connection.run(
      `UPDATE partmaster_enrichment_candidates SET
       enriched_part_number = $partNumber, enriched_description = $description, side = $side,
       position = $position, location_notes = $locationNotes, confidence = $confidence,
       status = $status, decision = $decision, decision_notes = $notes, reviewed_at = current_timestamp
       WHERE id = $id`,
      {
        id: request.params.id,
        partNumber: edited.enriched_part_number,
        description: edited.enriched_description,
        side: edited.side,
        position: edited.position,
        locationNotes: edited.location_notes,
        confidence: edited.confidence,
        status: decision === "approve" ? "enriched" : "rejected",
        decision,
        notes: String(request.body.notes || "").trim() || null,
      },
    );
    await refreshEnrichmentJobStats(connection, candidate.job_id);
  });
  response.json({ ok: true });
}));

app.get("/api/local/master/stats", asyncRoute(async (_request, response) => {
  const stats = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      `SELECT
       (SELECT count(*) FROM partmaster_canonical_parts) AS parts,
       (SELECT count(*) FROM partmaster_part_applications) AS applications,
       (SELECT count(*) FROM partmaster_enrichment_candidates WHERE status IN ('needs_review', 'conflict')) AS awaiting_review,
       (SELECT count(*) FROM partmaster_enrichment_candidates WHERE status = 'enriched') AS enriched_candidates`,
    );
    return reader.getRowObjectsJson()[0];
  });
  response.json({ stats });
}));

app.post("/api/local/master/exports", asyncRoute(async (_request, response) => {
  const exports = await withConnection(async (connection) => {
    const stamp = Date.now();
    const partsFilename = `parts-master-${stamp}.csv`;
    const applicationsFilename = `part-applications-${stamp}.csv`;
    const partsPath = join(EXPORT_ROOT, partsFilename);
    const applicationsPath = join(EXPORT_ROOT, applicationsFilename);
    await connection.run(
      `COPY (SELECT manufacturer AS "Manufacturer", part_number AS "OEM Part Number",
       description AS "Description", verification_status AS "Verification Status",
       confidence AS "Confidence", evidence_url AS "Evidence URL", verified_at AS "Verified At"
       FROM partmaster_canonical_parts ORDER BY manufacturer_norm, part_number_norm)
       TO ${quoteString(partsPath)} (FORMAT CSV, HEADER true)`,
    );
    await connection.run(
      `COPY (SELECT parts.manufacturer AS "Manufacturer", parts.part_number AS "OEM Part Number",
       parts.description AS "Description", applications.item_number AS "Item #",
       applications.side AS "Side", applications.position AS "Position",
       applications.location_notes AS "Location Notes", applications.year AS "Year",
       applications.model AS "Model", applications.assembly AS "Assembly",
       applications.quantity AS "Quantity", applications.source_url AS "Source URL",
       applications.evidence_url AS "Evidence URL", applications.confidence AS "Confidence"
       FROM partmaster_part_applications applications
       JOIN partmaster_canonical_parts parts ON parts.id = applications.part_id
       ORDER BY parts.manufacturer_norm, parts.part_number_norm, applications.year, applications.model)
       TO ${quoteString(applicationsPath)} (FORMAT CSV, HEADER true)`,
    );
    return [
      { filename: partsFilename, path: partsPath, bytes: (await stat(partsPath)).size },
      { filename: applicationsFilename, path: applicationsPath, bytes: (await stat(applicationsPath)).size },
    ];
  });
  response.json({ exports });
}));

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.status || 500).json({ error: error.message || "Local data service error." });
});

const resumableJobIds = await withConnection(async (connection) => {
  await connection.run("UPDATE partmaster_enrichment_candidates SET status = 'pending' WHERE status = 'processing'");
  await connection.run("UPDATE partmaster_enrichment_jobs SET status = 'queued' WHERE status = 'running'");
  const reader = await connection.runAndReadAll("SELECT id FROM partmaster_enrichment_jobs WHERE status = 'queued'");
  return reader.getRowObjectsJson().map((job) => job.id);
});

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`Partmaster local data service: http://127.0.0.1:${PORT}`);
  console.log(`Local data directory: ${DATA_ROOT}`);
  resumableJobIds.forEach(scheduleEnrichmentJob);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; checkpointing local data before shutdown…`);
  server.close();
  const deadline = Date.now() + 20_000;
  while (activeEnrichmentJobs.size && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  try {
    await withConnection(async (connection) => {
      await connection.run("UPDATE partmaster_enrichment_candidates SET status = 'pending' WHERE status = 'processing'");
      await connection.run("UPDATE partmaster_enrichment_jobs SET status = 'queued' WHERE status = 'running'");
      await connection.run("CHECKPOINT");
    });
  } catch (error) {
    console.error(`DuckDB checkpoint failed during shutdown: ${error.message}`);
  }
  instance.closeSync();
  process.exit(0);
}

process.on("SIGINT", () => { shutdown("SIGINT"); });
process.on("SIGTERM", () => { shutdown("SIGTERM"); });
