import { DuckDBInstance } from "@duckdb/node-api";
import express from "express";
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const APP_ROOT = resolve(import.meta.dirname, "..");
const DATA_ROOT = join(APP_ROOT, "local_data");
const INBOX_ROOT = join(DATA_ROOT, "inbox");
const RAWDATA_ROOT = join(INBOX_ROOT, "rawdata");
const EXPORT_ROOT = join(DATA_ROOT, "exports");
const REFERENCE_ROOT = join(DATA_ROOT, "reference");
const VEHICLE_MASTER_PATH = join(REFERENCE_ROOT, "vehicle_master.csv");
const VEHICLE_ALIASES_PATH = join(REFERENCE_ROOT, "vehicle_source_aliases.csv");
const MPSOV_INBOX_PATH = join(INBOX_ROOT, "MPSOV.csv");
const DATABASE_PATH = resolve(process.env.PARTMASTER_DATABASE_PATH || join(DATA_ROOT, "partmaster.duckdb"));
const PORT = Number(process.env.PARTMASTER_DATA_PORT || 8787);
const importJobs = new Map();
const activeEnrichmentJobs = new Set();
const activeRowEnhancementJobs = new Set();
const activeAutopilotJobs = new Set();
const activePipelineJobs = new Set();
const compatibilityQueue = [];
const queuedCompatibilityKeys = new Set();
let compatibilityWorkerRunning = false;
let schedulerChecking = false;
let shuttingDown = false;
const ENRICHMENT_FETCH_TIMEOUT_MS = Math.max(3000, Number(process.env.PARTMASTER_FETCH_TIMEOUT_MS) || 15000);
const ENRICHMENT_MAX_PAGE_BYTES = Math.max(100000, Number(process.env.PARTMASTER_MAX_PAGE_BYTES) || 2_000_000);
const PIPELINE_MAX_ONLINE_BUDGET = Math.max(5000, Number(process.env.PARTMASTER_MAX_ONLINE_BUDGET) || 500_000);

await Promise.all([
  mkdir(INBOX_ROOT, { recursive: true }),
  mkdir(RAWDATA_ROOT, { recursive: true }),
  mkdir(EXPORT_ROOT, { recursive: true }),
  mkdir(REFERENCE_ROOT, { recursive: true }),
]);

const instance = await DuckDBInstance.create(DATABASE_PATH, {
  threads: String(Math.max(1, Math.min(4, Number(process.env.PARTMASTER_THREADS) || 2))),
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
    mode VARCHAR NOT NULL DEFAULT 'full',
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
    family_name VARCHAR,
    component_scope VARCHAR,
    heated_state VARCHAR,
    auto_dimming_state VARCHAR,
    power_folding_state VARCHAR,
    memory_state VARCHAR,
    blind_spot_state VARCHAR,
    camera_state VARCHAR,
    turn_signal_state VARCHAR,
    connector_pins VARCHAR,
    required_options VARCHAR,
    excluded_options VARCHAR,
    variant_summary VARCHAR,
    fitment_explanation VARCHAR,
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
    family_id VARCHAR,
    component_scope VARCHAR,
    variant_summary VARCHAR,
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
    required_options VARCHAR,
    excluded_options VARCHAR,
    fitment_explanation VARCHAR,
    confidence DOUBLE,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    UNIQUE (part_id, dataset_id, source_row_id)
  );

  CREATE TABLE IF NOT EXISTS partmaster_part_families (
    id VARCHAR PRIMARY KEY,
    manufacturer_norm VARCHAR NOT NULL,
    family_key VARCHAR NOT NULL,
    family_name VARCHAR NOT NULL,
    category VARCHAR,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    UNIQUE (manufacturer_norm, family_key)
  );

  CREATE TABLE IF NOT EXISTS partmaster_variant_attributes (
    id VARCHAR PRIMARY KEY,
    part_id VARCHAR NOT NULL,
    attribute_name VARCHAR NOT NULL,
    attribute_value VARCHAR NOT NULL,
    confidence DOUBLE,
    evidence_url VARCHAR,
    source_method VARCHAR,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    UNIQUE (part_id, attribute_name)
  );

  CREATE TABLE IF NOT EXISTS partmaster_pipeline_jobs (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    phase VARCHAR NOT NULL,
    dataset_ids VARCHAR,
    import_missing BOOLEAN NOT NULL DEFAULT true,
    total_rows BIGINT NOT NULL DEFAULT 0,
    scanned_rows BIGINT NOT NULL DEFAULT 0,
    invalid_rows BIGINT NOT NULL DEFAULT 0,
    unique_parts BIGINT NOT NULL DEFAULT 0,
    duplicates_removed BIGINT NOT NULL DEFAULT 0,
    attribute_processed BIGINT NOT NULL DEFAULT 0,
    attributed_parts BIGINT NOT NULL DEFAULT 0,
    attribute_facts BIGINT NOT NULL DEFAULT 0,
    source_pages BIGINT NOT NULL DEFAULT 0,
    online_budget INTEGER NOT NULL DEFAULT 0,
    online_checked BIGINT NOT NULL DEFAULT 0,
    online_verified_parts BIGINT NOT NULL DEFAULT 0,
    current_dataset VARCHAR,
    last_error VARCHAR,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    started_at TIMESTAMP,
    completed_at TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS partmaster_pipeline_schedules (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    schedule_type VARCHAR NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    run_at VARCHAR,
    time_of_day VARCHAR,
    online_budget INTEGER NOT NULL DEFAULT 10000,
    dataset_ids VARCHAR,
    run_all_remaining BOOLEAN NOT NULL DEFAULT false,
    next_run_at TIMESTAMP,
    last_run_at TIMESTAMP,
    last_job_id VARCHAR,
    last_status VARCHAR,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  );

  CREATE TABLE IF NOT EXISTS partmaster_offline_part_sources (
    part_key VARCHAR NOT NULL,
    dataset_id VARCHAR NOT NULL,
    source_row_id BIGINT,
    manufacturer VARCHAR,
    manufacturer_norm VARCHAR NOT NULL,
    part_number VARCHAR,
    part_number_norm VARCHAR NOT NULL,
    description VARCHAR,
    year VARCHAR,
    model VARCHAR,
    assembly VARCHAR,
    item_number VARCHAR,
    quantity VARCHAR,
    source_url VARCHAR,
    occurrence_count BIGINT NOT NULL DEFAULT 1,
    PRIMARY KEY (part_key, dataset_id)
  );

  CREATE TABLE IF NOT EXISTS partmaster_source_processing (
    dataset_id VARCHAR PRIMARY KEY,
    raw_rows BIGINT NOT NULL DEFAULT 0,
    usable_rows BIGINT NOT NULL DEFAULT 0,
    invalid_rows BIGINT NOT NULL DEFAULT 0,
    unique_parts BIGINT NOT NULL DEFAULT 0,
    scanned_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  );

  CREATE TABLE IF NOT EXISTS partmaster_offline_parts (
    part_key VARCHAR PRIMARY KEY,
    manufacturer VARCHAR,
    manufacturer_norm VARCHAR NOT NULL,
    part_number VARCHAR,
    part_number_norm VARCHAR NOT NULL,
    description VARCHAR,
    family_name VARCHAR,
    component_scope VARCHAR,
    side VARCHAR,
    position VARCHAR,
    extracted_attributes_json VARCHAR,
    extracted_attribute_count INTEGER NOT NULL DEFAULT 0,
    occurrence_count BIGINT NOT NULL DEFAULT 0,
    dataset_count BIGINT NOT NULL DEFAULT 0,
    application_count BIGINT NOT NULL DEFAULT 0,
    source_page_count BIGINT NOT NULL DEFAULT 0,
    best_source_url VARCHAR,
    confidence DOUBLE NOT NULL DEFAULT 0,
    attribute_status VARCHAR NOT NULL DEFAULT 'pending',
    online_status VARCHAR NOT NULL DEFAULT 'queued',
    updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  );

  CREATE TABLE IF NOT EXISTS partmaster_offline_source_pages (
    source_url VARCHAR PRIMARY KEY,
    source_host VARCHAR,
    part_count BIGINT NOT NULL DEFAULT 0,
    occurrence_count BIGINT NOT NULL DEFAULT 0,
    priority_score DOUBLE NOT NULL DEFAULT 0,
    status VARCHAR NOT NULL DEFAULT 'pending',
    verified_parts BIGINT NOT NULL DEFAULT 0,
    error_message VARCHAR,
    checked_at TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS partmaster_part_relationships (
    id VARCHAR PRIMARY KEY,
    source_part_id VARCHAR NOT NULL,
    target_part_id VARCHAR NOT NULL,
    relationship_type VARCHAR NOT NULL,
    conditions VARCHAR,
    confidence DOUBLE,
    evidence_url VARCHAR,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    UNIQUE (source_part_id, target_part_id, relationship_type)
  );

  CREATE TABLE IF NOT EXISTS partmaster_part_aliases (
    id VARCHAR PRIMARY KEY,
    part_id VARCHAR NOT NULL,
    alias_number VARCHAR NOT NULL,
    alias_norm VARCHAR NOT NULL,
    alias_type VARCHAR NOT NULL,
    status VARCHAR NOT NULL DEFAULT 'verified',
    confidence DOUBLE,
    evidence_url VARCHAR,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    UNIQUE (part_id, alias_norm, alias_type)
  );

  CREATE TABLE IF NOT EXISTS partmaster_field_evidence (
    id VARCHAR PRIMARY KEY,
    part_id VARCHAR NOT NULL,
    field_name VARCHAR NOT NULL,
    field_value VARCHAR NOT NULL,
    source_url VARCHAR NOT NULL,
    source_title VARCHAR,
    source_method VARCHAR NOT NULL,
    confidence DOUBLE,
    accepted BOOLEAN NOT NULL DEFAULT false,
    observed_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    UNIQUE (part_id, field_name, field_value, source_url)
  );

  CREATE TABLE IF NOT EXISTS partmaster_quality_scores (
    part_id VARCHAR PRIMARY KEY,
    identity_score DOUBLE NOT NULL,
    description_score DOUBLE NOT NULL,
    fitment_score DOUBLE NOT NULL,
    variant_score DOUBLE NOT NULL,
    evidence_score DOUBLE NOT NULL,
    freshness_score DOUBLE NOT NULL,
    conflict_risk DOUBLE NOT NULL,
    overall_score DOUBLE NOT NULL,
    missing_fields VARCHAR,
    calculated_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  );

  CREATE TABLE IF NOT EXISTS partmaster_data_conflicts (
    id VARCHAR PRIMARY KEY,
    conflict_key VARCHAR NOT NULL UNIQUE,
    part_id VARCHAR NOT NULL,
    field_name VARCHAR NOT NULL,
    severity VARCHAR NOT NULL,
    values_seen VARCHAR NOT NULL,
    explanation VARCHAR NOT NULL,
    status VARCHAR NOT NULL DEFAULT 'open',
    detected_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    resolved_at TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS partmaster_review_feedback (
    id VARCHAR PRIMARY KEY,
    candidate_id VARCHAR,
    part_id VARCHAR,
    decision VARCHAR NOT NULL,
    changed_fields VARCHAR,
    reason VARCHAR,
    source_host VARCHAR,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  );

  CREATE TABLE IF NOT EXISTS partmaster_autopilot_jobs (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    requested_parts INTEGER NOT NULL,
    max_online_requests INTEGER NOT NULL,
    min_confidence DOUBLE NOT NULL,
    manufacturers VARCHAR,
    categories VARCHAR,
    discover_compatibility BOOLEAN NOT NULL DEFAULT true,
    recheck_older BOOLEAN NOT NULL DEFAULT false,
    queued_count INTEGER NOT NULL DEFAULT 0,
    processed_count INTEGER NOT NULL DEFAULT 0,
    verified_count INTEGER NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0,
    no_source_count INTEGER NOT NULL DEFAULT 0,
    not_found_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    online_checks INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    last_error VARCHAR
  );

  CREATE TABLE IF NOT EXISTS partmaster_autopilot_items (
    id VARCHAR PRIMARY KEY,
    job_id VARCHAR NOT NULL,
    part_id VARCHAR NOT NULL,
    priority_score DOUBLE,
    status VARCHAR NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    confidence DOUBLE,
    evidence_url VARCHAR,
    message VARCHAR,
    fields_updated VARCHAR,
    compatibility_added INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMP,
    processed_at TIMESTAMP,
    UNIQUE (job_id, part_id)
  );

  CREATE TABLE IF NOT EXISTS partmaster_page_cache (
    source_url VARCHAR PRIMARY KEY,
    final_url VARCHAR,
    page_title VARCHAR,
    content_html VARCHAR,
    success BOOLEAN NOT NULL,
    error_message VARCHAR,
    fetched_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  );

  CREATE TABLE IF NOT EXISTS partmaster_part_compatibility (
    id VARCHAR PRIMARY KEY,
    compatibility_key VARCHAR NOT NULL UNIQUE,
    part_id VARCHAR NOT NULL,
    year VARCHAR,
    model VARCHAR,
    model_code VARCHAR,
    assembly VARCHAR,
    source_url VARCHAR,
    evidence_url VARCHAR,
    confidence DOUBLE,
    verified_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  );

  CREATE TABLE IF NOT EXISTS partmaster_row_enhancement_jobs (
    id VARCHAR PRIMARY KEY,
    dataset_id VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    total_count INTEGER NOT NULL,
    processed_count INTEGER NOT NULL DEFAULT 0,
    filled_count INTEGER NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    last_error VARCHAR
  );

  CREATE TABLE IF NOT EXISTS partmaster_row_enhancement_items (
    id VARCHAR PRIMARY KEY,
    job_id VARCHAR NOT NULL,
    row_id BIGINT NOT NULL,
    status VARCHAR NOT NULL DEFAULT 'pending',
    suggested_changes VARCHAR,
    confidence DOUBLE,
    evidence_url VARCHAR,
    notes VARCHAR,
    processed_at TIMESTAMP,
    UNIQUE (job_id, row_id)
  );

  CREATE TABLE IF NOT EXISTS partmaster_vehicle_master (
    epid VARCHAR PRIMARY KEY,
    year VARCHAR,
    make_name VARCHAR,
    model_name VARCHAR,
    trim_name VARCHAR,
    vehicle_type VARCHAR,
    motorcycle_type VARCHAR,
    year_norm VARCHAR,
    make_norm VARCHAR,
    model_norm VARCHAR,
    loaded_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  );

  CREATE TABLE IF NOT EXISTS partmaster_vehicle_source_aliases (
    epid VARCHAR NOT NULL,
    source VARCHAR NOT NULL,
    year VARCHAR,
    make_name VARCHAR,
    model_name VARCHAR,
    trim_name VARCHAR,
    year_norm VARCHAR,
    make_norm VARCHAR,
    model_norm VARCHAR,
    loaded_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    UNIQUE (epid, source, year, make_name, model_name, trim_name)
  );

  CREATE INDEX IF NOT EXISTS enrichment_candidates_job_status_idx
    ON partmaster_enrichment_candidates (job_id, status);
  CREATE INDEX IF NOT EXISTS canonical_parts_lookup_idx
    ON partmaster_canonical_parts (manufacturer_norm, part_number_norm);
  CREATE INDEX IF NOT EXISTS part_applications_part_idx
    ON partmaster_part_applications (part_id);
  CREATE INDEX IF NOT EXISTS variant_attributes_part_idx
    ON partmaster_variant_attributes (part_id);
  CREATE INDEX IF NOT EXISTS offline_parts_status_idx
    ON partmaster_offline_parts (attribute_status, online_status);
  CREATE INDEX IF NOT EXISTS offline_sources_dataset_idx
    ON partmaster_offline_part_sources (dataset_id);
  CREATE INDEX IF NOT EXISTS offline_sources_url_idx
    ON partmaster_offline_part_sources (source_url);
  CREATE INDEX IF NOT EXISTS offline_pages_status_idx
    ON partmaster_offline_source_pages (status, priority_score);
  CREATE INDEX IF NOT EXISTS part_aliases_lookup_idx
    ON partmaster_part_aliases (alias_norm);
  CREATE INDEX IF NOT EXISTS field_evidence_part_idx
    ON partmaster_field_evidence (part_id, field_name);
  CREATE INDEX IF NOT EXISTS conflicts_part_status_idx
    ON partmaster_data_conflicts (part_id, status);
  CREATE INDEX IF NOT EXISTS autopilot_items_job_status_idx
    ON partmaster_autopilot_items (job_id, status);
  CREATE INDEX IF NOT EXISTS part_compatibility_part_idx
    ON partmaster_part_compatibility (part_id);
  CREATE INDEX IF NOT EXISTS row_enhancement_items_job_idx
    ON partmaster_row_enhancement_items (job_id, status);
  CREATE INDEX IF NOT EXISTS vehicle_master_text_idx
    ON partmaster_vehicle_master (year_norm, make_norm, model_norm);
  CREATE INDEX IF NOT EXISTS vehicle_alias_text_idx
    ON partmaster_vehicle_source_aliases (year_norm, make_norm, model_norm);
  CREATE INDEX IF NOT EXISTS vehicle_alias_epid_idx
    ON partmaster_vehicle_source_aliases (epid)
`));

await withConnection((connection) => connection.run(`
  INSERT OR IGNORE INTO partmaster_source_processing
    (dataset_id, raw_rows, usable_rows, invalid_rows, unique_parts, scanned_at)
  SELECT datasets.id, datasets.row_count, coalesce(sum(sources.occurrence_count), 0),
    greatest(0, datasets.row_count - coalesce(sum(sources.occurrence_count), 0)), count(DISTINCT sources.part_key),
    coalesce(max(datasets.imported_at), current_timestamp)
  FROM partmaster_datasets datasets
  JOIN partmaster_offline_part_sources sources ON sources.dataset_id = datasets.id
  GROUP BY datasets.id, datasets.row_count;
`));

await withConnection((connection) => connection.run(`
  ALTER TABLE partmaster_pipeline_jobs ADD COLUMN IF NOT EXISTS attribute_processed BIGINT DEFAULT 0;
  ALTER TABLE partmaster_pipeline_jobs ADD COLUMN IF NOT EXISTS mode VARCHAR DEFAULT 'full';
  ALTER TABLE partmaster_enrichment_jobs ADD COLUMN IF NOT EXISTS start_row_id BIGINT DEFAULT 0;
  ALTER TABLE partmaster_part_applications ADD COLUMN IF NOT EXISTS application_key VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS family_name VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS component_scope VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS heated_state VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS auto_dimming_state VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS power_folding_state VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS memory_state VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS blind_spot_state VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS camera_state VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS turn_signal_state VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS connector_pins VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS required_options VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS excluded_options VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS variant_summary VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS fitment_explanation VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS epid VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS vehicle_year VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS vehicle_make VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS vehicle_model VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS vehicle_trim VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS vehicle_type VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS vehicle_motorcycle_type VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS vehicle_mapping_method VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS vehicle_mapping_confidence DOUBLE;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS extracted_attributes_json VARCHAR;
  ALTER TABLE partmaster_enrichment_candidates ADD COLUMN IF NOT EXISTS extracted_attribute_count INTEGER DEFAULT 0;
  ALTER TABLE partmaster_canonical_parts ADD COLUMN IF NOT EXISTS family_id VARCHAR;
  ALTER TABLE partmaster_canonical_parts ADD COLUMN IF NOT EXISTS component_scope VARCHAR;
  ALTER TABLE partmaster_canonical_parts ADD COLUMN IF NOT EXISTS variant_summary VARCHAR;
  ALTER TABLE partmaster_part_applications ADD COLUMN IF NOT EXISTS required_options VARCHAR;
  ALTER TABLE partmaster_part_applications ADD COLUMN IF NOT EXISTS excluded_options VARCHAR;
  ALTER TABLE partmaster_part_applications ADD COLUMN IF NOT EXISTS fitment_explanation VARCHAR;
  ALTER TABLE partmaster_part_applications ADD COLUMN IF NOT EXISTS epid VARCHAR;
  ALTER TABLE partmaster_part_applications ADD COLUMN IF NOT EXISTS vehicle_make VARCHAR;
  ALTER TABLE partmaster_part_applications ADD COLUMN IF NOT EXISTS vehicle_model VARCHAR;
  ALTER TABLE partmaster_part_applications ADD COLUMN IF NOT EXISTS vehicle_trim VARCHAR;
  ALTER TABLE partmaster_part_applications ADD COLUMN IF NOT EXISTS vehicle_type VARCHAR;
  ALTER TABLE partmaster_part_applications ADD COLUMN IF NOT EXISTS vehicle_motorcycle_type VARCHAR;
  ALTER TABLE partmaster_vehicle_master ADD COLUMN IF NOT EXISTS motorcycle_type VARCHAR;
  ALTER TABLE partmaster_part_applications ADD COLUMN IF NOT EXISTS vehicle_mapping_method VARCHAR;
  ALTER TABLE partmaster_part_applications ADD COLUMN IF NOT EXISTS vehicle_mapping_confidence DOUBLE;
  CREATE UNIQUE INDEX IF NOT EXISTS part_applications_key_idx
    ON partmaster_part_applications (application_key);
  CREATE INDEX IF NOT EXISTS canonical_parts_family_idx
    ON partmaster_canonical_parts (family_id)
`));

await withConnection((connection) => connection.run(`
  DELETE FROM partmaster_variant_attributes
  WHERE attribute_name = 'component_scope'
    OR lower(trim(coalesce(attribute_value, ''))) IN ('', 'unknown', 'none_known');
`));

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function friendlyDataError(error) {
  const message = String(error?.message || error || "Local data service error.");
  if (/out of memory|failed to pin block/i.test(message)) {
    return "The local database reached its memory limit, so the job stopped safely. Partmaster is now using low-memory mode; resume the job to continue.";
  }
  return message;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function quoteString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function safeInboxFile(filename) {
  const cleanName = String(filename || "").trim().replaceAll("\\", "/");
  if (!cleanName || cleanName.startsWith("/") || cleanName.split("/").includes("..")) throw new Error("Choose a file from the Partmaster inbox.");
  const extension = extname(cleanName).toLowerCase();
  if (![".csv", ".tsv", ".txt"].includes(extension)) throw new Error("Only CSV, TSV, and text files can be imported.");
  const resolvedPath = resolve(INBOX_ROOT, cleanName);
  if (!resolvedPath.startsWith(`${INBOX_ROOT}${sep}`)) throw new Error("Choose a file from the Partmaster inbox.");
  return resolvedPath;
}

async function listInboxDataFiles({ partsOnly = false } = {}) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || ![".csv", ".tsv", ".txt"].includes(extname(entry.name).toLowerCase())) continue;
      if (partsOnly && (/sample/i.test(entry.name) || /mpsov/i.test(entry.name) || /^vehicle_(master|source_aliases)\.csv$/i.test(entry.name))) continue;
      const details = await stat(fullPath);
      files.push({
        name: relative(INBOX_ROOT, fullPath).split(sep).join("/"),
        bytes: details.size,
        modifiedAt: details.mtime.toISOString(),
        kind: /^mpsov\.csv$/i.test(entry.name) ? "vehicle_reference" : "parts_source",
      });
    }
  }
  await walk(INBOX_ROOT);
  return files;
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

const CATEGORY_ATTRIBUTE_SCHEMAS = [
  { key: "exterior_mirror", label: "Exterior Mirror", match: ["mirror", "rearview"], attributes: [
    ["side", "Side", "enum"], ["heated", "Heated", "boolean"], ["auto_dimming", "Auto dimming", "boolean"],
    ["power_folding", "Power folding", "boolean"], ["memory", "Memory", "boolean"], ["blind_spot", "Blind spot", "boolean"],
    ["camera", "Camera", "boolean"], ["turn_signal", "Turn signal", "boolean"], ["connector_pins", "Connector pins", "number"],
  ] },
  { key: "clutch", label: "Clutch", match: ["clutch"], attributes: [
    ["component_type", "Component type", "enum"], ["plate_type", "Plate type", "enum"], ["thickness_mm", "Thickness (mm)", "number"],
    ["outer_diameter_mm", "Outer diameter (mm)", "number"], ["inner_diameter_mm", "Inner diameter (mm)", "number"], ["material", "Material", "text"], ["quantity_in_assembly", "Quantity in assembly", "number"],
  ] },
  { key: "brake_system", label: "Brake System", match: ["brake", "caliper", "rotor"], attributes: [
    ["axle", "Front / rear", "enum"], ["side", "Side", "enum"], ["rotor_diameter_mm", "Rotor diameter (mm)", "number"],
    ["rotor_thickness_mm", "Rotor thickness (mm)", "number"], ["caliper_type", "Caliper type", "text"],
    ["piston_count", "Piston count", "number"], ["wear_sensor", "Wear sensor", "boolean"], ["rotor_style", "Rotor style", "enum"],
  ] },
  { key: "lighting", label: "Lighting", match: ["headlight", "headlamp", "tail light", "taillight", "lamp"], attributes: [
    ["side", "Side", "enum"], ["light_technology", "LED / HID / Halogen", "enum"], ["adaptive", "Adaptive", "boolean"],
    ["housing_color", "Housing color", "text"], ["lens_color", "Lens color", "text"], ["connector_pins", "Connector pins", "number"],
  ] },
  { key: "engine", label: "Engine", match: ["engine", "cylinder", "piston", "crank"], attributes: [
    ["engine_code", "Engine code", "text"], ["displacement", "Displacement", "text"], ["cylinder_position", "Cylinder position", "text"],
    ["fuel_type", "Fuel type", "enum"], ["aspiration", "Aspiration", "enum"], ["emissions_standard", "Emissions standard", "text"],
  ] },
  { key: "body", label: "Body / Exterior", match: ["bumper", "door", "fender", "molding", "roof", "body"], attributes: [
    ["side", "Side", "enum"], ["position", "Position", "text"], ["color_code", "Color code", "text"],
    ["material", "Material", "text"], ["sensor_holes", "Sensor holes", "number"], ["finish", "Finish", "text"],
  ] },
  { key: "wheel", label: "Wheel / Tire", match: ["wheel", "rim", "tire"], attributes: [
    ["diameter_in", "Diameter (in)", "number"], ["width_in", "Width (in)", "number"], ["bolt_pattern", "Bolt pattern", "text"],
    ["offset_mm", "Offset (mm)", "number"], ["construction", "Construction", "enum"], ["material", "Material", "text"],
    ["color", "Color", "text"], ["finish", "Finish", "text"], ["tpms", "TPMS", "boolean"], ["tooth_count", "Tooth count", "number"],
  ] },
  { key: "fastener", label: "Fastener / Hardware", match: ["fastener", "screw", "bolt", "nut", "washer", "rivet", "clip"], attributes: [
    ["fastener_type", "Fastener type", "enum"], ["thread_diameter_mm", "Thread diameter (mm)", "number"],
    ["thread_pitch_mm", "Thread pitch (mm)", "number"], ["length_mm", "Length (mm)", "number"],
    ["strength_grade", "Strength grade", "text"], ["material_grade", "Material grade", "text"],
    ["coating", "Coating", "text"], ["head_style", "Head style", "text"], ["drive_type", "Drive type", "text"],
  ] },
  { key: "bearing", label: "Bearing / Bushing", match: ["bearing", "bushing", "bush"], attributes: [
    ["component_type", "Component type", "enum"], ["inner_diameter_mm", "Inner diameter (mm)", "number"],
    ["outer_diameter_mm", "Outer diameter (mm)", "number"], ["width_mm", "Width (mm)", "number"],
    ["sealed", "Sealed", "boolean"], ["material", "Material", "text"],
  ] },
  { key: "seal", label: "Seal / Gasket", match: ["seal", "gasket", "o-ring", "oring"], attributes: [
    ["seal_type", "Seal type", "enum"], ["inner_diameter_mm", "Inner diameter (mm)", "number"],
    ["outer_diameter_mm", "Outer diameter (mm)", "number"], ["thickness_mm", "Thickness (mm)", "number"],
    ["material", "Material", "text"],
  ] },
  { key: "filter", label: "Filter", match: ["filter", "strainer"], attributes: [
    ["filter_type", "Filter type", "enum"], ["media_material", "Media material", "text"],
    ["outer_diameter_mm", "Outer diameter (mm)", "number"], ["height_mm", "Height (mm)", "number"],
    ["thread_size", "Thread size", "text"],
  ] },
  { key: "electrical", label: "Electrical / Sensor", match: ["sensor", "switch", "relay", "module", "alternator", "regulator", "electrical"], attributes: [
    ["component_type", "Component type", "enum"], ["voltage_v", "Voltage (V)", "number"], ["current_a", "Current (A)", "number"],
    ["power_w", "Power (W)", "number"], ["resistance_ohm", "Resistance (ohm)", "number"],
    ["connector_pins", "Connector pins", "number"], ["tooth_count", "Tooth count", "number"],
  ] },
  { key: "suspension", label: "Suspension / Steering", match: ["suspension", "steering", "shock", "strut", "fork", "swingarm", "tie rod"], attributes: [
    ["component_type", "Component type", "enum"], ["side", "Side", "enum"], ["position", "Position", "text"],
    ["length_mm", "Length (mm)", "number"], ["diameter_mm", "Diameter (mm)", "number"], ["adjustable", "Adjustable", "boolean"],
  ] },
  { key: "cooling", label: "Cooling / HVAC", match: ["radiator", "cooling", "thermostat", "hose", "heater", "air conditioning", "hvac"], attributes: [
    ["component_type", "Component type", "enum"], ["diameter_mm", "Diameter (mm)", "number"], ["length_mm", "Length (mm)", "number"],
    ["temperature_c", "Temperature (C)", "number"], ["pressure_bar", "Pressure (bar)", "number"], ["material", "Material", "text"],
  ] },
  { key: "paint_chemical", label: "Paint / Chemical", match: ["paint", "touch up", "adhesive", "sealant", "thread lock", "chemical"], attributes: [
    ["product_type", "Product type", "enum"], ["color", "Color", "text"], ["color_code", "Color code", "text"],
    ["volume_ml", "Volume (ml)", "number"], ["strength", "Strength", "text"], ["finish", "Finish", "text"],
  ] },
  { key: "general", label: "General Part", match: [], attributes: [
    ["side", "Side", "enum"], ["position", "Position", "text"], ["material", "Material", "text"],
    ["dimensions", "Dimensions", "text"], ["diameter_mm", "Diameter (mm)", "number"], ["length_mm", "Length (mm)", "number"],
    ["width_mm", "Width (mm)", "number"], ["height_mm", "Height (mm)", "number"], ["thickness_mm", "Thickness (mm)", "number"],
    ["color", "Color", "text"], ["finish", "Finish", "text"], ["voltage_v", "Voltage (V)", "number"],
    ["connector_pins", "Connector pins", "number"], ["quantity_in_assembly", "Quantity in assembly", "number"],
  ] },
].map((schema) => ({ ...schema, attributes: schema.attributes.map(([key, label, type]) => ({ key, label, type })) }));

function categorySchemaFor(familyName, description = "") {
  const familyText = String(familyName || "").toLowerCase();
  const familySchema = CATEGORY_ATTRIBUTE_SCHEMAS.find((schema) => schema.key === familyText.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
    || schema.label.toLowerCase() === familyText
    || schema.match.some((term) => familyText.includes(term)));
  if (familySchema) return familySchema;
  const text = String(description || "").toLowerCase();
  return CATEGORY_ATTRIBUTE_SCHEMAS.find((schema) => schema.match.some((term) => text.includes(term)))
    || CATEGORY_ATTRIBUTE_SCHEMAS.at(-1);
}

function inferCategoryAttributes(candidate, description = "") {
  const text = `${description || candidate.enriched_description || candidate.description_raw || ""} ${candidate.assembly || ""}`
    .toUpperCase().replace(/(\d),(\d)/g, "$1.$2");
  const schema = categorySchemaFor(candidate.family_name || candidate.familyName || candidate.assembly, text);
  const attributes = {};
  const set = (name, value) => { if (value != null && String(value).trim()) attributes[name] = String(value).trim(); };
  const dimension = text.match(/\b(\d+(?:\.\d+)?)\s*X\s*(\d+(?:\.\d+)?)(?:\s*X\s*(\d+(?:\.\d+)?))?\s*(MM|CM|IN(?:CH)?)?\b/);
  if (dimension) set("dimensions", `${dimension[1]} x ${dimension[2]}${dimension[3] ? ` x ${dimension[3]}` : ""}${dimension[4] ? ` ${dimension[4].toLowerCase()}` : ""}`);
  const color = ["BLACK", "WHITE", "SILVER", "CHROME", "RED", "BLUE", "GREEN", "GRAY", "GREY", "BEIGE", "BROWN", "ORANGE", "YELLOW"].find((item) => new RegExp(`\\b${item}\\b`).test(text));
  if (color) set("color", color === "GREY" ? "Gray" : titleCase(color));
  const material = [
    ["STAINLESS STEEL", /\bSTAINLESS(?: STEEL)?|\bINOX\b/], ["Aluminum", /\bALUM(?:INUM|INIUM)?\b/],
    ["Steel", /\bSTEEL\b/], ["Carbon fiber", /\bCARBON(?: FIBER| FIBRE)?\b/], ["Rubber", /\bRUBBER\b/],
    ["Plastic", /\bPLASTIC\b/], ["Nylon", /\bNYLON\b/], ["Copper", /\bCOPPER\b/], ["Brass", /\bBRASS\b/],
  ].find(([, pattern]) => pattern.test(text))?.[0];
  if (material) set("material", material);
  const finish = [
    ["Primed", /\bPRIMED\b/], ["Polished", /\bPOLISHED\b/], ["Matte", /\bMATT(?:E)?\b/],
    ["Gloss", /\bGLOSS(?:Y)?\b/], ["Chrome", /\bCHROME(?:D)?\b/], ["Painted", /\bPAINTED\b/],
  ].find(([, pattern]) => pattern.test(text))?.[0];
  if (finish) set("finish", finish);
  const labeledDiameter = text.match(/\b(?:D|DIA|DIAMETER|Ø)\s*[:=]\s*(\d+(?:\.\d+)?)\s*MM\b/)?.[1];
  const labeledThickness = text.match(/\b(?:T|THK|THICKNESS)\s*[:=]\s*(\d+(?:\.\d+)?)\s*MM\b/)?.[1];
  const labeledLength = text.match(/\b(?:L|LENGTH)\s*[:=]\s*(\d+(?:\.\d+)?)\s*MM\b/)?.[1];
  if (labeledDiameter) set("diameter_mm", labeledDiameter);
  if (labeledThickness) set("thickness_mm", labeledThickness);
  if (labeledLength) set("length_mm", labeledLength);
  const connector = text.match(/\b(\d{1,2})[- ]?PIN\b/)?.[1];
  if (connector) set("connector_pins", connector);
  const voltage = text.match(/\b(\d+(?:\.\d+)?)\s*V(?:OLT)?S?\b/)?.[1];
  if (voltage) set("voltage_v", voltage);
  const current = text.match(/\b(\d+(?:\.\d+)?)\s*A(?:MP)?S?\b/)?.[1];
  if (current) set("current_a", current);
  const power = text.match(/\b(\d+(?:\.\d+)?)\s*W(?:ATT)?S?\b/)?.[1];
  if (power) set("power_w", power);
  const volume = text.match(/\b(\d+(?:\.\d+)?)\s*ML\b/)?.[1];
  if (volume) set("volume_ml", volume);
  set("source_brand", text.match(/\bBRAND:\s*([^;|]+)/)?.[1]);
  set("online_price", text.match(/\bONLINE PRICE:\s*([0-9.,]+)/)?.[1]);
  set("currency", text.match(/\bCURRENCY:\s*([A-Z]{3})\b/)?.[1]);
  set("availability", text.match(/\bAVAILABILITY:\s*([^;|]+)/)?.[1]);
  const toothCount = text.match(/\bZ\s*=\s*(\d+)\b/)?.[1] || text.match(/\b(\d+)[ -]?TOOTH\b/)?.[1];
  if (toothCount) set("tooth_count", toothCount);
  if (candidate.quantity && Number(candidate.quantity) > 0) set("quantity_in_assembly", String(Number(candidate.quantity)));
  if (schema.key === "clutch") {
    if (/FRICTION/.test(text)) attributes.plate_type = "friction";
    else if (/\b(STEEL|SEPARATOR)\b/.test(text)) attributes.plate_type = "steel";
    else if (/PLATE/.test(text)) attributes.plate_type = "clutch plate";
    if (/\bHUB\b/.test(text)) attributes.component_type = "hub";
    else if (/\bBUSH(?:ING)?\b/.test(text)) attributes.component_type = "bushing";
    else if (/\bSPRING|\bSPG\b/.test(text)) attributes.component_type = "spring";
    else if (/\bPLATE\b/.test(text)) attributes.component_type = "plate";
    const thickness = text.match(/\bT\s*=\s*(\d+(?:\.\d+)?)\b/)?.[1];
    if (thickness) attributes.thickness_mm = thickness;
    const dimensions = text.match(/\b(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)\b/);
    if (dimensions) { attributes.inner_diameter_mm = dimensions[1]; attributes.outer_diameter_mm = dimensions[2]; attributes.thickness_mm ||= dimensions[3]; }
    if (candidate.quantity && Number(candidate.quantity) > 0) attributes.quantity_in_assembly = String(Number(candidate.quantity));
  } else if (schema.key === "brake_system") {
    if (/\bFRONT\b/.test(text)) attributes.axle = "front";
    else if (/\bREAR\b/.test(text)) attributes.axle = "rear";
    const rotorDimensions = text.match(/\bD\s*=\s*(\d+(?:\.\d+)?)(?:\s*[-X]\s*(\d+(?:\.\d+)?))?\s*MM\b/);
    const diameter = rotorDimensions?.[1] || text.match(/(?:DIA(?:METER)?|Ø)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*MM/)?.[1];
    if (diameter) attributes.rotor_diameter_mm = diameter;
    if (rotorDimensions?.[2]) attributes.rotor_thickness_mm = rotorDimensions[2];
    const pistons = text.match(/\b(\d+)[ -]?PISTON\b/)?.[1];
    if (pistons) attributes.piston_count = pistons;
    if (/WEAR SENSOR/.test(text)) attributes.wear_sensor = "yes";
    if (/\bVENT(?:ED|ILATED)\b/.test(text)) attributes.rotor_style = "vented";
    else if (/\bSOLID\b/.test(text)) attributes.rotor_style = "solid";
    if (/\bDRILLED\b/.test(text)) attributes.rotor_style = `${attributes.rotor_style ? `${attributes.rotor_style}, ` : ""}drilled`;
    if (/\bSLOTTED\b/.test(text)) attributes.rotor_style = `${attributes.rotor_style ? `${attributes.rotor_style}, ` : ""}slotted`;
  } else if (schema.key === "lighting") {
    if (/\bLED\b/.test(text)) attributes.light_technology = "LED";
    else if (/\bHID|XENON\b/.test(text)) attributes.light_technology = "HID/Xenon";
    else if (/\bHALOGEN\b/.test(text)) attributes.light_technology = "Halogen";
    if (/\bADAPTIVE\b/.test(text)) attributes.adaptive = "yes";
  } else if (schema.key === "engine") {
    const displacement = text.match(/\b(\d+(?:\.\d+)?)\s*(CC|L)\b/)?.slice(1).join(" ");
    if (displacement) attributes.displacement = displacement;
  } else if (schema.key === "wheel") {
    const size = text.match(/\b(\d+(?:\.\d+)?)\s*X\s*(\d+(?:\.\d+)?)\b/);
    if (size) { attributes.width_in = size[1]; attributes.diameter_in = size[2]; }
    if (/\bFORGED\b/.test(text)) attributes.construction = "forged";
    else if (/\bCAST\b/.test(text)) attributes.construction = "cast";
    if (/\bTPMS\b/.test(text)) attributes.tpms = "yes";
  } else if (schema.key === "fastener") {
    const type = ["SCREW", "BOLT", "NUT", "WASHER", "RIVET", "CLIP", "STUD"].find((item) => new RegExp(`\\b${item}\\b`).test(text));
    if (type) attributes.fastener_type = titleCase(type);
    const metric = text.match(/\bM(\d+(?:\.\d+)?)(?:\s*X\s*(\d+(?:\.\d+)?))?(?:\s*X\s*(\d+(?:\.\d+)?))?/);
    if (metric) {
      attributes.thread_diameter_mm = metric[1];
      if (metric[3]) { attributes.thread_pitch_mm = metric[2]; attributes.length_mm = metric[3]; }
      else if (metric[2]) attributes.length_mm = metric[2];
    }
    const strength = text.match(/(?:^|[- ])(\d+\.\d+)(?:[- ]|$)/)?.[1];
    if (strength) attributes.strength_grade = strength;
    const materialGrade = text.match(/\b(A[24]-\d{2})\b/)?.[1];
    if (materialGrade) attributes.material_grade = materialGrade;
    if (/\bZNNIV\b|ZINC[- ]?NICKEL/.test(text)) attributes.coating = "Zinc-nickel";
    else if (/\bZINC(?:ED)?\b/.test(text)) attributes.coating = "Zinc";
    if (/FILLISTER/.test(text)) attributes.head_style = "Fillister";
    else if (/\bHEX\b/.test(text)) attributes.head_style = "Hex";
    else if (/\bFLANGE/.test(text)) attributes.head_style = "Flanged";
    if (/\bTORX\b/.test(text)) attributes.drive_type = "Torx";
    else if (/\bPHILLIPS\b/.test(text)) attributes.drive_type = "Phillips";
  } else if (["bearing", "seal"].includes(schema.key)) {
    if (dimension?.[3]) {
      attributes.inner_diameter_mm = dimension[1]; attributes.outer_diameter_mm = dimension[2];
      attributes[schema.key === "bearing" ? "width_mm" : "thickness_mm"] = dimension[3];
    }
    if (schema.key === "bearing") attributes.component_type = /BUSH/.test(text) ? "bushing" : "bearing";
    if (schema.key === "seal") attributes.seal_type = /O[- ]?RING/.test(text) ? "O-ring" : /GASKET/.test(text) ? "gasket" : "seal";
    if (/\bSEALED\b/.test(text)) attributes.sealed = "yes";
  } else if (schema.key === "filter") {
    attributes.filter_type = /\bOIL\b/.test(text) ? "oil" : /\bAIR\b/.test(text) ? "air" : /\bFUEL\b/.test(text) ? "fuel" : /CABIN|POLLEN/.test(text) ? "cabin" : "general";
  } else if (schema.key === "electrical") {
    attributes.component_type = /SENSOR/.test(text) ? "sensor" : /SWITCH/.test(text) ? "switch" : /RELAY/.test(text) ? "relay" : /REGULATOR/.test(text) ? "regulator" : /MODULE|CONTROL UNIT/.test(text) ? "module" : "electrical component";
  } else if (schema.key === "paint_chemical") {
    attributes.product_type = /TOUCH[- ]?UP|PENCIL|PAINT/.test(text) ? "touch-up paint" : /THREAD LOCK/.test(text) ? "thread locker" : /ADHESIVE/.test(text) ? "adhesive" : /SEALANT/.test(text) ? "sealant" : "chemical";
    const colorCode = text.match(/(?:^|[- ])(\d{3})(?:\b|$)/)?.[1];
    if (colorCode) attributes.color_code = colorCode;
    if (/MEDIUM[- ]?STRENGTH/.test(text)) attributes.strength = "medium";
  }
  return attributes;
}

function applyExtractedAttributes(update, candidate, evidenceDescription = "") {
  const attributes = inferCategoryAttributes(
    { ...candidate, family_name: update.familyName || candidate.family_name },
    [candidate.description_raw, evidenceDescription].filter(Boolean).join(" "),
  );
  return {
    ...update,
    extractedAttributesJson: JSON.stringify(attributes),
    extractedAttributeCount: Object.keys(attributes).length,
  };
}

async function loadVehicleMappingReferences() {
  try {
    await Promise.all([stat(VEHICLE_MASTER_PATH), stat(VEHICLE_ALIASES_PATH)]);
  } catch {
    return { loaded: false, reason: "Extract Vehicle Mapping ePID.xlsx to create the optional reference CSVs." };
  }
  return withConnection(async (connection) => {
    let mpsovAvailable = false;
    try { await stat(MPSOV_INBOX_PATH); mpsovAvailable = true; } catch { /* Extracted workbook references remain sufficient. */ }
    let mpsovStats = { rows: 0, unique_epids: 0, new_epids: 0, changed_epids: 0 };
    await connection.run("BEGIN TRANSACTION");
    try {
      await connection.run("DELETE FROM partmaster_vehicle_source_aliases");
      await connection.run("DELETE FROM partmaster_vehicle_master");
      await connection.run(
        `INSERT INTO partmaster_vehicle_master
         (epid, year, make_name, model_name, trim_name, vehicle_type, year_norm, make_norm, model_norm)
         SELECT trim(epid), trim("year"), trim("make"), trim(model), trim("trim"), trim(vehicle_type),
          upper(regexp_replace(trim("year"), '[^A-Za-z0-9]', '', 'g')),
          upper(regexp_replace(trim("make"), '[^A-Za-z0-9]', '', 'g')),
          upper(regexp_replace(trim(model), '[^A-Za-z0-9]', '', 'g'))
         FROM read_csv($path, header = true, all_varchar = true, normalize_names = false,
          quote = '"', escape = '"', strict_mode = true)`,
        { path: VEHICLE_MASTER_PATH },
      );
      await connection.run(
        `INSERT INTO partmaster_vehicle_source_aliases
         (epid, source, year, make_name, model_name, trim_name, year_norm, make_norm, model_norm)
         SELECT trim(epid), trim("source"), trim("year"), trim("make"), trim(model), trim("trim"),
          upper(regexp_replace(trim("year"), '[^A-Za-z0-9]', '', 'g')),
          upper(regexp_replace(trim("make"), '[^A-Za-z0-9]', '', 'g')),
          upper(regexp_replace(trim(model), '[^A-Za-z0-9]', '', 'g'))
         FROM read_csv($path, header = true, all_varchar = true, normalize_names = false,
          quote = '"', escape = '"', strict_mode = true)`,
        { path: VEHICLE_ALIASES_PATH },
      );
      if (mpsovAvailable) {
        const statsReader = await connection.runAndReadAll(
          `WITH source AS (
            SELECT trim(epid) AS epid, trim(make) AS make_name, trim(model) AS model_name,
             nullif(trim(submodel), '--') AS trim_name, trim(_year) AS year,
             nullif(trim(vehicle_type), '') AS vehicle_type, nullif(trim(motorcycle_type), '') AS motorcycle_type
            FROM read_csv($path, header = true, all_varchar = true, normalize_names = true,
             quote = '"', escape = '"', strict_mode = true) WHERE trim(epid) != ''
          ), unique_source AS (SELECT * FROM source QUALIFY row_number() OVER (PARTITION BY epid ORDER BY epid) = 1)
          SELECT (SELECT count(*) FROM source) AS rows, (SELECT count(*) FROM unique_source) AS unique_epids,
           count(*) FILTER (WHERE master.epid IS NULL) AS new_epids,
           count(*) FILTER (WHERE master.epid IS NOT NULL AND (
            coalesce(master.year, '') != coalesce(source.year, '') OR
            coalesce(master.make_name, '') != coalesce(source.make_name, '') OR
            coalesce(master.model_name, '') != coalesce(source.model_name, '') OR
            coalesce(master.trim_name, '') != coalesce(source.trim_name, '') OR
            coalesce(master.vehicle_type, '') != coalesce(source.vehicle_type, '')
            OR coalesce(master.motorcycle_type, '') != coalesce(source.motorcycle_type, '')
           )) AS changed_epids
          FROM unique_source source LEFT JOIN partmaster_vehicle_master master ON master.epid = source.epid`,
          { path: MPSOV_INBOX_PATH },
        );
        mpsovStats = statsReader.getRowObjectsJson()[0];
        await connection.run(
          `INSERT INTO partmaster_vehicle_master
           (epid, year, make_name, model_name, trim_name, vehicle_type, motorcycle_type, year_norm, make_norm, model_norm)
           SELECT trim(epid), trim(_year), trim(make), trim(model), nullif(trim(submodel), '--'),
            nullif(trim(vehicle_type), ''), nullif(trim(motorcycle_type), ''),
            upper(regexp_replace(trim(_year), '[^A-Za-z0-9]', '', 'g')),
            upper(regexp_replace(trim(make), '[^A-Za-z0-9]', '', 'g')),
            upper(regexp_replace(trim(model), '[^A-Za-z0-9]', '', 'g'))
           FROM read_csv($path, header = true, all_varchar = true, normalize_names = true,
            quote = '"', escape = '"', strict_mode = true)
           WHERE trim(epid) != '' QUALIFY row_number() OVER (PARTITION BY trim(epid) ORDER BY trim(epid)) = 1
           ON CONFLICT (epid) DO UPDATE SET year = excluded.year, make_name = excluded.make_name,
            model_name = excluded.model_name, trim_name = excluded.trim_name, vehicle_type = excluded.vehicle_type,
            motorcycle_type = excluded.motorcycle_type,
            year_norm = excluded.year_norm, make_norm = excluded.make_norm, model_norm = excluded.model_norm,
            loaded_at = now()`,
          { path: MPSOV_INBOX_PATH },
        );
        await connection.run(
          `INSERT INTO partmaster_vehicle_source_aliases
           (epid, source, year, make_name, model_name, trim_name, year_norm, make_norm, model_norm)
           SELECT trim(epid), 'MPSOV CSV', trim(_year), trim(make), trim(model), nullif(trim(submodel), '--'),
            upper(regexp_replace(trim(_year), '[^A-Za-z0-9]', '', 'g')),
            upper(regexp_replace(trim(make), '[^A-Za-z0-9]', '', 'g')),
            upper(regexp_replace(trim(model), '[^A-Za-z0-9]', '', 'g'))
           FROM read_csv($path, header = true, all_varchar = true, normalize_names = true,
            quote = '"', escape = '"', strict_mode = true) WHERE trim(epid) != ''
           ON CONFLICT DO NOTHING`,
          { path: MPSOV_INBOX_PATH },
        );
        await connection.run(
          `INSERT INTO partmaster_vehicle_source_aliases
           (epid, source, year, make_name, model_name, trim_name, year_norm, make_norm, model_norm)
           SELECT trim(epid), 'MPSOV Model+Submodel', trim(_year), trim(make), trim(model_submodel), nullif(trim(submodel), '--'),
            upper(regexp_replace(trim(_year), '[^A-Za-z0-9]', '', 'g')),
            upper(regexp_replace(trim(make), '[^A-Za-z0-9]', '', 'g')),
            upper(regexp_replace(trim(model_submodel), '[^A-Za-z0-9]', '', 'g'))
           FROM read_csv($path, header = true, all_varchar = true, normalize_names = true,
            quote = '"', escape = '"', strict_mode = true)
           WHERE trim(epid) != '' AND trim(model_submodel) != '' AND trim(model_submodel) != trim(model)
           ON CONFLICT DO NOTHING`,
          { path: MPSOV_INBOX_PATH },
        );
      }
      await connection.run("COMMIT");
    } catch (error) {
      await connection.run("ROLLBACK");
      throw error;
    }
    const reader = await connection.runAndReadAll(
      `SELECT (SELECT count(*) FROM partmaster_vehicle_master) AS vehicles,
       (SELECT count(*) FROM partmaster_vehicle_source_aliases) AS aliases`,
    );
    const counts = reader.getRowObjectsJson()[0];
    return { loaded: true, vehicles: counts.vehicles, aliases: counts.aliases, mpsov: mpsovAvailable ? mpsovStats : null };
  });
}

async function vehicleMappingStats() {
  return withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      `SELECT (SELECT count(*) FROM partmaster_vehicle_master) AS vehicles,
       (SELECT count(*) FROM partmaster_vehicle_source_aliases) AS aliases,
       (SELECT count(DISTINCT epid) FROM partmaster_vehicle_source_aliases) AS mapped_vehicles,
       (SELECT count(*) FROM partmaster_vehicle_source_aliases WHERE source LIKE 'MPSOV%') AS mpsov_aliases,
       (SELECT count(*) FROM partmaster_part_applications WHERE vehicle_motorcycle_type IS NOT NULL) AS mpsov_enriched_applications,
       (SELECT count(*) FROM partmaster_enrichment_candidates WHERE vehicle_motorcycle_type IS NOT NULL) AS mpsov_enriched_candidates,
       (SELECT max(loaded_at) FROM partmaster_vehicle_master) AS loaded_at`,
    );
    return reader.getRowObjectsJson()[0];
  });
}

async function backfillApplicationVehicleMappings() {
  return withConnection(async (connection) => {
    const beforeReader = await connection.runAndReadAll(
      "SELECT count(*) AS count FROM partmaster_part_applications WHERE vehicle_mapping_method IS NOT NULL",
    );
    const before = Number(beforeReader.getRowObjectsJson()[0].count);
    await connection.run(`
      UPDATE partmaster_part_applications AS applications SET
       vehicle_make = master.make_name, vehicle_model = master.model_name,
       vehicle_trim = nullif(master.trim_name, '--'), vehicle_type = master.vehicle_type,
       vehicle_motorcycle_type = master.motorcycle_type,
       vehicle_mapping_method = 'exact_epid', vehicle_mapping_confidence = 1
      FROM partmaster_vehicle_master AS master
      WHERE applications.epid = master.epid
       AND (applications.vehicle_mapping_method IS NULL OR applications.vehicle_motorcycle_type IS NULL)
    `);
    await connection.run(`
      UPDATE partmaster_enrichment_candidates AS candidates SET
       vehicle_year = master.year, vehicle_make = master.make_name, vehicle_model = master.model_name,
       vehicle_trim = nullif(master.trim_name, '--'), vehicle_type = master.vehicle_type,
       vehicle_motorcycle_type = master.motorcycle_type,
       vehicle_mapping_method = coalesce(candidates.vehicle_mapping_method, 'exact_epid'),
       vehicle_mapping_confidence = greatest(coalesce(candidates.vehicle_mapping_confidence, 0), 1)
      FROM partmaster_vehicle_master AS master
      WHERE candidates.epid = master.epid
    `);
    await connection.run(`
      WITH application_norm AS (
        SELECT applications.id,
         upper(regexp_replace(coalesce(applications.year, ''), '[^A-Za-z0-9]', '', 'g')) AS year_norm,
         upper(regexp_replace(coalesce(parts.manufacturer, ''), '[^A-Za-z0-9]', '', 'g')) AS make_norm,
         upper(regexp_replace(coalesce(applications.model, ''), '[^A-Za-z0-9]', '', 'g')) AS model_norm
        FROM partmaster_part_applications applications
        JOIN partmaster_canonical_parts parts ON parts.id = applications.part_id
        WHERE applications.epid IS NULL OR trim(applications.epid) = ''
      ), mapping_candidates AS (
        SELECT application_norm.id, master.epid FROM application_norm
        JOIN partmaster_vehicle_master master USING (year_norm, make_norm, model_norm)
        UNION
        SELECT application_norm.id, aliases.epid FROM application_norm
        JOIN partmaster_vehicle_source_aliases aliases USING (year_norm, make_norm, model_norm)
      ), unique_matches AS (
        SELECT id, min(epid) AS epid FROM mapping_candidates
        GROUP BY id HAVING count(DISTINCT epid) = 1
      )
      UPDATE partmaster_part_applications AS applications SET
       epid = matches.epid, vehicle_make = master.make_name, vehicle_model = master.model_name,
       vehicle_trim = nullif(master.trim_name, '--'), vehicle_type = master.vehicle_type,
       vehicle_motorcycle_type = master.motorcycle_type,
       vehicle_mapping_method = 'unique_vehicle_text_backfill', vehicle_mapping_confidence = .92
      FROM unique_matches AS matches
      JOIN partmaster_vehicle_master AS master ON master.epid = matches.epid
      WHERE applications.id = matches.id
    `);
    const afterReader = await connection.runAndReadAll(
      "SELECT count(*) AS count FROM partmaster_part_applications WHERE vehicle_mapping_method IS NOT NULL",
    );
    const after = Number(afterReader.getRowObjectsJson()[0].count);
    return { backfilled: Math.max(0, after - before), mappedApplications: after };
  });
}

async function lookupVehicleMapping({ epid, year, make, model }) {
  const exactEpid = String(epid || "").trim();
  return withConnection(async (connection) => {
    let matchedEpid = exactEpid;
    let method = exactEpid ? "exact_epid" : null;
    let confidence = exactEpid ? 1 : 0;
    if (!matchedEpid && year && make && model) {
      const yearNorm = normalizeApplicationValue(year);
      const makeNorm = normalizeApplicationValue(make);
      const modelNorm = normalizeApplicationValue(model);
      const candidateReader = await connection.runAndReadAll(
        `SELECT DISTINCT epid FROM (
          SELECT epid FROM partmaster_vehicle_master
          WHERE year_norm = $year AND make_norm = $make AND model_norm = $model
          UNION
          SELECT epid FROM partmaster_vehicle_source_aliases
          WHERE year_norm = $year AND make_norm = $make AND model_norm = $model
        ) matches LIMIT 2`,
        { year: yearNorm, make: makeNorm, model: modelNorm },
      );
      const candidates = candidateReader.getRowObjectsJson();
      if (candidates.length === 1) {
        matchedEpid = candidates[0].epid;
        method = "unique_vehicle_text";
        confidence = 0.92;
      }
    }
    if (!matchedEpid) return null;
    const reader = await connection.runAndReadAll(
      `SELECT master.epid, master.year, master.make_name, master.model_name, master.trim_name,
       master.vehicle_type, master.motorcycle_type, count(DISTINCT aliases.source) AS source_count,
       string_agg(DISTINCT aliases.source, ', ' ORDER BY aliases.source) AS sources
       FROM partmaster_vehicle_master master
       LEFT JOIN partmaster_vehicle_source_aliases aliases ON aliases.epid = master.epid
       WHERE master.epid = $epid
       GROUP BY master.epid, master.year, master.make_name, master.model_name, master.trim_name, master.vehicle_type, master.motorcycle_type`,
      { epid: matchedEpid },
    );
    const vehicle = reader.getRowObjectsJson()[0];
    return vehicle ? { ...vehicle, method, confidence } : null;
  });
}

function applyVehicleMapping(update, vehicle, candidate = {}) {
  if (!vehicle) return { ...update, epid: candidate.epid || update.epid || null };
  const mappingExplanation = `Vehicle mapping: ${vehicle.year} ${vehicle.make_name} ${vehicle.model_name}${vehicle.trim_name && vehicle.trim_name !== "--" ? ` ${vehicle.trim_name}` : ""} (${vehicle.method === "exact_epid" ? "exact ePID" : "unique text match"}).`;
  return {
    ...update,
    epid: vehicle.epid,
    vehicleYear: vehicle.year,
    vehicleMake: vehicle.make_name,
    vehicleModel: vehicle.model_name,
    vehicleTrim: vehicle.trim_name && vehicle.trim_name !== "--" ? vehicle.trim_name : null,
    vehicleType: vehicle.vehicle_type,
    vehicleMotorcycleType: vehicle.motorcycle_type,
    vehicleMappingMethod: vehicle.method,
    vehicleMappingConfidence: vehicle.confidence,
    fitmentExplanation: [update.fitmentExplanation, mappingExplanation].filter(Boolean).join(" "),
  };
}

function titleCase(value) {
  return String(value || "").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function featureState(text, positivePattern, negativePattern) {
  if (negativePattern?.test(text)) return "no";
  if (positivePattern.test(text)) return "yes";
  return "unknown";
}

function safeFeatureState(value, fallback = "unknown") {
  const normalized = String(value || fallback).toLowerCase();
  return ["yes", "no", "unknown"].includes(normalized) ? normalized : fallback;
}

function inferComponentScope(description, assembly) {
  const text = `${description || ""} ${assembly || ""}`.toUpperCase();
  if (/\b(MIRROR )?GLASS\b|MIRROR LENS/.test(text)) return "mirror_glass";
  if (/\b(COVER|CAP)\b/.test(text) && /MIRROR/.test(text)) return "mirror_cover";
  if (/\b(HOUSING|FRAME|BRACKET)\b/.test(text) && /MIRROR/.test(text)) return "mirror_housing";
  if (/\b(MOTOR|ACTUATOR)\b/.test(text)) return "motor_or_actuator";
  if (/\b(ASSY|ASSEMBLY|COMPLETE|COMP)\b/.test(text)) return "complete_assembly";
  return "component";
}

function inferFamilyName(description, assembly) {
  const descriptionText = String(description || "").toUpperCase();
  const assemblyText = String(assembly || "").toUpperCase();
  const rules = [
    ["Exterior Mirror", /\b(MIRROR|REARVIEW|REAR VIEW)\b/],
    ["Brake System", /\b(BRAKE|CALIPER|ROTOR|BRAKE DISC)\b/],
    ["Fastener / Hardware", /\b(SCREW|BOLT|NUT|WASHER|RIVET|CLIP|STUD|FASTENER)\b/],
    ["Bearing / Bushing", /\b(BEARING|BUSHING|BUSH)\b/],
    ["Seal / Gasket", /\b(SEAL|GASKET|O[- ]?RING)\b/],
    ["Filter", /\b(FILTER|STRAINER)\b/],
    ["Electrical / Sensor", /\b(SENSOR|SWITCH|RELAY|CONTROL UNIT|MODULE|ALTERNATOR|REGULATOR|CONDENSER)\b/],
    ["Headlight", /\b(HEADLAMP|HEADLIGHT)\b/],
    ["Tail Light", /\b(TAILLAMP|TAIL LIGHT|TAILLIGHT)\b/],
    ["Wheel", /\b(WHEEL|RIM|TIRE|TYRE)\b/],
    ["Clutch", /\bCLUTCH\b/],
    ["Suspension / Steering", /\b(SHOCK|STRUT|FORK|SWINGARM|STEERING|TIE ROD)\b/],
    ["Cooling / HVAC", /\b(RADIATOR|THERMOSTAT|COOLANT|COOLING|HEATER|HVAC|AIR CONDITION)\b/],
    ["Paint / Chemical", /\b(TOUCH[- ]?UP|PAINT|ADHESIVE|SEALANT|THREAD LOCK)\b/],
    ["Bumper", /\bBUMPER\b/], ["Door", /\bDOOR\b/],
    ["Engine", /\b(ENGINE|CYLINDER|PISTON|CRANKSHAFT|CAMSHAFT)\b/],
  ];
  // The item itself is more specific than the diagram it happens to appear in.
  // Only fall back to the assembly when the description has no recognizable family.
  const direct = rules.find(([, pattern]) => pattern.test(descriptionText));
  if (direct) return direct[0];
  const contextual = rules.find(([, pattern]) => pattern.test(assemblyText));
  if (contextual) return contextual[0];
  // A complete product description is not a category. Preserve a concise catalog
  // assembly when supplied; otherwise use an honest general bucket.
  const fallback = String(assembly || "").split(/[|,]/, 1)[0].trim();
  return fallback ? titleCase(fallback).slice(0, 160) : "General Part";
}

function extractOptionCodes(text) {
  const required = new Set();
  const excluded = new Set();
  for (const match of String(text || "").matchAll(/\b(?:OPTION|OPT|SA)\s*[:#-]?\s*([0-9][A-Z0-9]{2})\b/gi)) required.add(match[1].toUpperCase());
  for (const match of String(text || "").matchAll(/\b(?:WITHOUT|EXCEPT|NOT WITH)\s+(?:OPTION|OPT|SA)?\s*[:#-]?\s*([0-9][A-Z0-9]{2})\b/gi)) {
    required.delete(match[1].toUpperCase());
    excluded.add(match[1].toUpperCase());
  }
  return { required: [...required].join(", "), excluded: [...excluded].join(", ") };
}

function inferVariantIntelligence(candidate, onlineDescription = "") {
  const combined = `${candidate.description_raw || ""} ${onlineDescription || ""}`.toUpperCase();
  const location = inferLocation(candidate.description_raw, onlineDescription, candidate.assembly, candidate.item_number);
  const heated = featureState(combined, /\b(HEATED|HEATABLE|HTD)\b/, /\b(NON[- ]?HEATED|WITHOUT HEAT(?:ING)?)\b/);
  const autoDimming = featureState(combined, /\b(AUTO(?:MATIC)?[- ]?(?:DIM|DIMMING)|ANTI[- ]?DAZZLE|ELECTROCHROMIC)\b/, /\b(NON[- ]?(?:DIMMING|ELECTROCHROMIC)|WITHOUT AUTO[- ]?DIM)\b/);
  const powerFolding = featureState(combined, /\b(POWER|ELECTRIC)[- ]?(?:FOLD|FOLDING|FOLDABLE)|POWERFOLD\b/, /\b(MANUAL[- ]?FOLD|WITHOUT (?:POWER|ELECTRIC)[- ]?FOLD)\b/);
  const memory = featureState(combined, /\b(MEMORY|MEM)\b/, /\b(NO|WITHOUT|NON[- ]?)\s*MEMORY\b/);
  const blindSpot = featureState(combined, /\b(BLIND[- ]?SPOT|BSM|LANE[- ]?CHANGE WARNING)\b/, /\b(WITHOUT|NO)\s+(?:BLIND[- ]?SPOT|BSM|LANE[- ]?CHANGE WARNING)\b/);
  const camera = featureState(combined, /\b(CAMERA|SURROUND VIEW|360(?:°| DEGREE)?)\b/, /\b(WITHOUT|NO)\s+(?:CAMERA|SURROUND VIEW)\b/);
  const turnSignal = featureState(combined, /\b(TURN SIGNAL|INDICATOR|REPEATER)\b/, /\b(WITHOUT|NO)\s+(?:TURN SIGNAL|INDICATOR|REPEATER)\b/);
  const connector = combined.match(/\b(\d{1,2})[- ]?PIN\b/)?.[1] || "";
  const options = extractOptionCodes(combined);
  const componentScope = inferComponentScope(candidate.description_raw, candidate.assembly);
  const familyName = inferFamilyName(candidate.description_raw, candidate.assembly);
  const features = [
    location.side !== "Unknown" ? location.side : "",
    heated === "yes" ? "Heated" : heated === "no" ? "Non-heated" : "",
    autoDimming === "yes" ? "Auto-dimming" : autoDimming === "no" ? "Non-dimming" : "",
    powerFolding === "yes" ? "Power-folding" : "",
    memory === "yes" ? "Memory" : "",
    blindSpot === "yes" ? "Blind-spot" : "",
    camera === "yes" ? "Camera" : "",
    turnSignal === "yes" ? "Turn signal" : "",
    connector ? `${connector}-pin` : "",
  ].filter(Boolean);
  const variantSummary = features.length ? features.join(" · ") : titleCase(componentScope.replaceAll("_", " "));
  return {
    familyName,
    componentScope,
    side: location.side,
    position: location.position,
    heated,
    autoDimming,
    powerFolding,
    memory,
    blindSpot,
    camera,
    turnSignal,
    connectorPins: connector,
    requiredOptions: options.required,
    excludedOptions: options.excluded,
    variantSummary,
  };
}

function applyVariantIntelligence(update, intelligence, candidate) {
  const optionNote = intelligence.requiredOptions ? ` Requires options ${intelligence.requiredOptions}.` : "";
  const unknownMirrorFeatures = intelligence.familyName === "Exterior Mirror"
    ? [intelligence.heated, intelligence.autoDimming, intelligence.powerFolding, intelligence.memory, intelligence.blindSpot, intelligence.camera].filter((state) => state === "unknown").length
    : 0;
  const uncertaintyNote = unknownMirrorFeatures ? ` ${unknownMirrorFeatures} mirror feature${unknownMirrorFeatures === 1 ? " is" : "s are"} still unknown.` : "";
  return {
    ...update,
    familyName: intelligence.familyName,
    componentScope: intelligence.componentScope,
    side: intelligence.side !== "Unknown" ? intelligence.side : update.side,
    position: intelligence.position || update.position,
    heatedState: intelligence.heated,
    autoDimmingState: intelligence.autoDimming,
    powerFoldingState: intelligence.powerFolding,
    memoryState: intelligence.memory,
    blindSpotState: intelligence.blindSpot,
    cameraState: intelligence.camera,
    turnSignalState: intelligence.turnSignal,
    connectorPins: intelligence.connectorPins,
    requiredOptions: intelligence.requiredOptions,
    excludedOptions: intelligence.excludedOptions,
    variantSummary: intelligence.variantSummary,
    fitmentExplanation: `OEM ${candidate.part_number_raw || "number pending"} is associated with ${[candidate.year, candidate.manufacturer_raw, candidate.model, candidate.assembly].filter(Boolean).join(" · ")}.${optionNote}${uncertaintyNote}`,
  };
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
  const structuredAttributes = {};
  const addStructured = (name, value) => {
    const cleanName = cleanText(name).slice(0, 80);
    const cleanValue = cleanText(typeof value === "object" ? value?.name || value?.value : value).slice(0, 200);
    if (cleanName && cleanValue) structuredAttributes[cleanName] = cleanValue;
  };
  addStructured("brand", product?.brand);
  addStructured("color", product?.color);
  addStructured("material", product?.material);
  addStructured("model", product?.model);
  addStructured("category", product?.category);
  const additionalProperties = Array.isArray(product?.additionalProperty) ? product.additionalProperty : product?.additionalProperty ? [product.additionalProperty] : [];
  for (const property of additionalProperties) addStructured(property?.name || property?.propertyID, property?.value);
  const offers = Array.isArray(product?.offers) ? product.offers[0] : product?.offers;
  addStructured("online price", offers?.price);
  addStructured("currency", offers?.priceCurrency);
  addStructured("availability", String(offers?.availability || "").split("/").at(-1));
  const attributeText = Object.entries(structuredAttributes).map(([name, value]) => `${name}: ${value}`).join("; ");
  const visibleText = cleanText(html).slice(0, ENRICHMENT_MAX_PAGE_BYTES);
  const exactNumberFound = Boolean(knownNorm && normalizePartNumber(visibleText).includes(knownNorm));
  const structuredExact = Boolean(knownNorm && [product?.mpn, product?.sku, product?.productID].map(normalizePartNumber).includes(knownNorm));
  return { title, productNumber, description, attributeText, structuredAttributes, exactNumberFound, structuredExact, hasProductData: Boolean(product) };
}

function readHtmlAttribute(tag, name) {
  return cleanText(tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"))?.[1] || "");
}

function extractCatalogItems(html) {
  const items = [];
  const byPartNumber = new Set();
  const analyticsPattern = /\{item_id:\s*"((?:\\.|[^"])*)",\s*item_name:\s*"((?:\\.|[^"])*)",\s*index:\s*(\d+),\s*item_brand:\s*"((?:\\.|[^"])*)",\s*item_category:\s*"((?:\\.|[^"])*)",\s*price:\s*([\d.]+),\s*quantity:\s*([\d.]+)\}/g;
  for (const match of String(html || "").matchAll(analyticsPattern)) {
    const partNumber = match[1].replace(/\\"/g, '"').trim();
    if (!partNumber || byPartNumber.has(normalizePartNumber(partNumber))) continue;
    byPartNumber.add(normalizePartNumber(partNumber));
    items.push({
      partNumber,
      description: match[2].replace(/\\"/g, '"').trim(),
      itemNumber: match[3],
      brand: match[4].replace(/\\"/g, '"').trim(),
      price: match[6],
      quantity: match[7],
    });
  }
  if (items.length) return items;
  // MAX BMW catalog pages expose each row through an AddToCart call rather
  // than JSON-LD. One diagram page can therefore verify many OEM numbers.
  for (const match of String(html || "").matchAll(/AddToCart\('([^']+)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\)/gi)) {
    const partNumber = match[1].trim();
    if (!partNumber || byPartNumber.has(normalizePartNumber(partNumber))) continue;
    let description = match[3].replace(/\+/g, " ");
    try { description = decodeURIComponent(description); } catch { /* Preserve readable source text. */ }
    byPartNumber.add(normalizePartNumber(partNumber));
    items.push({ partNumber, description: cleanText(description), itemNumber: "", brand: "BMW", price: "", quantity: match[2].trim(), weight: match[4].trim() });
  }
  if (items.length) return items;
  for (const match of String(html || "").matchAll(/<form\b[^>]*action=["'][^"']*\/cart\/addoempart["'][^>]*>/gi)) {
    const tag = match[0];
    const partNumber = readHtmlAttribute(tag, "data-sku");
    if (!partNumber || byPartNumber.has(normalizePartNumber(partNumber))) continue;
    byPartNumber.add(normalizePartNumber(partNumber));
    items.push({
      partNumber,
      description: readHtmlAttribute(tag, "data-name"),
      itemNumber: "",
      brand: readHtmlAttribute(tag, "data-brand"),
      price: readHtmlAttribute(tag, "data-retail"),
      quantity: "",
    });
  }
  return items;
}

function missingValue(value) {
  return value == null || String(value).trim() === "";
}

function normalizedDescription(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

function numericValue(value) {
  const parsed = Number(String(value || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function matchCatalogItem(row, items) {
  const partNumber = normalizePartNumber(row.part_number || row.oem_part_number || row.code);
  if (partNumber) {
    const exactPart = items.find((item) => normalizePartNumber(item.partNumber) === partNumber);
    if (exactPart) return { item: exactPart, confidence: 0.99, reason: "Exact OEM part-number match on the source page." };
  }
  const description = normalizedDescription(row.part_name || row.description);
  if (!description) return { item: null, confidence: 0, reason: "The row has no part name to match against its source page." };
  const descriptionMatches = items.filter((item) => normalizedDescription(item.description) === description);
  if (descriptionMatches.length === 1) {
    const rowPrice = numericValue(row.msrp || row.price);
    const itemPrice = numericValue(descriptionMatches[0].price);
    const priceMatches = rowPrice == null || itemPrice == null || Math.abs(rowPrice - itemPrice) < 0.01;
    return {
      item: descriptionMatches[0],
      confidence: priceMatches ? 0.98 : 0.94,
      reason: priceMatches ? "Unique exact description match; price also agrees when available." : "Unique exact description match, but the price differs.",
    };
  }
  if (descriptionMatches.length > 1) {
    const rowPrice = numericValue(row.msrp || row.price);
    const priceMatches = rowPrice == null ? [] : descriptionMatches.filter((item) => {
      const itemPrice = numericValue(item.price);
      return itemPrice != null && Math.abs(rowPrice - itemPrice) < 0.01;
    });
    if (priceMatches.length === 1) return { item: priceMatches[0], confidence: 0.96, reason: "Description and price uniquely identify this catalog item." };
    return { item: null, confidence: 0.4, reason: `${descriptionMatches.length} catalog items share this description; manual review is required.` };
  }
  return { item: null, confidence: 0.2, reason: "No exact description or OEM-number match was found on the source page." };
}

function suggestedRowChanges(row, columns, item, sourceUrl) {
  const changes = {};
  const add = (column, value) => {
    if (columns.includes(column) && missingValue(row[column]) && !missingValue(value)) changes[column] = String(value);
  };
  add("part_number", item.partNumber);
  add("oem_part_number", item.partNumber);
  add("code", item.partNumber);
  add("part_name", item.description);
  add("description", item.description);
  add("brand", item.brand);
  add("manufacturer", item.brand);
  add("msrp", item.price ? `$${Number(item.price).toFixed(2)}` : "");
  add("price", item.price);
  add("quantity", item.quantity);
  add("qty", item.quantity);
  add("source", new URL(sourceUrl).hostname.replace(/^www\./, ""));
  return changes;
}

function suggestedVehicleChanges(row, columns, vehicle) {
  if (!vehicle) return {};
  const changes = {};
  const add = (column, value) => {
    if (columns.includes(column) && missingValue(row[column]) && !missingValue(value)) changes[column] = String(value);
  };
  add("epid", vehicle.epid);
  add("year", vehicle.year);
  add("brand", vehicle.make_name);
  add("make", vehicle.make_name);
  add("manufacturer", vehicle.make_name);
  add("model", vehicle.model_name);
  add("trim", vehicle.trim_name);
  add("vehicle_type", vehicle.vehicle_type);
  add("motorcycle_type", vehicle.motorcycle_type);
  return changes;
}

async function previewRowEnhancement(datasetId, rowId) {
  const context = await withConnection(async (connection) => {
    const dataset = await getDataset(connection, datasetId);
    const columns = await getColumns(connection, dataset.table_name);
    const reader = await connection.runAndReadAll(
      `SELECT * FROM ${quoteIdentifier(dataset.table_name)} WHERE _row_id = $rowId`,
      { rowId },
    );
    const row = reader.getRowObjectsJson()[0];
    if (!row) {
      const error = new Error("Local dataset row not found.");
      error.status = 404;
      throw error;
    }
    return { dataset, columns, row };
  });
  const vehicleMapping = await lookupVehicleMapping({
    epid: context.row.epid,
    year: context.row.year,
    make: context.row.brand || context.row.make || context.row.manufacturer,
    model: context.row.model || context.row.model_name,
  });
  const vehicleChanges = suggestedVehicleChanges(context.row, context.columns, vehicleMapping);
  const vehicleReason = vehicleMapping
    ? `Vehicle mapped by ${vehicleMapping.method === "exact_epid" ? "exact ePID" : "a unique exact year/make/model alias"} to ${vehicleMapping.year} ${vehicleMapping.make_name} ${vehicleMapping.model_name}.`
    : "No unique vehicle mapping was available; online enrichment can continue normally.";
  const sourceUrl = String(context.row.url || context.row.source_url || "").trim();
  if (!sourceUrl) return { ...context, sourceUrl: "", changes: vehicleChanges, confidence: vehicleMapping?.confidence || 0, reason: vehicleReason, vehicleMapping };
  if (!isSafeEvidenceUrl(sourceUrl)) return { ...context, sourceUrl, changes: vehicleChanges, confidence: vehicleMapping?.confidence || 0, reason: vehicleReason, vehicleMapping };
  let page;
  try {
    page = await getEvidencePage(sourceUrl);
  } catch (error) {
    if (!vehicleMapping) throw error;
    return {
      ...context,
      sourceUrl,
      changes: vehicleChanges,
      confidence: vehicleMapping.confidence,
      reason: `${vehicleReason} The online source could not be checked: ${error.message}`,
      vehicleMapping,
    };
  }
  const items = extractCatalogItems(page.html);
  const match = matchCatalogItem(context.row, items);
  const catalogChanges = match.item ? suggestedRowChanges(context.row, context.columns, match.item, page.finalUrl || sourceUrl) : {};
  const changes = { ...vehicleChanges, ...catalogChanges };
  const confidences = [
    Object.keys(vehicleChanges).length ? vehicleMapping?.confidence : null,
    Object.keys(catalogChanges).length ? match.confidence : null,
  ].filter((value) => value != null);
  return {
    ...context,
    sourceUrl: page.finalUrl || sourceUrl,
    pageTitle: extractPageEvidence(page.html, context.row.part_number).title,
    catalogItemCount: items.length,
    matchedItem: match.item,
    changes,
    confidence: confidences.length ? Math.min(...confidences) : Math.max(match.confidence, vehicleMapping?.confidence || 0),
    reason: [match.reason, vehicleMapping ? vehicleReason : null].filter(Boolean).join(" "),
    vehicleMapping,
  };
}

async function applyMissingRowChanges(dataset, columns, rowId, changes) {
  const validChanges = Object.entries(changes || {}).filter(([column]) => column !== "_row_id" && columns.includes(column));
  if (!validChanges.length) return 0;
  await withConnection(async (connection) => {
    const values = { rowId };
    const assignments = validChanges.map(([column, value], index) => {
      const key = `value${index}`;
      values[key] = value;
      return `${quoteIdentifier(column)} = CASE WHEN trim(coalesce(CAST(${quoteIdentifier(column)} AS VARCHAR), '')) = '' THEN $${key} ELSE ${quoteIdentifier(column)} END`;
    });
    await connection.run(
      `UPDATE ${quoteIdentifier(dataset.table_name)} SET ${assignments.join(", ")} WHERE _row_id = $rowId`,
      values,
    );
  });
  return validChanges.length;
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

async function getEvidencePage(url, { force = false } = {}) {
  const cached = force ? null : await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      `SELECT final_url, page_title, content_html, success, error_message
       FROM partmaster_page_cache
       WHERE source_url = $sourceUrl AND fetched_at >= current_timestamp - INTERVAL '7 days'`,
      { sourceUrl: url },
    );
    return reader.getRowObjectsJson()[0];
  });
  if (cached) {
    if (!cached.success) throw new Error(cached.error_message || "The cached source request failed.");
    return { html: cached.content_html || "", finalUrl: cached.final_url || url, cacheHit: true };
  }

  try {
    const page = await fetchEvidence(url);
    const title = extractPageEvidence(page.html, "").title;
    await withConnection(async (connection) => {
      const existingReader = await connection.runAndReadAll(
        "SELECT source_url FROM partmaster_page_cache WHERE source_url = $sourceUrl",
        { sourceUrl: url },
      );
      if (existingReader.getRowObjectsJson().length) {
        await connection.run(
          `UPDATE partmaster_page_cache SET final_url = $finalUrl, page_title = $title,
           content_html = $html, success = true, error_message = NULL, fetched_at = current_timestamp
           WHERE source_url = $sourceUrl`,
          { sourceUrl: url, finalUrl: page.finalUrl, title, html: page.html },
        );
      } else {
        await connection.run(
          `INSERT INTO partmaster_page_cache
           (source_url, final_url, page_title, content_html, success)
           VALUES ($sourceUrl, $finalUrl, $title, $html, true)`,
          { sourceUrl: url, finalUrl: page.finalUrl, title, html: page.html },
        );
      }
    });
    return { ...page, cacheHit: false };
  } catch (error) {
    await withConnection(async (connection) => {
      const existingReader = await connection.runAndReadAll(
        "SELECT source_url FROM partmaster_page_cache WHERE source_url = $sourceUrl",
        { sourceUrl: url },
      );
      if (existingReader.getRowObjectsJson().length) {
        await connection.run(
          `UPDATE partmaster_page_cache SET success = false, error_message = $error,
           content_html = NULL, fetched_at = current_timestamp WHERE source_url = $sourceUrl`,
          { sourceUrl: url, error: error.message },
        );
      } else {
        await connection.run(
          `INSERT INTO partmaster_page_cache (source_url, success, error_message)
           VALUES ($sourceUrl, false, $error)`,
          { sourceUrl: url, error: error.message },
        );
      }
    }).catch(() => {});
    throw error;
  }
}

function compatibilityListUrl(candidate) {
  const source = String(candidate.source_url || candidate.evidence_url || "");
  const partNumber = String(candidate.enriched_part_number || candidate.part_number_raw || "").trim();
  if (!partNumber) return "";
  try {
    const url = new URL(source);
    if (!url.hostname.toLowerCase().endsWith("hondapartshouse.com")) return "";
    const manufacturer = normalizeApplicationValue(candidate.manufacturer_norm || candidate.manufacturer_raw).toLowerCase().replace(/\s+/g, "-");
    if (!manufacturer) return "";
    return `${url.protocol}//${url.host}/oemparts/unitlist?id=${encodeURIComponent(manufacturer)}&assemid=${encodeURIComponent(partNumber)}`;
  } catch {
    return "";
  }
}

function parseCompatibilityList(html, baseUrl) {
  const results = [];
  const seen = new Set();
  for (const match of String(html || "").matchAll(/<a\b[^>]*href=["']([^"']*\/oemparts\/a\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = cleanText(match[2]);
    const parsed = label.match(/^((?:19|20)\d{2})\s+(.+?)\s+-\s+(.+)$/i);
    if (!parsed) continue;
    let evidenceUrl;
    try { evidenceUrl = new URL(match[1], baseUrl).toString(); } catch { continue; }
    if (seen.has(evidenceUrl)) continue;
    seen.add(evidenceUrl);
    const modelText = parsed[2].trim();
    const modelCode = modelText.match(/\(([^()]+)\)\s*$/)?.[1]?.trim() || "";
    const model = modelCode ? modelText.replace(/\s*\([^()]+\)\s*$/, "").trim() : modelText;
    results.push({ year: parsed[1], model, modelCode, assembly: parsed[3].trim(), evidenceUrl });
  }
  return results;
}

function parseCompatibilityText(text) {
  const results = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)) {
    const parsed = cleanText(match[1]).match(/^((?:19|20)\d{2})\s+(.+?)\s+-\s+(.+)$/i);
    if (!parsed || seen.has(match[2])) continue;
    seen.add(match[2]);
    const modelText = parsed[2].trim();
    const modelCode = modelText.match(/\(([^()]+)\)\s*$/)?.[1]?.trim() || "";
    const model = modelCode ? modelText.replace(/\s*\([^()]+\)\s*$/, "").trim() : modelText;
    results.push({ year: parsed[1], model, modelCode, assembly: parsed[3].trim(), evidenceUrl: match[2] });
  }
  return results;
}

async function enrichCandidateCompatibility(candidate, { force = false, sourceUrl = "", compatibilityText = "" } = {}) {
  const generatedUrl = compatibilityListUrl(candidate);
  let unitListUrl = String(sourceUrl || generatedUrl).trim();
  if (unitListUrl) {
    try {
      const parsedUrl = new URL(unitListUrl);
      if (!parsedUrl.hostname.toLowerCase().endsWith("hondapartshouse.com") || !parsedUrl.pathname.startsWith("/oemparts/unitlist")) {
        throw new Error("Use a Honda Parts House compatibility-list URL.");
      }
    } catch (error) {
      if (error.message === "Use a Honda Parts House compatibility-list URL.") throw error;
      throw new Error("The compatibility-list URL is invalid.");
    }
  }
  if (!unitListUrl || !candidate.manufacturer_norm) return { sourceUrl: unitListUrl, added: 0, total: 0, compatibility: [] };
  const partNumberNorm = normalizePartNumber(candidate.enriched_part_number || candidate.part_number_raw);
  const current = await withConnection(async (connection) => {
    const partReader = await connection.runAndReadAll(
      `SELECT id FROM partmaster_canonical_parts
       WHERE manufacturer_norm = $manufacturer AND part_number_norm = $partNumber`,
      { manufacturer: candidate.manufacturer_norm, partNumber: partNumberNorm },
    );
    const partId = partReader.getRowObjectsJson()[0]?.id;
    if (!partId) return { partId: null, rows: [] };
    const rowsReader = await connection.runAndReadAll(
      `SELECT id, year, model, model_code, assembly, evidence_url, confidence
       FROM partmaster_part_compatibility WHERE part_id = $partId
       ORDER BY year, model, model_code, assembly`,
      { partId },
    );
    return { partId, rows: rowsReader.getRowObjectsJson() };
  });
  if (!current.partId) return { sourceUrl: unitListUrl, added: 0, total: 0, compatibility: [] };
  if (current.rows.length && !force) return { sourceUrl: unitListUrl, added: 0, total: current.rows.length, compatibility: current.rows };

  let parsed = parseCompatibilityText(compatibilityText);
  if (!parsed.length) {
    const page = await getEvidencePage(unitListUrl, { force });
    parsed = parseCompatibilityList(page.html, page.finalUrl || unitListUrl);
  }
  if (!parsed.length) throw new Error("The compatibility page did not expose a readable vehicle list. It may be temporarily protected or unavailable.");
  let added = 0;
  await withConnection(async (connection) => {
    for (const item of parsed) {
      const compatibilityKey = [current.partId, item.year, item.model, item.modelCode, item.assembly, item.evidenceUrl]
        .map(normalizeApplicationValue).join(":");
      const reader = await connection.runAndReadAll(
        "SELECT id FROM partmaster_part_compatibility WHERE compatibility_key = $compatibilityKey",
        { compatibilityKey },
      );
      if (reader.getRowObjectsJson().length) continue;
      await connection.run(
        `INSERT INTO partmaster_part_compatibility
         (id, compatibility_key, part_id, year, model, model_code, assembly, source_url, evidence_url, confidence)
         VALUES ($id, $compatibilityKey, $partId, $year, $model, $modelCode, $assembly, $sourceUrl, $evidenceUrl, 0.95)`,
        {
          id: randomUUID(), compatibilityKey, partId: current.partId, year: item.year, model: item.model,
          modelCode: item.modelCode || null, assembly: item.assembly, sourceUrl: unitListUrl, evidenceUrl: item.evidenceUrl,
        },
      );
      added += 1;
    }
  });
  const compatibility = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      `SELECT id, year, model, model_code, assembly, evidence_url, confidence
       FROM partmaster_part_compatibility WHERE part_id = $partId
       ORDER BY year, model, model_code, assembly`,
      { partId: current.partId },
    );
    return reader.getRowObjectsJson();
  });
  return { sourceUrl: unitListUrl, added, total: compatibility.length, compatibility };
}

function scheduleCompatibilityEnrichment(candidate) {
  const key = `${candidate.manufacturer_norm || ""}:${normalizePartNumber(candidate.enriched_part_number || candidate.part_number_raw)}`;
  if (!key.endsWith(":") && !queuedCompatibilityKeys.has(key)) {
    queuedCompatibilityKeys.add(key);
    compatibilityQueue.push({ key, candidate });
  }
  if (compatibilityWorkerRunning || !compatibilityQueue.length) return;
  compatibilityWorkerRunning = true;
  setImmediate(async () => {
    while (compatibilityQueue.length && !shuttingDown) {
      const item = compatibilityQueue.shift();
      try { await enrichCandidateCompatibility(item.candidate); } catch { /* Main enrichment remains valid if a catalog blocks this optional lookup. */ }
      queuedCompatibilityKeys.delete(item.key);
    }
    compatibilityWorkerRunning = false;
  });
}

async function ensurePartFamily(connection, candidate) {
  const familyName = candidate.family_name || inferFamilyName(candidate.enriched_description || candidate.description_raw, candidate.assembly);
  const familyKey = normalizeApplicationValue(familyName);
  const reader = await connection.runAndReadAll(
    `SELECT id FROM partmaster_part_families
     WHERE manufacturer_norm = $manufacturer AND family_key = $familyKey`,
    { manufacturer: candidate.manufacturer_norm, familyKey },
  );
  let familyId = reader.getRowObjectsJson()[0]?.id;
  if (!familyId) {
    familyId = randomUUID();
    await connection.run(
      `INSERT INTO partmaster_part_families
       (id, manufacturer_norm, family_key, family_name, category)
       VALUES ($id, $manufacturer, $familyKey, $familyName, $category)`,
      {
        id: familyId,
        manufacturer: candidate.manufacturer_norm,
        familyKey,
        familyName,
        category: candidate.assembly || null,
      },
    );
  }
  return { familyId, familyName };
}

async function recordFieldEvidence(connection, { partId, fieldName, fieldValue, sourceUrl, sourceTitle = null, sourceMethod = "source", confidence = 0, accepted = false }) {
  const value = String(fieldValue || "").trim();
  const url = String(sourceUrl || "").trim();
  if (!partId || !fieldName || !value || !url) return;
  const reader = await connection.runAndReadAll(
    `SELECT id, confidence FROM partmaster_field_evidence
     WHERE part_id = $partId AND field_name = $fieldName AND field_value = $fieldValue AND source_url = $sourceUrl`,
    { partId, fieldName, fieldValue: value, sourceUrl: url },
  );
  const existing = reader.getRowObjectsJson()[0];
  if (existing) {
    await connection.run(
      `UPDATE partmaster_field_evidence SET source_title = coalesce($sourceTitle, source_title),
       source_method = $sourceMethod, confidence = greatest(coalesce(confidence, 0), $confidence),
       accepted = accepted OR $accepted, observed_at = current_timestamp WHERE id = $id`,
      { id: existing.id, sourceTitle, sourceMethod, confidence, accepted },
    );
  } else {
    await connection.run(
      `INSERT INTO partmaster_field_evidence
       (id, part_id, field_name, field_value, source_url, source_title, source_method, confidence, accepted)
       VALUES ($id, $partId, $fieldName, $fieldValue, $sourceUrl, $sourceTitle, $sourceMethod, $confidence, $accepted)`,
      { id: randomUUID(), partId, fieldName, fieldValue: value, sourceUrl: url, sourceTitle, sourceMethod, confidence, accepted },
    );
  }
}

async function syncVariantAttributes(connection, partId, candidate) {
  const categoryAttributes = inferCategoryAttributes(candidate, candidate.enriched_description || candidate.description_raw);
  const attributes = {
    side: candidate.side || "Unknown",
    heated: candidate.heated_state || "unknown",
    auto_dimming: candidate.auto_dimming_state || "unknown",
    power_folding: candidate.power_folding_state || "unknown",
    memory: candidate.memory_state || "unknown",
    blind_spot: candidate.blind_spot_state || "unknown",
    camera: candidate.camera_state || "unknown",
    turn_signal: candidate.turn_signal_state || "unknown",
    connector_pins: candidate.connector_pins || "unknown",
    required_options: candidate.required_options || "none_known",
    excluded_options: candidate.excluded_options || "none_known",
    ...categoryAttributes,
  };
  for (const [name, value] of Object.entries(attributes)) {
    if (["", "unknown", "none_known"].includes(String(value || "").trim().toLowerCase())) continue;
    const reader = await connection.runAndReadAll(
      "SELECT id, confidence FROM partmaster_variant_attributes WHERE part_id = $partId AND attribute_name = $name",
      { partId, name },
    );
    const existing = reader.getRowObjectsJson()[0];
    if (existing) {
      if (Number(candidate.confidence || 0) >= Number(existing.confidence || 0)) {
        await connection.run(
          `UPDATE partmaster_variant_attributes SET attribute_value = $value, confidence = $confidence,
           evidence_url = $evidenceUrl, source_method = $method, updated_at = current_timestamp WHERE id = $id`,
          {
            id: existing.id,
            value,
            confidence: candidate.confidence || 0,
            evidenceUrl: candidate.evidence_url || candidate.source_url || null,
            method: candidate.decision === "approve" ? "human_review" : "deterministic_and_online",
          },
        );
      }
    } else {
      await connection.run(
        `INSERT INTO partmaster_variant_attributes
         (id, part_id, attribute_name, attribute_value, confidence, evidence_url, source_method)
         VALUES ($id, $partId, $name, $value, $confidence, $evidenceUrl, $method)`,
        {
          id: randomUUID(),
          partId,
          name,
          value,
          confidence: candidate.confidence || 0,
          evidenceUrl: candidate.evidence_url || candidate.source_url || null,
          method: candidate.decision === "approve" ? "human_review" : "deterministic_and_online",
        },
      );
    }
    await recordFieldEvidence(connection, {
      partId,
      fieldName: name,
      fieldValue: value,
      sourceUrl: candidate.evidence_url || candidate.source_url,
      sourceMethod: candidate.decision === "approve" ? "human_review" : "deterministic_and_online",
      confidence: candidate.confidence || 0,
      accepted: true,
    });
  }
}

async function promoteCandidate(connection, candidate, verificationStatus) {
  const partNumber = candidate.enriched_part_number || candidate.part_number_raw;
  const partNumberNorm = normalizePartNumber(partNumber);
  if (!partNumberNorm || !candidate.manufacturer_norm) return null;
  const { familyId } = await ensurePartFamily(connection, candidate);
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
       (id, manufacturer, manufacturer_norm, part_number, part_number_norm, family_id, component_scope,
        variant_summary, description, confidence, verification_status, evidence_url, verified_at)
       VALUES ($id, $manufacturer, $manufacturerNorm, $partNumber, $partNumberNorm, $familyId, $componentScope,
        $variantSummary, $description, $confidence, $status, $evidenceUrl, current_timestamp)`,
      {
        id: partId,
        manufacturer: candidate.manufacturer_raw || candidate.manufacturer_norm,
        manufacturerNorm: candidate.manufacturer_norm,
        partNumber,
        partNumberNorm,
        familyId,
        componentScope: candidate.component_scope || "component",
        variantSummary: candidate.variant_summary || null,
        description: candidate.enriched_description || candidate.description_raw || null,
        confidence: candidate.confidence || 0,
        status: verificationStatus,
        evidenceUrl: candidate.evidence_url || candidate.source_url || null,
      },
    );
  } else {
    await connection.run(
      `UPDATE partmaster_canonical_parts SET
         family_id = coalesce($familyId, family_id),
         component_scope = coalesce($componentScope, component_scope),
         variant_summary = CASE WHEN $confidence >= coalesce(confidence, 0) THEN coalesce($variantSummary, variant_summary) ELSE variant_summary END,
         description = CASE WHEN $confidence >= coalesce(confidence, 0) THEN coalesce($description, description) ELSE description END,
         confidence = greatest(coalesce(confidence, 0), $confidence),
         verification_status = CASE WHEN $confidence >= coalesce(confidence, 0) THEN $status ELSE verification_status END,
         evidence_url = CASE WHEN $confidence >= coalesce(confidence, 0) THEN coalesce($evidenceUrl, evidence_url) ELSE evidence_url END,
         verified_at = current_timestamp,
         updated_at = current_timestamp
       WHERE id = $id`,
      {
        id: partId,
        familyId,
        componentScope: candidate.component_scope || null,
        variantSummary: candidate.variant_summary || null,
        confidence: candidate.confidence || 0,
        description: candidate.enriched_description || candidate.description_raw || null,
        status: verificationStatus,
        evidenceUrl: candidate.evidence_url || candidate.source_url || null,
      },
    );
  }
  const evidenceUrl = candidate.evidence_url || candidate.source_url;
  const evidenceMethod = candidate.decision === "approve" ? "human_review" : "deterministic_and_online";
  await recordFieldEvidence(connection, { partId, fieldName: "part_number", fieldValue: partNumber, sourceUrl: evidenceUrl, sourceTitle: candidate.evidence_title, sourceMethod: evidenceMethod, confidence: candidate.confidence || 0, accepted: true });
  await recordFieldEvidence(connection, { partId, fieldName: "description", fieldValue: candidate.enriched_description || candidate.description_raw, sourceUrl: evidenceUrl, sourceTitle: candidate.evidence_title, sourceMethod: evidenceMethod, confidence: candidate.confidence || 0, accepted: true });
  await syncVariantAttributes(connection, partId, candidate);

  const applicationKey = [
    partId,
    candidate.epid,
    candidate.vehicle_year || candidate.year,
    candidate.vehicle_model || candidate.model,
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
    epid: candidate.epid || null,
    year: candidate.vehicle_year || candidate.year || null,
    model: candidate.vehicle_model || candidate.model || null,
    vehicleMake: candidate.vehicle_make || null,
    vehicleModel: candidate.vehicle_model || null,
    vehicleTrim: candidate.vehicle_trim || null,
    vehicleType: candidate.vehicle_type || null,
    vehicleMotorcycleType: candidate.vehicle_motorcycle_type || null,
    vehicleMappingMethod: candidate.vehicle_mapping_method || null,
    vehicleMappingConfidence: candidate.vehicle_mapping_confidence || null,
    assembly: candidate.assembly || null,
    itemNumber: candidate.item_number || null,
    side: candidate.side || "Unknown",
    position: candidate.position || null,
    locationNotes: candidate.location_notes || null,
    quantity: candidate.quantity || null,
    sourceUrl: candidate.source_url || null,
    evidenceUrl: candidate.evidence_url || null,
    requiredOptions: candidate.required_options || null,
    excludedOptions: candidate.excluded_options || null,
    fitmentExplanation: candidate.fitment_explanation || null,
    confidence: candidate.confidence || 0,
  };
  if (applicationId) {
    await connection.run(
      `UPDATE partmaster_part_applications SET
       epid = $epid, year = $year, model = $model, vehicle_make = $vehicleMake,
       vehicle_model = $vehicleModel, vehicle_trim = $vehicleTrim, vehicle_type = $vehicleType,
       vehicle_motorcycle_type = $vehicleMotorcycleType,
       vehicle_mapping_method = $vehicleMappingMethod, vehicle_mapping_confidence = $vehicleMappingConfidence,
       assembly = $assembly, item_number = $itemNumber,
       side = $side, position = $position, location_notes = $locationNotes, quantity = $quantity,
       source_url = $sourceUrl, evidence_url = $evidenceUrl, required_options = $requiredOptions,
       excluded_options = $excludedOptions, fitment_explanation = $fitmentExplanation, confidence = $confidence,
       updated_at = current_timestamp WHERE id = $id`,
      {
        id: applicationValues.id,
        epid: applicationValues.epid,
        year: applicationValues.year,
        model: applicationValues.model,
        vehicleMake: applicationValues.vehicleMake,
        vehicleModel: applicationValues.vehicleModel,
        vehicleTrim: applicationValues.vehicleTrim,
        vehicleType: applicationValues.vehicleType,
        vehicleMotorcycleType: applicationValues.vehicleMotorcycleType,
        vehicleMappingMethod: applicationValues.vehicleMappingMethod,
        vehicleMappingConfidence: applicationValues.vehicleMappingConfidence,
        assembly: applicationValues.assembly,
        itemNumber: applicationValues.itemNumber,
        side: applicationValues.side,
        position: applicationValues.position,
        locationNotes: applicationValues.locationNotes,
        quantity: applicationValues.quantity,
        sourceUrl: applicationValues.sourceUrl,
        evidenceUrl: applicationValues.evidenceUrl,
        requiredOptions: applicationValues.requiredOptions,
        excludedOptions: applicationValues.excludedOptions,
        fitmentExplanation: applicationValues.fitmentExplanation,
        confidence: applicationValues.confidence,
      },
    );
  } else {
    await connection.run(
      `INSERT INTO partmaster_part_applications
       (id, application_key, part_id, dataset_id, source_row_id, epid, year, model, vehicle_make, vehicle_model,
        vehicle_trim, vehicle_type, vehicle_motorcycle_type, vehicle_mapping_method, vehicle_mapping_confidence, assembly, item_number, side, position,
        location_notes, quantity, source_url, evidence_url, required_options, excluded_options, fitment_explanation, confidence)
       VALUES ($id, $applicationKey, $partId, $datasetId, $sourceRowId, $epid, $year, $model, $vehicleMake, $vehicleModel,
        $vehicleTrim, $vehicleType, $vehicleMotorcycleType, $vehicleMappingMethod, $vehicleMappingConfidence, $assembly, $itemNumber, $side,
        $position, $locationNotes, $quantity, $sourceUrl, $evidenceUrl, $requiredOptions, $excludedOptions,
        $fitmentExplanation, $confidence)`,
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

function offlineDatasetExpressions(columns) {
  return {
    manufacturer: firstColumnExpression(columns, ["brand", "make", "manufacturer"]),
    year: firstColumnExpression(columns, ["year"]),
    model: firstColumnExpression(columns, ["model", "model_name"]),
    assembly: firstColumnExpression(columns, ["category", "part_category", "assembly_category", "diagram_title"]),
    itemNumber: firstColumnExpression(columns, ["pos", "item_number", "reference_number"]),
    partNumber: firstColumnExpression(columns, ["part_number", "code", "oem_part_number"]),
    description: firstColumnExpression(columns, ["part_name", "description"]),
    quantity: firstColumnExpression(columns, ["quantity", "qty", "quatity"]),
    sourceUrl: firstColumnExpression(columns, ["url", "source_url"]),
  };
}

async function ensurePipelineDatasets(importMissing) {
  const sourceFiles = (await listInboxDataFiles({ partsOnly: true })).map((file) => file.name);
  if (importMissing) {
    const imported = await withConnection(async (connection) => {
      const reader = await connection.runAndReadAll("SELECT DISTINCT source_file FROM partmaster_datasets");
      return new Set(reader.getRowObjectsJson().map((row) => row.source_file));
    });
    for (const filename of sourceFiles) {
      if (imported.has(filename)) continue;
      const importJobId = randomUUID();
      importJobs.set(importJobId, { id: importJobId, filename, status: "queued", createdAt: new Date().toISOString() });
      await importDataset(importJobId, { filename, name: filename.replace(/\.[^.]+$/, "") });
      const result = importJobs.get(importJobId);
      if (result.status !== "complete") throw new Error(`Could not import ${filename}: ${result.error || "unknown import error"}`);
    }
  }
  return withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      `SELECT * EXCLUDE (rank) FROM (
       SELECT datasets.*, row_number() OVER (PARTITION BY source_file ORDER BY imported_at DESC) AS rank
       FROM partmaster_datasets datasets WHERE source_file IN (${sourceFiles.map(quoteString).join(", ") || "''"})
      ) latest WHERE rank = 1 ORDER BY source_file`,
    );
    return reader.getRowObjectsJson();
  });
}

async function scanDatasetOffline(jobId, dataset) {
  return withConnection(async (connection) => {
    const columns = await getColumns(connection, dataset.table_name);
    const fields = offlineDatasetExpressions(columns);
    const manufacturerKey = `upper(regexp_replace(coalesce(manufacturer_raw, ''), '[^A-Za-z0-9]', '', 'g'))`;
    const manufacturerNorm = `CASE ${manufacturerKey}
      WHEN 'HARVEYDAVISON' THEN 'HARLEYDAVIDSON' WHEN 'HARLEYDAVISON' THEN 'HARLEYDAVIDSON'
      ELSE ${manufacturerKey} END`;
    const partNorm = "upper(regexp_replace(coalesce(part_number, ''), '[^A-Za-z0-9]', '', 'g'))";
    const sourceRows = `SELECT _row_id AS source_row_id, ${fields.manufacturer} AS manufacturer_raw,
      ${fields.partNumber} AS part_number, ${fields.description} AS description, ${fields.year} AS year,
      ${fields.model} AS model, ${fields.assembly} AS assembly, ${fields.itemNumber} AS item_number,
      ${fields.quantity} AS quantity, ${fields.sourceUrl} AS source_url
      FROM ${quoteIdentifier(dataset.table_name)}`;
    const validCondition = `manufacturer_norm IN ('BMW','HONDA','KTM','KAWASAKI','SUZUKI','YAMAHA','HARLEYDAVIDSON')
      AND length(part_number_norm) BETWEEN 3 AND 50`;
    const countsReader = await connection.runAndReadAll(
      `WITH source_rows AS (${sourceRows}), normalized AS (
       SELECT *, ${manufacturerNorm} AS manufacturer_norm, ${partNorm} AS part_number_norm FROM source_rows)
       SELECT count(*) AS rows, count(*) FILTER (WHERE NOT (${validCondition})) AS invalid_rows FROM normalized`,
    );
    const counts = countsReader.getRowObjectsJson()[0];
    await connection.run("DELETE FROM partmaster_offline_part_sources WHERE dataset_id = $datasetId", { datasetId: dataset.id });
    const totalRows = Number(counts.rows || 0);
    const chunkSize = Math.max(50_000, Math.min(1_000_000, Number(process.env.PARTMASTER_SCAN_CHUNK_ROWS) || 500_000));
    for (let chunkStart = 0; chunkStart < totalRows; chunkStart += chunkSize) {
      const statusReader = await connection.runAndReadAll("SELECT status FROM partmaster_pipeline_jobs WHERE id = $jobId", { jobId });
      if (statusReader.getRowObjectsJson()[0]?.status !== "running") return { ...counts, stopped: true };
      const chunkEnd = Math.min(totalRows, chunkStart + chunkSize);
      await connection.run(
        `INSERT INTO partmaster_offline_part_sources
         (part_key, dataset_id, source_row_id, manufacturer, manufacturer_norm, part_number, part_number_norm,
          description, year, model, assembly, item_number, quantity, source_url, occurrence_count)
         WITH source_rows AS (${sourceRows} WHERE _row_id > $chunkStart AND _row_id <= $chunkEnd), normalized AS (
          SELECT *, ${manufacturerNorm} AS manufacturer_norm, ${partNorm} AS part_number_norm FROM source_rows
         ), valid AS (SELECT * FROM normalized WHERE ${validCondition})
         SELECT manufacturer_norm || ':' || part_number_norm AS part_key, $datasetId,
          min(source_row_id), arg_max(manufacturer_raw, length(coalesce(manufacturer_raw, ''))),
          manufacturer_norm, arg_max(part_number, length(coalesce(part_number, ''))), part_number_norm,
          arg_max(description, length(coalesce(description, ''))), arg_max(year, length(coalesce(year, ''))),
          arg_max(model, length(coalesce(model, ''))), arg_max(assembly, length(coalesce(assembly, ''))),
          arg_max(item_number, length(coalesce(item_number, ''))), arg_max(quantity, length(coalesce(quantity, ''))),
          arg_max(source_url, length(coalesce(source_url, ''))), count(*)
         FROM valid GROUP BY manufacturer_norm, part_number_norm
         ON CONFLICT (part_key, dataset_id) DO UPDATE SET
          occurrence_count = partmaster_offline_part_sources.occurrence_count + excluded.occurrence_count`,
        { datasetId: dataset.id, chunkStart, chunkEnd },
      );
      await connection.run(
        "UPDATE partmaster_pipeline_jobs SET scanned_rows = scanned_rows + $rows, current_dataset = $dataset WHERE id = $jobId",
        { jobId, rows: chunkEnd - chunkStart, dataset: dataset.name },
      );
    }
    const uniqueReader = await connection.runAndReadAll(
      "SELECT count(*) AS unique_parts FROM partmaster_offline_part_sources WHERE dataset_id = $datasetId",
      { datasetId: dataset.id },
    );
    await connection.run(
      `INSERT INTO partmaster_source_processing
       (dataset_id, raw_rows, usable_rows, invalid_rows, unique_parts, scanned_at)
       VALUES ($datasetId, $rawRows, $usableRows, $invalidRows, $uniqueParts, current_timestamp)
       ON CONFLICT (dataset_id) DO UPDATE SET raw_rows = excluded.raw_rows, usable_rows = excluded.usable_rows,
        invalid_rows = excluded.invalid_rows, unique_parts = excluded.unique_parts, scanned_at = excluded.scanned_at`,
      {
        datasetId: dataset.id, rawRows: counts.rows,
        usableRows: Math.max(0, Number(counts.rows) - Number(counts.invalid_rows)),
        invalidRows: counts.invalid_rows, uniqueParts: uniqueReader.getRowObjectsJson()[0].unique_parts,
      },
    );
    await connection.run(
      `UPDATE partmaster_pipeline_jobs SET invalid_rows = invalid_rows + $invalidRows,
       current_dataset = $dataset WHERE id = $jobId`,
      { jobId, invalidRows: counts.invalid_rows, dataset: dataset.name },
    );
    return counts;
  });
}

async function rebuildOfflineCatalog(jobId) {
  return withConnection(async (connection) => {
    // A source file can be re-imported under a new dataset id. Keep only its newest
    // imported version so repeated imports do not inflate occurrence/duplicate totals.
    await connection.run(
      `DELETE FROM partmaster_offline_part_sources WHERE dataset_id IN (
       SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY source_file ORDER BY imported_at DESC) AS version_rank
        FROM partmaster_datasets
       ) dataset_versions WHERE version_rank > 1)`,
    );
    await connection.run("DELETE FROM partmaster_offline_parts");
    await connection.run(
      `INSERT INTO partmaster_offline_parts
       (part_key, manufacturer, manufacturer_norm, part_number, part_number_norm, description,
        occurrence_count, dataset_count, application_count, source_page_count, best_source_url)
       SELECT part_key, arg_max(manufacturer, length(coalesce(manufacturer, ''))), manufacturer_norm,
        arg_max(part_number, length(coalesce(part_number, ''))), part_number_norm,
        arg_max(description, length(coalesce(description, ''))), sum(occurrence_count), count(*),
        sum(occurrence_count), count(DISTINCT nullif(trim(source_url), '')),
        arg_max(source_url, length(coalesce(source_url, '')))
       FROM partmaster_offline_part_sources GROUP BY part_key, manufacturer_norm, part_number_norm`,
    );
    await connection.run("DELETE FROM partmaster_offline_source_pages");
    await connection.run(
      `INSERT INTO partmaster_offline_source_pages
       (source_url, source_host, part_count, occurrence_count, priority_score)
       SELECT source_url, lower(regexp_extract(source_url, '^https?://([^/]+)', 1)), count(DISTINCT part_key),
        sum(occurrence_count), ln(1 + sum(occurrence_count)) * count(DISTINCT part_key)
       FROM partmaster_offline_part_sources
       WHERE source_url IS NOT NULL AND trim(source_url) != '' AND regexp_matches(source_url, '^https?://')
       GROUP BY source_url`,
    );
    const reader = await connection.runAndReadAll(
      `SELECT (SELECT count(*) FROM partmaster_offline_parts) AS unique_parts,
       (SELECT count(*) FROM partmaster_offline_source_pages) AS source_pages,
       (SELECT coalesce(sum(occurrence_count), 0) FROM partmaster_offline_parts) AS occurrences`,
    );
    const stats = reader.getRowObjectsJson()[0];
    await connection.run(
      `UPDATE partmaster_pipeline_jobs SET unique_parts = $uniqueParts, source_pages = $sourcePages,
       duplicates_removed = greatest(0, total_rows - invalid_rows - $uniqueParts), phase = 'extracting_attributes'
       WHERE id = $jobId`,
      { jobId, uniqueParts: stats.unique_parts, sourcePages: stats.source_pages },
    );
    return stats;
  });
}

async function extractOfflineAttributes(jobId) {
  while (!shuttingDown) {
    const state = await withConnection(async (connection) => {
      const jobReader = await connection.runAndReadAll("SELECT status FROM partmaster_pipeline_jobs WHERE id = $jobId", { jobId });
      if (jobReader.getRowObjectsJson()[0]?.status !== "running") return null;
      const reader = await connection.runAndReadAll(
        `SELECT parts.*, coalesce((SELECT arg_max(sources.description, length(coalesce(sources.description, '')))
         FROM partmaster_offline_part_sources sources WHERE sources.part_key = parts.part_key), parts.description) AS local_description
         FROM partmaster_offline_parts parts WHERE attribute_status = 'pending'
         ORDER BY occurrence_count DESC LIMIT 1000`,
      );
      return reader.getRowObjectsJson();
    });
    if (!state?.length) break;
    await withConnection(async (connection) => {
      await connection.run("BEGIN TRANSACTION");
      try {
        for (const part of state) {
          const candidate = { description_raw: part.local_description || part.description, assembly: "", part_number_raw: part.part_number, manufacturer_raw: part.manufacturer };
          const intelligence = inferVariantIntelligence(candidate);
          const attributes = inferCategoryAttributes({ ...candidate, family_name: intelligence.familyName }, candidate.description_raw);
          let existingAttributes = {};
          try { existingAttributes = JSON.parse(part.extracted_attributes_json || "{}"); } catch { /* Replace malformed legacy JSON safely. */ }
          const mergedAttributes = { ...attributes, ...existingAttributes };
          await connection.run(
            `UPDATE partmaster_offline_parts SET family_name = $familyName, component_scope = $componentScope,
             side = $side, position = $position, extracted_attributes_json = $attributes,
             extracted_attribute_count = $attributeCount, confidence = $confidence,
             attribute_status = 'complete', updated_at = current_timestamp WHERE part_key = $partKey`,
            {
              partKey: part.part_key, familyName: intelligence.familyName, componentScope: intelligence.componentScope,
              side: intelligence.side, position: intelligence.position || null, attributes: JSON.stringify(mergedAttributes),
              attributeCount: Object.keys(mergedAttributes).length, confidence: Math.max(Number(part.confidence || 0), part.description ? 0.7 : 0.5),
            },
          );
        }
        await connection.run("COMMIT");
      } catch (error) {
        await connection.run("ROLLBACK"); throw error;
      }
      await connection.run(
        `UPDATE partmaster_pipeline_jobs SET
         attribute_processed = (SELECT count(*) FROM partmaster_offline_parts WHERE attribute_status = 'complete'),
         attributed_parts = (SELECT count(*) FROM partmaster_offline_parts WHERE extracted_attribute_count > 0),
         attribute_facts = (SELECT coalesce(sum(extracted_attribute_count), 0) FROM partmaster_offline_parts)
         WHERE id = $jobId`, { jobId },
      );
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  }
}

async function checkOfflineSourcePages(jobId, budget, datasetIds = []) {
  const datasetScope = datasetIds.length
    ? `AND EXISTS (SELECT 1 FROM partmaster_offline_part_sources scoped_sources
       WHERE scoped_sources.source_url = partmaster_offline_source_pages.source_url
        AND scoped_sources.dataset_id IN (${datasetIds.map(quoteString).join(", ")}))`
    : "";
  await withConnection((connection) => connection.run(
    "UPDATE partmaster_pipeline_jobs SET phase = 'checking_shared_sources' WHERE id = $jobId", { jobId },
  ));
  for (let index = 0; index < budget && !shuttingDown; index += 1) {
    const context = await withConnection(async (connection) => {
      const jobReader = await connection.runAndReadAll("SELECT status FROM partmaster_pipeline_jobs WHERE id = $jobId", { jobId });
      if (jobReader.getRowObjectsJson()[0]?.status !== "running") return null;
      const pageReader = await connection.runAndReadAll(
        `SELECT * FROM partmaster_offline_source_pages WHERE status = 'pending' ${datasetScope}
         ORDER BY priority_score DESC LIMIT 1`,
      );
      const page = pageReader.getRowObjectsJson()[0];
      if (!page) return null;
      await connection.run("UPDATE partmaster_offline_source_pages SET status = 'checking' WHERE source_url = $url", { url: page.source_url });
      return page;
    });
    if (!context) break;
    try {
      const page = await getEvidencePage(context.source_url);
      const items = extractCatalogItems(page.html);
      const byNumber = new Map(items.map((item) => [normalizePartNumber(item.partNumber), item]));
      const parts = await withConnection(async (connection) => {
        const reader = await connection.runAndReadAll(
          `SELECT DISTINCT parts.* FROM partmaster_offline_parts parts
           JOIN partmaster_offline_part_sources sources ON sources.part_key = parts.part_key
           WHERE sources.source_url = $url LIMIT 10000`, { url: context.source_url },
        );
        return reader.getRowObjectsJson();
      });
      let verified = 0;
      await withConnection(async (connection) => {
        await connection.run("BEGIN TRANSACTION");
        try {
          for (const part of parts) {
            const item = byNumber.get(part.part_number_norm);
            if (!item) continue;
            const description = item.description || part.description;
            const candidate = { description_raw: description, part_number_raw: part.part_number, manufacturer_raw: part.manufacturer };
            const familyName = inferFamilyName(description, "");
            const attributes = inferCategoryAttributes({ ...candidate, family_name: familyName }, description);
            let existingAttributes = {};
            try { existingAttributes = JSON.parse(part.extracted_attributes_json || "{}"); } catch { /* Replace malformed legacy JSON safely. */ }
            const mergedAttributes = { ...existingAttributes, ...attributes };
            await connection.run(
              `UPDATE partmaster_offline_parts SET description = coalesce(nullif($description, ''), description),
               family_name = $familyName, extracted_attributes_json = $attributes,
               extracted_attribute_count = $attributeCount, confidence = .98, online_status = 'verified',
               updated_at = current_timestamp WHERE part_key = $partKey`,
              { partKey: part.part_key, description, familyName, attributes: JSON.stringify(mergedAttributes), attributeCount: Object.keys(mergedAttributes).length },
            );
            verified += 1;
          }
          await connection.run("COMMIT");
        } catch (error) { await connection.run("ROLLBACK"); throw error; }
        await connection.run(
          `UPDATE partmaster_offline_source_pages SET status = $status, verified_parts = $verified,
           checked_at = current_timestamp, error_message = NULL WHERE source_url = $url`,
          { url: context.source_url, status: items.length ? "checked" : "no_structured_items", verified },
        );
        await connection.run(
          `UPDATE partmaster_pipeline_jobs SET online_checked = online_checked + 1,
           online_verified_parts = online_verified_parts + $verified WHERE id = $jobId`, { jobId, verified },
        );
      });
      if (!page.cacheHit) await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
    } catch (error) {
      await withConnection(async (connection) => {
        await connection.run(
          `UPDATE partmaster_offline_source_pages SET status = 'failed', error_message = $error,
           checked_at = current_timestamp WHERE source_url = $url`,
          { url: context.source_url, error: error.message },
        );
        await connection.run("UPDATE partmaster_pipeline_jobs SET online_checked = online_checked + 1 WHERE id = $jobId", { jobId });
      });
    }
  }
}

async function runFullPipeline(jobId) {
  if (activePipelineJobs.has(jobId)) return;
  activePipelineJobs.add(jobId);
  try {
    const job = await withConnection(async (connection) => {
      await connection.run(
        `UPDATE partmaster_pipeline_jobs SET status = 'running', phase = CASE WHEN mode = 'online_only' THEN 'checking_shared_sources' ELSE 'importing_sources' END,
         started_at = coalesce(started_at, current_timestamp), completed_at = NULL, last_error = NULL WHERE id = $jobId`, { jobId },
      );
      const reader = await connection.runAndReadAll("SELECT * FROM partmaster_pipeline_jobs WHERE id = $jobId", { jobId });
      return reader.getRowObjectsJson()[0];
    });
    if (job.mode === "online_only") {
      const baseline = await withConnection(async (connection) => {
        const reader = await connection.runAndReadAll(
          `SELECT * FROM partmaster_pipeline_jobs
           WHERE id != $jobId AND mode = 'full' AND status = 'completed'
           ORDER BY completed_at DESC LIMIT 1`, { jobId },
        );
        return reader.getRowObjectsJson()[0];
      });
      if (!baseline) throw new Error("Run the full local pipeline once before continuing online checks.");
      await withConnection((connection) => connection.run(
        `UPDATE partmaster_pipeline_jobs SET total_rows = $totalRows, scanned_rows = $scannedRows,
         invalid_rows = $invalidRows, unique_parts = $uniqueParts, duplicates_removed = $duplicatesRemoved,
         attribute_processed = $attributeProcessed, attributed_parts = $attributedParts,
         attribute_facts = $attributeFacts, source_pages = $sourcePages WHERE id = $jobId`,
        {
          jobId, totalRows: baseline.total_rows, scannedRows: baseline.scanned_rows,
          invalidRows: baseline.invalid_rows, uniqueParts: baseline.unique_parts,
          duplicatesRemoved: baseline.duplicates_removed, attributeProcessed: baseline.attribute_processed,
          attributedParts: baseline.attributed_parts, attributeFacts: baseline.attribute_facts,
          sourcePages: baseline.source_pages,
        },
      ));
      await extractOfflineAttributes(jobId);
      const scopedDatasetIds = String(job.dataset_ids || "").split(",").filter(Boolean);
      await checkOfflineSourcePages(jobId, Math.max(0, Number(job.online_budget || 0) - Number(job.online_checked || 0)), scopedDatasetIds);
      await withConnection((connection) => connection.run(
        `UPDATE partmaster_pipeline_jobs SET status = 'completed', phase = 'completed',
         attributed_parts = (SELECT count(*) FROM partmaster_offline_parts WHERE extracted_attribute_count > 0),
         attribute_facts = (SELECT coalesce(sum(extracted_attribute_count), 0) FROM partmaster_offline_parts),
         online_verified_parts = (SELECT count(*) FROM partmaster_offline_parts WHERE online_status = 'verified'),
         completed_at = current_timestamp WHERE id = $jobId AND status = 'running'`, { jobId },
      ));
      return;
    }
    let datasets = await ensurePipelineDatasets(Boolean(job.import_missing));
    const selectedIds = new Set(String(job.dataset_ids || "").split(",").filter(Boolean));
    if (selectedIds.size) datasets = datasets.filter((dataset) => selectedIds.has(dataset.id));
    if (!datasets.length) throw new Error("No imported source datasets are available for the full pipeline.");
    const totalRows = datasets.reduce((sum, dataset) => sum + Number(dataset.row_count || 0), 0);
    await withConnection((connection) => connection.run(
      `UPDATE partmaster_pipeline_jobs SET phase = 'normalizing_and_deduplicating', total_rows = $totalRows,
       scanned_rows = 0, invalid_rows = 0, attributed_parts = 0, attribute_facts = 0,
       online_checked = 0, online_verified_parts = 0 WHERE id = $jobId`, { jobId, totalRows },
    ));
    for (const dataset of datasets) {
      const running = await withConnection(async (connection) => {
        const reader = await connection.runAndReadAll("SELECT status FROM partmaster_pipeline_jobs WHERE id = $jobId", { jobId });
        return reader.getRowObjectsJson()[0]?.status === "running";
      });
      if (!running) return;
      await scanDatasetOffline(jobId, dataset);
    }
    await rebuildOfflineCatalog(jobId);
    await extractOfflineAttributes(jobId);
    await checkOfflineSourcePages(jobId, Number(job.online_budget || 0));
    await withConnection((connection) => connection.run(
      `UPDATE partmaster_pipeline_jobs SET status = 'completed', phase = 'completed', current_dataset = NULL,
       attributed_parts = (SELECT count(*) FROM partmaster_offline_parts WHERE extracted_attribute_count > 0),
       attribute_facts = (SELECT coalesce(sum(extracted_attribute_count), 0) FROM partmaster_offline_parts),
       completed_at = current_timestamp WHERE id = $jobId AND status = 'running'`, { jobId },
    ));
  } catch (error) {
    await withConnection((connection) => connection.run(
      "UPDATE partmaster_pipeline_jobs SET status = 'failed', phase = 'failed', last_error = $error, completed_at = current_timestamp WHERE id = $jobId",
      { jobId, error: friendlyDataError(error) },
    )).catch(() => {});
  } finally {
    activePipelineJobs.delete(jobId);
  }
}

function scheduleFullPipeline(jobId) {
  setImmediate(() => runFullPipeline(jobId));
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
    const epid = firstColumnExpression(columns, ["epid", "e_pid"]);
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
          ${sourceUrl} AS source_url,
          ${epid} AS epid
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
            assembly, item_number, part_number_raw, part_number_norm, description_raw, quantity, source_url, epid)
           VALUES ($id, $jobId, $datasetId, $sourceRowId, $manufacturerRaw, $manufacturerNorm, $year, $model,
            $assembly, $itemNumber, $partNumberRaw, $partNumberNorm, $descriptionRaw, $quantity, $sourceUrl, $epid)`,
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
            epid: candidate.epid || null,
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

async function findExistingVariantConflicts(candidate, result) {
  if (!candidate.manufacturer_norm || !candidate.part_number_norm) return [];
  const existing = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      `SELECT attributes.attribute_name, attributes.attribute_value
       FROM partmaster_canonical_parts parts
       JOIN partmaster_variant_attributes attributes ON attributes.part_id = parts.id
       WHERE parts.manufacturer_norm = $manufacturer AND parts.part_number_norm = $partNumber
         AND attributes.attribute_name IN
           ('heated', 'auto_dimming', 'power_folding', 'memory', 'blind_spot', 'camera', 'turn_signal', 'connector_pins')`,
      { manufacturer: candidate.manufacturer_norm, partNumber: candidate.part_number_norm },
    );
    return Object.fromEntries(reader.getRowObjectsJson().map((row) => [row.attribute_name, row.attribute_value]));
  });
  const proposed = {
    heated: result.heatedState,
    auto_dimming: result.autoDimmingState,
    power_folding: result.powerFoldingState,
    memory: result.memoryState,
    blind_spot: result.blindSpotState,
    camera: result.cameraState,
    turn_signal: result.turnSignalState,
    connector_pins: result.connectorPins,
  };
  const labels = {
    heated: "heated",
    auto_dimming: "auto-dimming",
    power_folding: "power-folding",
    memory: "memory",
    blind_spot: "blind-spot",
    camera: "camera",
    turn_signal: "turn-signal",
    connector_pins: "connector-pin",
  };
  return Object.entries(proposed).flatMap(([name, value]) => {
    const current = String(existing[name] || "unknown");
    const next = String(value || "unknown");
    if (["", "unknown", "none_known"].includes(current) || ["", "unknown", "none_known"].includes(next) || current === next) return [];
    return [`${labels[name]} is already ${current}, but this source indicates ${next}`];
  });
}

async function processEnrichmentCandidate(candidate, threshold) {
  const localLocation = inferLocation(candidate.description_raw, candidate.assembly, candidate.item_number);
  const vehicleMapping = await lookupVehicleMapping({
    epid: candidate.epid,
    year: candidate.year,
    make: candidate.manufacturer_raw,
    model: candidate.model,
  });
  let update = applyVehicleMapping(applyVariantIntelligence({
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
  }, inferVariantIntelligence(candidate), candidate), vehicleMapping, candidate);
  update = applyExtractedAttributes(update, candidate);

  if (!candidate.source_url) {
    if (!candidate.part_number_norm) update.status = "not_found";
    return update;
  }

  let html;
  let finalUrl;
  try {
    ({ html, finalUrl } = await getEvidencePage(candidate.source_url));
  } catch (error) {
    if (!vehicleMapping) throw error;
    update.decision = `Vehicle mapping was saved, but the online part source could not be checked: ${error.message}`;
    update.status = candidate.part_number_norm ? "needs_review" : "not_found";
    return update;
  }
  const evidence = extractPageEvidence(html, candidate.part_number_raw);
  const evidenceLocation = inferLocation(evidence.description, evidence.title);
  update = applyVehicleMapping(applyVariantIntelligence({
    ...update,
    enrichedPartNumber: candidate.part_number_raw || evidence.productNumber || null,
    enrichedDescription: evidence.description || candidate.description_raw || null,
    side: evidenceLocation.side !== "Unknown" ? evidenceLocation.side : localLocation.side,
    position: evidenceLocation.position || localLocation.position || (candidate.item_number ? `Position ${candidate.item_number}` : null),
    evidenceUrl: finalUrl,
    evidenceTitle: evidence.title || null,
  }, inferVariantIntelligence(candidate, `${evidence.description} ${evidence.attributeText}`), candidate), vehicleMapping, candidate);
  update = applyExtractedAttributes(update, candidate, `${evidence.description} ${evidence.attributeText}`);

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
  if (update.status === "enriched") {
    const variantConflicts = await findExistingVariantConflicts(candidate, update);
    if (variantConflicts.length) {
      update.status = "conflict";
      update.confidence = Math.min(update.confidence, 0.4);
      update.decision = `Variant conflict for this exact OEM number: ${variantConflicts.join("; ")}. Confirm the equipment before promotion.`;
    }
  }
  return update;
}

async function checkCanonicalPart(partId, { threshold = 0.94, force = false } = {}) {
  const context = await withConnection(async (connection) => {
    const partReader = await connection.runAndReadAll(
      "SELECT * FROM partmaster_canonical_parts WHERE id = $id",
      { id: partId },
    );
    const part = partReader.getRowObjectsJson()[0];
    if (!part) {
      const error = new Error("Canonical part not found.");
      error.status = 404;
      throw error;
    }
    const candidateReader = await connection.runAndReadAll(
      `SELECT * FROM partmaster_enrichment_candidates
       WHERE manufacturer_norm = $manufacturer AND part_number_norm = $partNumber
        AND source_url IS NOT NULL AND trim(source_url) != ''
       ORDER BY CASE WHEN evidence_url IS NOT NULL THEN 0 ELSE 1 END,
        confidence DESC NULLS LAST, processed_at DESC NULLS LAST LIMIT 1`,
      { manufacturer: part.manufacturer_norm, partNumber: part.part_number_norm },
    );
    return { part, candidate: candidateReader.getRowObjectsJson()[0] };
  });
  if (!context.candidate) {
    return { status: "no_source", updated: false, message: "No saved source URL is available for this part number.", part: context.part };
  }
  const page = await getEvidencePage(context.candidate.source_url, { force });
  const evidence = extractPageEvidence(page.html, context.part.part_number);
  const catalogItem = extractCatalogItems(page.html)
    .find((item) => normalizePartNumber(item.partNumber) === context.part.part_number_norm);
  const exactFound = Boolean(catalogItem || evidence.structuredExact || evidence.exactNumberFound);
  if (!exactFound) {
    return {
      status: "not_found",
      updated: false,
      confidence: 0,
      message: "The saved source page did not confirm this exact OEM number.",
      evidenceUrl: page.finalUrl,
      evidenceTitle: evidence.title,
      part: context.part,
    };
  }
  const confidence = catalogItem || evidence.structuredExact
    ? 0.98
    : pageTitleMatchesContext(context.candidate, evidence.title) ? 0.96 : 0.9;
  const description = catalogItem?.description || evidence.description || context.part.description;
  const location = inferLocation(description, context.candidate.assembly, evidence.title);
  const checked = applyVariantIntelligence({
    side: location.side,
    position: location.position,
    familyName: context.candidate.family_name,
    componentScope: context.candidate.component_scope,
    confidence,
    evidenceUrl: page.finalUrl,
  }, inferVariantIntelligence(context.candidate, description), context.candidate);
  const updated = confidence >= Math.max(0.8, Math.min(1, Number(threshold) || 0.94));
  const fieldsUpdated = [];
  if (updated) {
    if (description && description !== context.part.description) fieldsUpdated.push("description");
    if (page.finalUrl !== context.part.evidence_url) fieldsUpdated.push("evidence");
    if (confidence > Number(context.part.confidence || 0)) fieldsUpdated.push("confidence");
    const inferredAttributes = inferCategoryAttributes({ ...context.candidate, family_name: checked.familyName }, description);
    fieldsUpdated.push(...Object.keys(inferredAttributes));
  }
  const refreshed = await withConnection(async (connection) => {
    if (updated) {
      await connection.run(
        `UPDATE partmaster_canonical_parts SET description = coalesce(nullif($description, ''), description),
         confidence = greatest(coalesce(confidence, 0), $confidence), verification_status = 'online_verified',
         evidence_url = $evidenceUrl, verified_at = current_timestamp, updated_at = current_timestamp
         WHERE id = $id`,
        { id: partId, description, confidence, evidenceUrl: page.finalUrl },
      );
      await recordFieldEvidence(connection, { partId, fieldName: "part_number", fieldValue: context.part.part_number, sourceUrl: page.finalUrl, sourceTitle: evidence.title, sourceMethod: "online_exact_match", confidence, accepted: true });
      await recordFieldEvidence(connection, { partId, fieldName: "description", fieldValue: description, sourceUrl: page.finalUrl, sourceTitle: evidence.title, sourceMethod: "online_exact_match", confidence, accepted: true });
      await syncVariantAttributes(connection, partId, {
        ...context.candidate,
        side: checked.side,
        heated_state: checked.heatedState,
        auto_dimming_state: checked.autoDimmingState,
        power_folding_state: checked.powerFoldingState,
        memory_state: checked.memoryState,
        blind_spot_state: checked.blindSpotState,
        camera_state: checked.cameraState,
        turn_signal_state: checked.turnSignalState,
        connector_pins: checked.connectorPins,
        required_options: checked.requiredOptions,
        excluded_options: checked.excludedOptions,
        confidence,
        evidence_url: page.finalUrl,
      });
    }
    const partReader = await connection.runAndReadAll("SELECT * FROM partmaster_canonical_parts WHERE id = $id", { id: partId });
    const attributeReader = await connection.runAndReadAll(
      "SELECT attribute_name, attribute_value FROM partmaster_variant_attributes WHERE part_id = $id ORDER BY attribute_name",
      { id: partId },
    );
    return { part: partReader.getRowObjectsJson()[0], attributes: attributeReader.getRowObjectsJson() };
  });
  return {
    status: updated ? "verified" : "review",
    updated,
    confidence,
    message: updated
      ? "Exact OEM number verified. Available description and meaningful attributes were refreshed."
      : "The number appears on the page, but the evidence is not strong enough to update automatically.",
    evidenceUrl: page.finalUrl,
    evidenceTitle: evidence.title,
    cacheHit: Boolean(page.cacheHit),
    fieldsUpdated: [...new Set(fieldsUpdated)],
    ...refreshed,
  };
}

async function refreshAutopilotJob(connection, jobId) {
  const reader = await connection.runAndReadAll(
    `SELECT count(*) AS queued_count,
     count(*) FILTER (WHERE status NOT IN ('pending', 'processing', 'deferred_budget')) AS processed_count,
     count(*) FILTER (WHERE status = 'verified') AS verified_count,
     count(*) FILTER (WHERE status = 'review') AS review_count,
     count(*) FILTER (WHERE status = 'no_source') AS no_source_count,
     count(*) FILTER (WHERE status = 'not_found') AS not_found_count,
     count(*) FILTER (WHERE status = 'failed') AS failed_count
     FROM partmaster_autopilot_items WHERE job_id = $jobId`, { jobId },
  );
  const counts = reader.getRowObjectsJson()[0];
  await connection.run(
    `UPDATE partmaster_autopilot_jobs SET queued_count = $queued, processed_count = $processed,
     verified_count = $verified, review_count = $review, no_source_count = $noSource,
     not_found_count = $notFound, failed_count = $failed WHERE id = $jobId`,
    { jobId, queued: counts.queued_count, processed: counts.processed_count, verified: counts.verified_count, review: counts.review_count, noSource: counts.no_source_count, notFound: counts.not_found_count, failed: counts.failed_count },
  );
  return counts;
}

async function autopilotCompatibility(partId) {
  const candidate = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      `SELECT candidates.* FROM partmaster_canonical_parts parts
       JOIN partmaster_enrichment_candidates candidates
        ON candidates.manufacturer_norm = parts.manufacturer_norm AND candidates.part_number_norm = parts.part_number_norm
       WHERE parts.id = $partId AND candidates.source_url IS NOT NULL
       ORDER BY candidates.confidence DESC NULLS LAST, candidates.processed_at DESC NULLS LAST LIMIT 1`, { partId },
    );
    return reader.getRowObjectsJson()[0];
  });
  if (!candidate || !compatibilityListUrl(candidate)) return { checked: false, added: 0 };
  try {
    const result = await enrichCandidateCompatibility(candidate);
    return { checked: true, added: Number(result.added || 0), total: Number(result.total || 0) };
  } catch (error) {
    return { checked: true, added: 0, error: error.message };
  }
}

async function runAutopilotJob(jobId) {
  if (activeAutopilotJobs.has(jobId)) return;
  activeAutopilotJobs.add(jobId);
  try {
    await withConnection((connection) => connection.run(
      `UPDATE partmaster_autopilot_jobs SET status = 'running', started_at = coalesce(started_at, current_timestamp),
       completed_at = NULL, last_error = NULL WHERE id = $jobId AND status IN ('queued', 'running')`, { jobId },
    ));
    while (!shuttingDown) {
      const state = await withConnection(async (connection) => {
        const jobReader = await connection.runAndReadAll("SELECT * FROM partmaster_autopilot_jobs WHERE id = $jobId", { jobId });
        const job = jobReader.getRowObjectsJson()[0];
        if (job?.status === "queued") {
          await connection.run("UPDATE partmaster_autopilot_jobs SET status = 'running', started_at = coalesce(started_at, current_timestamp) WHERE id = $jobId", { jobId });
          job.status = "running";
        }
        if (!job || job.status !== "running") return { job, item: null };
        if (Number(job.online_checks || 0) >= Number(job.max_online_requests || 0)) {
          await connection.run("UPDATE partmaster_autopilot_items SET status = 'deferred_budget', message = 'Deferred because the source-check budget was reached.' WHERE job_id = $jobId AND status = 'pending'", { jobId });
          await connection.run("UPDATE partmaster_autopilot_jobs SET status = 'completed', completed_at = current_timestamp WHERE id = $jobId", { jobId });
          await refreshAutopilotJob(connection, jobId);
          return { job: { ...job, status: "completed" }, item: null };
        }
        const itemReader = await connection.runAndReadAll(
          `SELECT items.*, parts.part_number, parts.manufacturer FROM partmaster_autopilot_items items
           JOIN partmaster_canonical_parts parts ON parts.id = items.part_id
           WHERE items.job_id = $jobId AND items.status = 'pending'
           ORDER BY items.priority_score DESC, items.id LIMIT 1`, { jobId },
        );
        const item = itemReader.getRowObjectsJson()[0];
        if (!item) {
          await connection.run("UPDATE partmaster_autopilot_jobs SET status = 'completed', completed_at = current_timestamp WHERE id = $jobId", { jobId });
          await refreshAutopilotJob(connection, jobId);
          return { job: { ...job, status: "completed" }, item: null };
        }
        await connection.run("UPDATE partmaster_autopilot_items SET status = 'processing', attempt_count = attempt_count + 1, started_at = current_timestamp WHERE id = $id", { id: item.id });
        await connection.run("UPDATE partmaster_autopilot_jobs SET online_checks = online_checks + 1 WHERE id = $jobId", { jobId });
        return { job, item };
      });
      if (!state.item) break;
      try {
        const checked = await checkCanonicalPart(state.item.part_id, { threshold: Number(state.job.min_confidence || 0.94), force: Boolean(state.job.recheck_older) });
        let compatibility = { checked: false, added: 0 };
        if (checked.status === "verified" && state.job.discover_compatibility) {
          const budgetAvailable = await withConnection(async (connection) => {
            const reader = await connection.runAndReadAll("SELECT online_checks, max_online_requests FROM partmaster_autopilot_jobs WHERE id = $jobId", { jobId });
            const job = reader.getRowObjectsJson()[0];
            if (Number(job.online_checks) >= Number(job.max_online_requests)) return false;
            await connection.run("UPDATE partmaster_autopilot_jobs SET online_checks = online_checks + 1 WHERE id = $jobId", { jobId });
            return true;
          });
          if (budgetAvailable) compatibility = await autopilotCompatibility(state.item.part_id);
        }
        const status = ["verified", "review", "no_source", "not_found"].includes(checked.status) ? checked.status : "review";
        const message = [checked.message, compatibility.error ? `Compatibility: ${compatibility.error}` : compatibility.checked ? `${compatibility.total || 0} compatibility fitments available.` : ""].filter(Boolean).join(" ");
        await withConnection(async (connection) => {
          await connection.run(
            `UPDATE partmaster_autopilot_items SET status = $status, confidence = $confidence,
             evidence_url = $evidenceUrl, message = $message, fields_updated = $fields,
             compatibility_added = $compatibilityAdded, processed_at = current_timestamp WHERE id = $id`,
            { id: state.item.id, status, confidence: checked.confidence || 0, evidenceUrl: checked.evidenceUrl || null, message, fields: checked.fieldsUpdated?.join(", ") || null, compatibilityAdded: compatibility.added || 0 },
          );
          await refreshAutopilotJob(connection, jobId);
        });
        if (!checked.cacheHit) await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(100, Number(process.env.PARTMASTER_AUTOPILOT_DELAY_MS) || 350)));
      } catch (error) {
        await withConnection(async (connection) => {
          await connection.run("UPDATE partmaster_autopilot_items SET status = 'failed', message = $message, processed_at = current_timestamp WHERE id = $id", { id: state.item.id, message: error.message });
          await refreshAutopilotJob(connection, jobId);
        });
      }
    }
    await refreshPartIntelligence();
  } catch (error) {
    await withConnection((connection) => connection.run(
      "UPDATE partmaster_autopilot_jobs SET status = 'failed', last_error = $error, completed_at = current_timestamp WHERE id = $jobId",
      { jobId, error: error.message },
    )).catch(() => {});
  } finally {
    activeAutopilotJobs.delete(jobId);
  }
}

function scheduleAutopilotJob(jobId) {
  setImmediate(() => runAutopilotJob(jobId));
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
            // DuckDB cannot infer a parameter type from JavaScript `undefined`.
            // Optional enrichment fields are intentionally nullable, so bind them
            // as SQL NULL when an inference or vehicle mapping is unavailable.
            const nullableResult = (key) => result[key] ?? null;
            await connection.run(
              `UPDATE partmaster_enrichment_candidates SET
               enriched_part_number = $partNumber, enriched_description = $description,
               side = $side, position = $position, location_notes = $locationNotes,
               evidence_url = $evidenceUrl, evidence_title = $evidenceTitle,
               family_name = $familyName, component_scope = $componentScope,
               heated_state = $heatedState, auto_dimming_state = $autoDimmingState,
               power_folding_state = $powerFoldingState, memory_state = $memoryState,
               blind_spot_state = $blindSpotState, camera_state = $cameraState,
               turn_signal_state = $turnSignalState, connector_pins = $connectorPins,
               required_options = $requiredOptions, excluded_options = $excludedOptions,
               variant_summary = $variantSummary, fitment_explanation = $fitmentExplanation,
               epid = $epid, vehicle_year = $vehicleYear, vehicle_make = $vehicleMake,
               vehicle_model = $vehicleModel, vehicle_trim = $vehicleTrim, vehicle_type = $vehicleType,
               vehicle_motorcycle_type = $vehicleMotorcycleType,
               vehicle_mapping_method = $vehicleMappingMethod,
               vehicle_mapping_confidence = $vehicleMappingConfidence,
               extracted_attributes_json = $extractedAttributesJson,
               extracted_attribute_count = $extractedAttributeCount,
               confidence = $confidence, status = $status, decision_notes = $decision,
               processed_at = current_timestamp
               WHERE id = $id`,
              {
                id: candidate.id,
                partNumber: nullableResult("enrichedPartNumber"),
                description: nullableResult("enrichedDescription"),
                side: nullableResult("side"),
                position: nullableResult("position"),
                locationNotes: nullableResult("locationNotes"),
                evidenceUrl: nullableResult("evidenceUrl"),
                evidenceTitle: nullableResult("evidenceTitle"),
                familyName: nullableResult("familyName"),
                componentScope: nullableResult("componentScope"),
                heatedState: nullableResult("heatedState"),
                autoDimmingState: nullableResult("autoDimmingState"),
                powerFoldingState: nullableResult("powerFoldingState"),
                memoryState: nullableResult("memoryState"),
                blindSpotState: nullableResult("blindSpotState"),
                cameraState: nullableResult("cameraState"),
                turnSignalState: nullableResult("turnSignalState"),
                connectorPins: nullableResult("connectorPins"),
                requiredOptions: nullableResult("requiredOptions"),
                excludedOptions: nullableResult("excludedOptions"),
                variantSummary: nullableResult("variantSummary"),
                fitmentExplanation: nullableResult("fitmentExplanation"),
                epid: nullableResult("epid"),
                vehicleYear: nullableResult("vehicleYear"),
                vehicleMake: nullableResult("vehicleMake"),
                vehicleModel: nullableResult("vehicleModel"),
                vehicleTrim: nullableResult("vehicleTrim"),
                vehicleType: nullableResult("vehicleType"),
                vehicleMotorcycleType: nullableResult("vehicleMotorcycleType"),
                vehicleMappingMethod: nullableResult("vehicleMappingMethod"),
                vehicleMappingConfidence: nullableResult("vehicleMappingConfidence"),
                extractedAttributesJson: nullableResult("extractedAttributesJson"),
                extractedAttributeCount: nullableResult("extractedAttributeCount"),
                confidence: nullableResult("confidence"),
                status: nullableResult("status"),
                decision: nullableResult("decision"),
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
                family_name: result.familyName,
                component_scope: result.componentScope,
                heated_state: result.heatedState,
                auto_dimming_state: result.autoDimmingState,
                power_folding_state: result.powerFoldingState,
                memory_state: result.memoryState,
                blind_spot_state: result.blindSpotState,
                camera_state: result.cameraState,
                turn_signal_state: result.turnSignalState,
                connector_pins: result.connectorPins,
                required_options: result.requiredOptions,
                excluded_options: result.excludedOptions,
                variant_summary: result.variantSummary,
                fitment_explanation: result.fitmentExplanation,
                epid: result.epid,
                vehicle_year: result.vehicleYear,
                vehicle_make: result.vehicleMake,
                vehicle_model: result.vehicleModel,
                vehicle_trim: result.vehicleTrim,
                vehicle_type: result.vehicleType,
                vehicle_motorcycle_type: result.vehicleMotorcycleType,
                vehicle_mapping_method: result.vehicleMappingMethod,
                vehicle_mapping_confidence: result.vehicleMappingConfidence,
                confidence: result.confidence,
              } }, "online_verified");
            }
          });
          if (result.status === "enriched") {
            await enrichCandidateCompatibility({
              ...candidate,
              enriched_part_number: result.enrichedPartNumber,
              evidence_url: result.evidenceUrl,
            }).catch(() => null);
          }
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

async function refreshRowEnhancementJob(connection, jobId) {
  const reader = await connection.runAndReadAll(
    `SELECT count(*) FILTER (WHERE status != 'pending') AS processed,
     count(*) FILTER (WHERE status IN ('filled', 'no_change')) AS filled,
     count(*) FILTER (WHERE status = 'review') AS review,
     count(*) FILTER (WHERE status = 'failed') AS failed,
     count(*) FILTER (WHERE status = 'pending') AS remaining
     FROM partmaster_row_enhancement_items WHERE job_id = $jobId`,
    { jobId },
  );
  const stats = reader.getRowObjectsJson()[0];
  await connection.run(
    `UPDATE partmaster_row_enhancement_jobs SET processed_count = $processed,
     filled_count = $filled, review_count = $review, failed_count = $failed
     WHERE id = $jobId`,
    { jobId, processed: stats.processed, filled: stats.filled, review: stats.review, failed: stats.failed },
  );
  return stats;
}

async function runRowEnhancementJob(jobId) {
  if (activeRowEnhancementJobs.has(jobId)) return;
  activeRowEnhancementJobs.add(jobId);
  try {
    await withConnection((connection) => connection.run(
      `UPDATE partmaster_row_enhancement_jobs SET status = 'running', started_at = current_timestamp,
       last_error = NULL WHERE id = $jobId AND status IN ('queued', 'running')`,
      { jobId },
    ));
    while (!shuttingDown) {
      const state = await withConnection(async (connection) => {
        const jobReader = await connection.runAndReadAll(
          "SELECT * FROM partmaster_row_enhancement_jobs WHERE id = $jobId",
          { jobId },
        );
        const job = jobReader.getRowObjectsJson()[0];
        if (!job || job.status !== "running") return null;
        const itemReader = await connection.runAndReadAll(
          `SELECT * FROM partmaster_row_enhancement_items
           WHERE job_id = $jobId AND status = 'pending' ORDER BY row_id LIMIT 1`,
          { jobId },
        );
        return { job, item: itemReader.getRowObjectsJson()[0] };
      });
      if (!state) break;
      if (!state.item) {
        await withConnection(async (connection) => {
          await refreshRowEnhancementJob(connection, jobId);
          await connection.run(
            "UPDATE partmaster_row_enhancement_jobs SET status = 'completed', completed_at = current_timestamp WHERE id = $jobId",
            { jobId },
          );
        });
        break;
      }
      try {
        const preview = await previewRowEnhancement(state.job.dataset_id, state.item.row_id);
        const changeCount = Object.keys(preview.changes).length;
        let status = "review";
        if (preview.confidence >= 0.94 && changeCount) {
          await applyMissingRowChanges(preview.dataset, preview.columns, state.item.row_id, preview.changes);
          status = "filled";
        } else if (preview.confidence >= 0.94 && !changeCount) status = "no_change";
        await withConnection((connection) => connection.run(
          `UPDATE partmaster_row_enhancement_items SET status = $status,
           suggested_changes = $changes, confidence = $confidence, evidence_url = $evidenceUrl,
           notes = $notes, processed_at = current_timestamp WHERE id = $id`,
          {
            id: state.item.id,
            status,
            changes: JSON.stringify(preview.changes),
            confidence: preview.confidence,
            evidenceUrl: preview.sourceUrl || null,
            notes: preview.reason,
          },
        ));
      } catch (error) {
        await withConnection((connection) => connection.run(
          `UPDATE partmaster_row_enhancement_items SET status = 'failed', notes = $notes,
           processed_at = current_timestamp WHERE id = $id`,
          { id: state.item.id, notes: error.message },
        ));
      }
      await withConnection((connection) => refreshRowEnhancementJob(connection, jobId));
    }
  } catch (error) {
    await withConnection((connection) => connection.run(
      `UPDATE partmaster_row_enhancement_jobs SET status = 'failed', last_error = $error,
       completed_at = current_timestamp WHERE id = $jobId`,
      { jobId, error: error.message },
    )).catch(() => {});
  } finally {
    activeRowEnhancementJobs.delete(jobId);
  }
}

function scheduleRowEnhancementJob(jobId) {
  setImmediate(() => runRowEnhancementJob(jobId));
}

async function backfillVariantIntelligence() {
  await withConnection(async (connection) => {
    const partsReader = await connection.runAndReadAll(
      `SELECT parts.id, parts.manufacturer, parts.manufacturer_norm, parts.part_number, parts.description,
       parts.confidence, parts.evidence_url, applications.year, applications.model, applications.assembly,
       applications.item_number, applications.side, applications.position, applications.source_url
       FROM partmaster_canonical_parts parts
       LEFT JOIN partmaster_part_applications applications ON applications.part_id = parts.id
       WHERE parts.family_id IS NULL
       QUALIFY row_number() OVER (PARTITION BY parts.id ORDER BY applications.confidence DESC NULLS LAST) = 1
       LIMIT 10000`,
    );
    for (const part of partsReader.getRowObjectsJson()) {
      const candidate = {
        manufacturer_raw: part.manufacturer,
        manufacturer_norm: part.manufacturer_norm,
        part_number_raw: part.part_number,
        description_raw: part.description,
        assembly: part.assembly,
        item_number: part.item_number,
        year: part.year,
        model: part.model,
        source_url: part.source_url,
        evidence_url: part.evidence_url,
        confidence: Number(part.confidence || 0),
      };
      const intelligence = inferVariantIntelligence(candidate);
      if (part.side && part.side !== "Unknown") intelligence.side = part.side;
      const enriched = applyVariantIntelligence({}, intelligence, candidate);
      const { familyId } = await ensurePartFamily(connection, { ...candidate, family_name: enriched.familyName });
      await connection.run(
        `UPDATE partmaster_canonical_parts SET family_id = $familyId, component_scope = $componentScope,
         variant_summary = $variantSummary, updated_at = current_timestamp WHERE id = $id`,
        { id: part.id, familyId, componentScope: enriched.componentScope, variantSummary: enriched.variantSummary },
      );
      await syncVariantAttributes(connection, part.id, {
        ...candidate,
        family_name: enriched.familyName,
        component_scope: enriched.componentScope,
        side: enriched.side,
        heated_state: enriched.heatedState,
        auto_dimming_state: enriched.autoDimmingState,
        power_folding_state: enriched.powerFoldingState,
        memory_state: enriched.memoryState,
        blind_spot_state: enriched.blindSpotState,
        camera_state: enriched.cameraState,
        turn_signal_state: enriched.turnSignalState,
        connector_pins: enriched.connectorPins,
        required_options: enriched.requiredOptions,
        excluded_options: enriched.excludedOptions,
      });
    }

    const candidatesReader = await connection.runAndReadAll(
      `SELECT * FROM partmaster_enrichment_candidates
       WHERE decision IS NULL LIMIT 20000`,
    );
    for (const candidate of candidatesReader.getRowObjectsJson()) {
      let intelligence = applyVariantIntelligence({}, inferVariantIntelligence(candidate), candidate);
      intelligence = applyExtractedAttributes(intelligence, candidate, candidate.enriched_description);
      await connection.run(
        `UPDATE partmaster_enrichment_candidates SET family_name = $familyName,
         component_scope = $componentScope, heated_state = $heatedState,
         auto_dimming_state = $autoDimmingState, power_folding_state = $powerFoldingState,
         memory_state = $memoryState, blind_spot_state = $blindSpotState, camera_state = $cameraState,
         turn_signal_state = $turnSignalState, connector_pins = $connectorPins,
         required_options = $requiredOptions, excluded_options = $excludedOptions,
         variant_summary = $variantSummary, fitment_explanation = $fitmentExplanation,
         extracted_attributes_json = $extractedAttributesJson,
         extracted_attribute_count = $extractedAttributeCount
         WHERE id = $id`,
        {
          id: candidate.id,
          familyName: intelligence.familyName,
          componentScope: intelligence.componentScope,
          heatedState: intelligence.heatedState,
          autoDimmingState: intelligence.autoDimmingState,
          powerFoldingState: intelligence.powerFoldingState,
          memoryState: intelligence.memoryState,
          blindSpotState: intelligence.blindSpotState,
          cameraState: intelligence.cameraState,
          turnSignalState: intelligence.turnSignalState,
          connectorPins: intelligence.connectorPins,
          requiredOptions: intelligence.requiredOptions,
          excludedOptions: intelligence.excludedOptions,
          variantSummary: intelligence.variantSummary,
          fitmentExplanation: intelligence.fitmentExplanation,
          extractedAttributesJson: intelligence.extractedAttributesJson,
          extractedAttributeCount: intelligence.extractedAttributeCount,
        },
      );
    }
  });
}

function safeSourceHost(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return "unknown"; }
}

async function upsertConflict(connection, conflict) {
  const reader = await connection.runAndReadAll(
    "SELECT id FROM partmaster_data_conflicts WHERE conflict_key = $key",
    { key: conflict.key },
  );
  const id = reader.getRowObjectsJson()[0]?.id;
  if (id) {
    await connection.run(
      `UPDATE partmaster_data_conflicts SET field_name = $fieldName, severity = $severity,
       values_seen = $valuesSeen, explanation = $explanation, status = 'open',
       detected_at = current_timestamp, resolved_at = NULL WHERE id = $id`,
      { id, fieldName: conflict.fieldName, severity: conflict.severity, valuesSeen: conflict.valuesSeen, explanation: conflict.explanation },
    );
  } else {
    await connection.run(
      `INSERT INTO partmaster_data_conflicts
       (id, conflict_key, part_id, field_name, severity, values_seen, explanation)
       VALUES ($id, $key, $partId, $fieldName, $severity, $valuesSeen, $explanation)`,
      { id: randomUUID(), key: conflict.key, partId: conflict.partId, fieldName: conflict.fieldName, severity: conflict.severity, valuesSeen: conflict.valuesSeen, explanation: conflict.explanation },
    );
  }
}

async function refreshPartIntelligence() {
  return withConnection(async (connection) => {
    const canonicalEvidenceReader = await connection.runAndReadAll(
      `SELECT parts.id, parts.part_number, parts.description, parts.confidence, parts.evidence_url,
       families.family_name, applications.assembly, applications.quantity, applications.source_url
       FROM partmaster_canonical_parts parts
       LEFT JOIN partmaster_part_families families ON families.id = parts.family_id
       LEFT JOIN partmaster_part_applications applications ON applications.part_id = parts.id
       QUALIFY row_number() OVER (PARTITION BY parts.id ORDER BY applications.confidence DESC NULLS LAST) = 1`,
    );
    for (const part of canonicalEvidenceReader.getRowObjectsJson()) {
      const sourceUrl = part.evidence_url || part.source_url;
      await recordFieldEvidence(connection, { partId: part.id, fieldName: "part_number", fieldValue: part.part_number, sourceUrl, sourceMethod: "canonical_backfill", confidence: Number(part.confidence || 0), accepted: true });
      await recordFieldEvidence(connection, { partId: part.id, fieldName: "description", fieldValue: part.description, sourceUrl, sourceMethod: "canonical_backfill", confidence: Number(part.confidence || 0), accepted: true });
      await syncVariantAttributes(connection, part.id, { family_name: part.family_name, description_raw: part.description, assembly: part.assembly, quantity: part.quantity, evidence_url: sourceUrl, confidence: Number(part.confidence || 0) });
    }
    const candidateEvidenceReader = await connection.runAndReadAll(
      `SELECT parts.id AS part_id, candidates.enriched_description, candidates.description_raw,
       candidates.evidence_url, candidates.source_url, candidates.evidence_title, candidates.confidence,
       candidates.decision
       FROM partmaster_canonical_parts parts
       JOIN partmaster_enrichment_candidates candidates
        ON candidates.manufacturer_norm = parts.manufacturer_norm
        AND candidates.part_number_norm = parts.part_number_norm
       WHERE coalesce(candidates.evidence_url, candidates.source_url) IS NOT NULL
        AND trim(coalesce(candidates.evidence_url, candidates.source_url)) != ''`,
    );
    for (const row of candidateEvidenceReader.getRowObjectsJson()) {
      const sourceUrl = row.evidence_url || row.source_url;
      await recordFieldEvidence(connection, { partId: row.part_id, fieldName: "description", fieldValue: row.enriched_description || row.description_raw, sourceUrl, sourceTitle: row.evidence_title, sourceMethod: row.decision ? "human_review" : "enrichment_candidate", confidence: Number(row.confidence || 0), accepted: row.decision === "approve" || Number(row.confidence || 0) >= 0.94 });
    }

    await connection.run(
      "UPDATE partmaster_data_conflicts SET status = 'resolved', resolved_at = current_timestamp WHERE status = 'open'",
    );
    const sideConflictReader = await connection.runAndReadAll(
      `SELECT part_id, string_agg(DISTINCT side, ', ' ORDER BY side) AS values_seen
       FROM partmaster_part_applications
       WHERE side IS NOT NULL AND lower(trim(side)) NOT IN ('', 'unknown', 'universal')
       GROUP BY part_id HAVING count(DISTINCT lower(trim(side))) > 1`,
    );
    for (const row of sideConflictReader.getRowObjectsJson()) {
      await upsertConflict(connection, { key: `${row.part_id}:application_side`, partId: row.part_id, fieldName: "side", severity: "warning", valuesSeen: row.values_seen, explanation: "The exact OEM number is assigned to more than one side. Confirm whether it is universal or whether two variants were merged." });
    }
    const descriptionConflictReader = await connection.runAndReadAll(
      `SELECT parts.id AS part_id,
       string_agg(DISTINCT coalesce(candidates.enriched_description, candidates.description_raw), ' | ' ORDER BY coalesce(candidates.enriched_description, candidates.description_raw)) AS values_seen
       FROM partmaster_canonical_parts parts
       JOIN partmaster_enrichment_candidates candidates
        ON candidates.manufacturer_norm = parts.manufacturer_norm AND candidates.part_number_norm = parts.part_number_norm
       WHERE trim(coalesce(candidates.enriched_description, candidates.description_raw, '')) != ''
       GROUP BY parts.id
       HAVING count(DISTINCT lower(trim(coalesce(candidates.enriched_description, candidates.description_raw)))) > 1`,
    );
    for (const row of descriptionConflictReader.getRowObjectsJson()) {
      await upsertConflict(connection, { key: `${row.part_id}:description`, partId: row.part_id, fieldName: "description", severity: "review", valuesSeen: row.values_seen, explanation: "Sources use different descriptions for this exact OEM number. Review whether they describe the same component or a source error." });
    }
    const relationshipConflictReader = await connection.runAndReadAll(
      `SELECT relationships.id, relationships.source_part_id AS part_id,
       source.part_number AS source_number, target.part_number AS target_number,
       string_agg(source_attributes.attribute_name || ': ' || source_attributes.attribute_value || ' vs ' || target_attributes.attribute_value, ', ' ORDER BY source_attributes.attribute_name) AS values_seen
       FROM partmaster_part_relationships relationships
       JOIN partmaster_canonical_parts source ON source.id = relationships.source_part_id
       JOIN partmaster_canonical_parts target ON target.id = relationships.target_part_id
       JOIN partmaster_variant_attributes source_attributes ON source_attributes.part_id = source.id
       JOIN partmaster_variant_attributes target_attributes ON target_attributes.part_id = target.id
        AND target_attributes.attribute_name = source_attributes.attribute_name
       WHERE relationships.relationship_type IN ('interchangeable', 'supersedes', 'superseded_by')
        AND lower(source_attributes.attribute_value) != lower(target_attributes.attribute_value)
       GROUP BY relationships.id, relationships.source_part_id, source.part_number, target.part_number`,
    );
    for (const row of relationshipConflictReader.getRowObjectsJson()) {
      await upsertConflict(connection, { key: `${row.part_id}:relationship:${row.id}`, partId: row.part_id, fieldName: "relationship", severity: "critical", valuesSeen: row.values_seen, explanation: `${row.source_number} and ${row.target_number} are marked interchangeable or superseding but have conflicting variant attributes.` });
    }

    const partsReader = await connection.runAndReadAll(
      `SELECT parts.*, families.family_name,
       (SELECT count(*) FROM partmaster_part_applications applications WHERE applications.part_id = parts.id) AS application_count,
       (SELECT count(*) FROM partmaster_part_applications applications WHERE applications.part_id = parts.id AND applications.vehicle_mapping_method IS NOT NULL) AS mapped_count,
       (SELECT count(*) FROM partmaster_part_compatibility compatibility WHERE compatibility.part_id = parts.id) AS compatibility_count,
       (SELECT count(*) FROM partmaster_variant_attributes attributes WHERE attributes.part_id = parts.id) AS attribute_count,
       (SELECT count(DISTINCT source_url) FROM partmaster_field_evidence evidence WHERE evidence.part_id = parts.id) AS evidence_sources,
       (SELECT count(*) FROM partmaster_data_conflicts conflicts WHERE conflicts.part_id = parts.id AND conflicts.status = 'open') AS conflict_count,
       date_diff('day', coalesce(parts.verified_at, parts.updated_at), current_timestamp) AS age_days
       FROM partmaster_canonical_parts parts
       LEFT JOIN partmaster_part_families families ON families.id = parts.family_id`,
    );
    for (const part of partsReader.getRowObjectsJson()) {
      const schema = categorySchemaFor(part.family_name, part.description);
      const identity = [part.manufacturer, part.part_number].filter((value) => String(value || "").trim()).length * 40 + (part.family_id ? 10 : 0) + (part.component_scope ? 10 : 0);
      const description = String(part.description || "").trim().length >= 6 ? 100 : part.description ? 60 : 0;
      const applications = Number(part.application_count || 0);
      const mapped = Number(part.mapped_count || 0);
      const fitment = Math.min(100, (applications ? 20 : 0) + (applications ? Math.round((mapped / applications) * 40) : 0) + Math.min(40, Number(part.compatibility_count || 0) * 5));
      const variant = Math.min(100, (schema.key === "general" ? 35 : 55) + Math.round((Math.min(Number(part.attribute_count || 0), schema.attributes.length) / Math.max(1, schema.attributes.length)) * 45));
      const evidence = Math.min(100, (part.evidence_url ? 35 : 0) + Math.round(Number(part.confidence || 0) * 35) + Math.min(30, Number(part.evidence_sources || 0) * 15));
      const ageDays = Number(part.age_days || 0);
      const freshness = ageDays <= 180 ? 100 : ageDays <= 365 ? 75 : ageDays <= 730 ? 50 : 25;
      const conflictRisk = Math.min(100, Number(part.conflict_count || 0) * 35);
      const overall = Math.max(0, Math.round(identity * 0.2 + description * 0.15 + fitment * 0.2 + variant * 0.15 + evidence * 0.2 + freshness * 0.1 - conflictRisk * 0.2));
      const missing = [];
      if (!part.description) missing.push("description");
      if (!part.evidence_url) missing.push("evidence");
      if (!applications) missing.push("fitment");
      if (!Number(part.attribute_count || 0)) missing.push("variant attributes");
      if (!Number(part.compatibility_count || 0)) missing.push("compatibility");
      const existingReader = await connection.runAndReadAll("SELECT part_id FROM partmaster_quality_scores WHERE part_id = $partId", { partId: part.id });
      const values = { partId: part.id, identity, description, fitment, variant, evidence, freshness, conflictRisk, overall, missingFields: missing.join(", ") || null };
      if (existingReader.getRowObjectsJson().length) {
        await connection.run(
          `UPDATE partmaster_quality_scores SET identity_score = $identity, description_score = $description,
           fitment_score = $fitment, variant_score = $variant, evidence_score = $evidence,
           freshness_score = $freshness, conflict_risk = $conflictRisk, overall_score = $overall,
           missing_fields = $missingFields, calculated_at = current_timestamp WHERE part_id = $partId`, values,
        );
      } else {
        await connection.run(
          `INSERT INTO partmaster_quality_scores
           (part_id, identity_score, description_score, fitment_score, variant_score, evidence_score,
            freshness_score, conflict_risk, overall_score, missing_fields)
           VALUES ($partId, $identity, $description, $fitment, $variant, $evidence, $freshness, $conflictRisk, $overall, $missingFields)`, values,
        );
      }
    }
    return { partsScored: partsReader.getRowObjectsJson().length, conflicts: sideConflictReader.getRowObjectsJson().length + descriptionConflictReader.getRowObjectsJson().length + relationshipConflictReader.getRowObjectsJson().length };
  });
}

function parsePartSearchQuery(query) {
  const raw = String(query || "").trim();
  const lower = raw.toLowerCase();
  const year = lower.match(/\b((?:19|20)\d{2})\b/)?.[1] || "";
  const side = /\bright\b|\brh\b/.test(lower) ? "right" : /\bleft\b|\blh\b/.test(lower) ? "left" : "";
  const manufacturers = ["BMW", "Honda", "Kawasaki", "KTM", "Harley-Davidson", "Toyota", "Ford", "Chevrolet", "Nissan", "Mercedes-Benz", "Audi", "Volkswagen"];
  const manufacturer = manufacturers.find((name) => lower.includes(name.toLowerCase())) || "";
  const featureMap = { heated: /\bheated\b/, blind_spot: /\bblind[ -]?spot\b|\bbsm\b/, camera: /\bcamera\b/, power_folding: /\bpower[ -]?fold/, memory: /\bmemory\b/, auto_dimming: /\bauto[ -]?dimm?ing\b/, turn_signal: /\bturn signal\b|\bindicator\b/ };
  const requiredFeatures = [];
  const excludedFeatures = [];
  for (const [key, pattern] of Object.entries(featureMap)) {
    if (!pattern.test(lower)) continue;
    const exclusionPattern = new RegExp(`(?:without|exclude|no|non)[ -]{0,2}${key.replaceAll("_", "[ -]?")}`, "i");
    (exclusionPattern.test(lower) ? excludedFeatures : requiredFeatures).push(key);
  }
  const importantTerms = lower.replace(/[^a-z0-9-]+/g, " ").split(/\s+/).filter((term) => term.length >= 3 && !["find", "part", "parts", "with", "without", "for", "the", "and", "but", "exclude", year, manufacturer.toLowerCase(), side].includes(term)).slice(0, 8);
  return { raw, year, side, manufacturer, requiredFeatures, excludedFeatures, importantTerms };
}

async function intelligentPartSearch(query) {
  const interpreted = parsePartSearchQuery(query);
  const rows = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      `SELECT parts.id, parts.manufacturer, parts.part_number, parts.description, parts.component_scope,
       parts.variant_summary, parts.confidence, parts.evidence_url, families.family_name,
       scores.overall_score, scores.identity_score, scores.fitment_score, scores.variant_score,
       scores.evidence_score, scores.conflict_risk, scores.missing_fields,
       string_agg(DISTINCT attributes.attribute_name || '=' || attributes.attribute_value, '|' ORDER BY attributes.attribute_name || '=' || attributes.attribute_value) AS attributes,
       string_agg(DISTINCT coalesce(applications.year, '') || ' ' || coalesce(applications.vehicle_make, parts.manufacturer) || ' ' || coalesce(applications.vehicle_model, applications.model, '') || ' ' || coalesce(applications.assembly, ''), '|' ORDER BY coalesce(applications.year, '') || ' ' || coalesce(applications.vehicle_make, parts.manufacturer) || ' ' || coalesce(applications.vehicle_model, applications.model, '') || ' ' || coalesce(applications.assembly, '')) AS applications
       FROM partmaster_canonical_parts parts
       LEFT JOIN partmaster_part_families families ON families.id = parts.family_id
       LEFT JOIN partmaster_quality_scores scores ON scores.part_id = parts.id
       LEFT JOIN partmaster_variant_attributes attributes ON attributes.part_id = parts.id
       LEFT JOIN partmaster_part_applications applications ON applications.part_id = parts.id
       GROUP BY parts.id, parts.manufacturer, parts.part_number, parts.description, parts.component_scope,
        parts.variant_summary, parts.confidence, parts.evidence_url, families.family_name,
        scores.overall_score, scores.identity_score, scores.fitment_score, scores.variant_score,
        scores.evidence_score, scores.conflict_risk, scores.missing_fields LIMIT 5000`,
    );
    return reader.getRowObjectsJson();
  });
  const results = [];
  for (const row of rows) {
    const searchable = `${row.manufacturer} ${row.part_number} ${row.description} ${row.family_name} ${row.variant_summary} ${row.attributes} ${row.applications}`.toLowerCase();
    const attrs = Object.fromEntries(String(row.attributes || "").split("|").filter(Boolean).map((item) => item.split("=", 2)));
    const reasons = [];
    let score = Number(row.overall_score || 0) / 10;
    if (interpreted.manufacturer) {
      if (String(row.manufacturer).toLowerCase() !== interpreted.manufacturer.toLowerCase()) continue;
      score += 20; reasons.push(`Manufacturer is ${row.manufacturer}`);
    }
    if (interpreted.year) {
      if (!String(row.applications || "").includes(interpreted.year)) continue;
      score += 15; reasons.push(`Fitment includes ${interpreted.year}`);
    }
    if (interpreted.side) {
      if (String(attrs.side || "").toLowerCase() !== interpreted.side && !searchable.includes(interpreted.side)) continue;
      score += 15; reasons.push(`${titleCase(interpreted.side)}-side evidence`);
    }
    let rejected = false;
    for (const feature of interpreted.requiredFeatures) {
      if (String(attrs[feature] || "").toLowerCase() !== "yes" && !searchable.includes(feature.replaceAll("_", " "))) { rejected = true; break; }
      score += 10; reasons.push(`${titleCase(feature.replaceAll("_", " "))} confirmed`);
    }
    if (rejected) continue;
    for (const feature of interpreted.excludedFeatures) {
      if (String(attrs[feature] || "").toLowerCase() === "yes") { rejected = true; break; }
      reasons.push(`${titleCase(feature.replaceAll("_", " "))} excluded`);
    }
    if (rejected) continue;
    const termMatches = interpreted.importantTerms.filter((term) => searchable.includes(term));
    if (interpreted.importantTerms.length && !termMatches.length && !normalizePartNumber(interpreted.raw).includes(row.part_number.replace(/[^A-Z0-9]/gi, ""))) continue;
    score += termMatches.length * 5;
    if (termMatches.length) reasons.push(`Matched ${termMatches.join(", ")}`);
    results.push({ ...row, matchScore: Math.round(score), reasons: reasons.length ? reasons : ["Matched canonical part identity"] });
  }
  return { interpreted, results: results.sort((left, right) => right.matchScore - left.matchScore).slice(0, 100) };
}

function localTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseLocalTimestamp(value) {
  if (value instanceof Date) return value;
  const text = String(value || "").trim();
  if (!text) return null;
  const parsed = new Date(text.includes("T") ? text : text.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function nextDailyRun(timeOfDay, after = new Date()) {
  const match = String(timeOfDay || "22:00").match(/^(\d{2}):(\d{2})$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error("Choose a valid daily start time.");
  const next = new Date(after);
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (next <= after) next.setDate(next.getDate() + 1);
  return next;
}

function scheduleNextRun({ scheduleType, runAt, timeOfDay }, after = new Date()) {
  if (scheduleType === "daily") return nextDailyRun(timeOfDay, after);
  const next = parseLocalTimestamp(runAt);
  if (!next) throw new Error("Choose a valid date and time for the one-time job.");
  return next;
}

async function createPipelineJob(options = {}) {
  const active = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll("SELECT id FROM partmaster_pipeline_jobs WHERE status IN ('queued', 'running') LIMIT 1");
    return reader.getRowObjectsJson()[0];
  });
  if (active) { const error = new Error("A full-dataset pipeline is already running."); error.status = 409; throw error; }
  const id = randomUUID();
  const datasetIds = Array.isArray(options.datasetIds) ? options.datasetIds.map(String).filter(Boolean) : [];
  const requestedBudget = Number(options.onlineBudget);
  const onlineBudget = Math.max(0, Math.min(PIPELINE_MAX_ONLINE_BUDGET, Number.isFinite(requestedBudget) ? requestedBudget : 250));
  const importMissing = options.importMissing !== false;
  const mode = options.continueOnline === true ? "online_only" : "full";
  await withConnection((connection) => connection.run(
    `INSERT INTO partmaster_pipeline_jobs
     (id, name, mode, status, phase, dataset_ids, import_missing, online_budget)
     VALUES ($id, $name, $mode, 'queued', 'queued', $datasetIds, $importMissing, $onlineBudget)`,
    {
      id,
      name: String(options.name || (mode === "online_only" ? "Continue prioritized online checks" : "Full local parts pipeline")).slice(0, 200),
      mode,
      datasetIds: datasetIds.join(",") || null,
      importMissing,
      onlineBudget,
    },
  ));
  scheduleFullPipeline(id);
  return id;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/local/health", (_request, response) => {
  response.json({ ok: true, dataRoot: DATA_ROOT, databasePath: DATABASE_PATH });
});

app.get("/api/local/vehicle-mappings", asyncRoute(async (_request, response) => {
  const stats = await vehicleMappingStats();
  response.json({
    available: Number(stats.vehicles) > 0,
    vehicles: stats.vehicles,
    mappedVehicles: stats.mapped_vehicles,
    aliases: stats.aliases,
    mpsov_aliases: stats.mpsov_aliases,
    mpsov_enriched_applications: stats.mpsov_enriched_applications,
    mpsov_enriched_candidates: stats.mpsov_enriched_candidates,
    loadedAt: stats.loaded_at,
    referenceRoot: REFERENCE_ROOT,
  });
}));

app.post("/api/local/open-folder", (_request, response) => {
  const child = spawn("open", [INBOX_ROOT], { detached: true, stdio: "ignore" });
  child.unref();
  response.json({ ok: true, path: INBOX_ROOT });
});

app.get("/api/local/files", asyncRoute(async (_request, response) => {
  const files = await listInboxDataFiles();
  files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  response.json({ files, inboxPath: INBOX_ROOT, rawDataPath: RAWDATA_ROOT });
}));

app.get("/api/local/datasets", asyncRoute(async (_request, response) => {
  const datasets = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll("SELECT * FROM partmaster_datasets ORDER BY imported_at DESC");
    return reader.getRowObjectsJson();
  });
  response.json({ datasets, databasePath: DATABASE_PATH });
}));

app.get("/api/local/pipeline/jobs", asyncRoute(async (_request, response) => {
  const jobs = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll("SELECT * FROM partmaster_pipeline_jobs ORDER BY created_at DESC LIMIT 20");
    return reader.getRowObjectsJson();
  });
  response.json({ jobs });
}));

app.post("/api/local/pipeline/jobs", asyncRoute(async (request, response) => {
  const id = await createPipelineJob(request.body);
  response.status(202).json({ jobId: id });
}));

app.post("/api/local/pipeline/jobs/:id/pause", asyncRoute(async (request, response) => {
  await withConnection((connection) => connection.run(
    "UPDATE partmaster_pipeline_jobs SET status = 'paused' WHERE id = $id AND status IN ('queued', 'running')", { id: request.params.id },
  ));
  response.json({ ok: true });
}));

app.post("/api/local/pipeline/jobs/:id/resume", asyncRoute(async (request, response) => {
  const resumed = await withConnection(async (connection) => {
    await connection.run(
      "UPDATE partmaster_pipeline_jobs SET status = 'queued', phase = 'queued', completed_at = NULL, last_error = NULL WHERE id = $id AND status IN ('paused', 'failed')",
      { id: request.params.id },
    );
    const reader = await connection.runAndReadAll("SELECT status FROM partmaster_pipeline_jobs WHERE id = $id", { id: request.params.id });
    return reader.getRowObjectsJson()[0]?.status === "queued";
  });
  if (resumed) scheduleFullPipeline(request.params.id);
  response.json({ ok: true, resumed });
}));

async function pendingPagesForDatasets(datasetIds = []) {
  return withConnection(async (connection) => {
    if (!datasetIds.length) {
      const reader = await connection.runAndReadAll("SELECT count(*) AS count FROM partmaster_offline_source_pages WHERE status = 'pending'");
      return Number(reader.getRowObjectsJson()[0]?.count || 0);
    }
    const quotedIds = datasetIds.map(quoteString).join(", ");
    const reader = await connection.runAndReadAll(
      `SELECT count(DISTINCT pages.source_url) AS count
       FROM partmaster_offline_source_pages pages
       JOIN partmaster_offline_part_sources sources ON sources.source_url = pages.source_url
       WHERE pages.status = 'pending' AND sources.dataset_id IN (${quotedIds})`,
    );
    return Number(reader.getRowObjectsJson()[0]?.count || 0);
  });
}

async function runPipelineSchedule(schedule, { manual = false } = {}) {
  const datasetIds = String(schedule.dataset_ids || "").split(",").filter(Boolean);
  const pagesLeft = await pendingPagesForDatasets(datasetIds);
  const requestedBudget = schedule.run_all_remaining ? pagesLeft : Number(schedule.online_budget || 0);
  const budget = Math.min(PIPELINE_MAX_ONLINE_BUDGET, pagesLeft, requestedBudget);
  const now = new Date();
  const nextRun = schedule.schedule_type === "daily" ? nextDailyRun(schedule.time_of_day, now) : null;
  if (!budget) {
    await withConnection((connection) => connection.run(
      `UPDATE partmaster_pipeline_schedules SET last_run_at = current_timestamp, last_status = 'no_work',
       enabled = $enabled, next_run_at = $nextRun, updated_at = current_timestamp WHERE id = $id`,
      { id: schedule.id, enabled: schedule.schedule_type === "daily", nextRun: nextRun ? localTimestamp(nextRun) : null },
    ));
    return { jobId: null, pagesLeft: 0 };
  }
  const jobId = await createPipelineJob({
    name: `${schedule.name}${manual ? " — run now" : " — scheduled"}`,
    continueOnline: true,
    importMissing: false,
    onlineBudget: budget,
    datasetIds,
  });
  await withConnection((connection) => connection.run(
    `UPDATE partmaster_pipeline_schedules SET last_run_at = current_timestamp, last_job_id = $jobId,
     last_status = 'started', enabled = $enabled, next_run_at = $nextRun, updated_at = current_timestamp WHERE id = $id`,
    { id: schedule.id, jobId, enabled: schedule.schedule_type === "daily", nextRun: nextRun ? localTimestamp(nextRun) : null },
  ));
  return { jobId, pagesLeft, budget };
}

app.get("/api/local/pipeline/schedules", asyncRoute(async (_request, response) => {
  const result = await withConnection(async (connection) => {
    const schedulesReader = await connection.runAndReadAll(
      `SELECT schedules.*, jobs.status AS job_status, jobs.online_checked, jobs.online_budget AS job_budget,
       jobs.completed_at AS job_completed_at, jobs.last_error AS job_error
       FROM partmaster_pipeline_schedules schedules
       LEFT JOIN partmaster_pipeline_jobs jobs ON jobs.id = schedules.last_job_id
       ORDER BY schedules.enabled DESC, schedules.next_run_at NULLS LAST, schedules.created_at DESC`,
    );
    const activeReader = await connection.runAndReadAll(
      "SELECT id, name, status, phase, online_checked, online_budget FROM partmaster_pipeline_jobs WHERE status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
    );
    return { schedules: schedulesReader.getRowObjectsJson(), activeJob: activeReader.getRowObjectsJson()[0] || null };
  });
  response.json(result);
}));

app.post("/api/local/pipeline/schedules", asyncRoute(async (request, response) => {
  const scheduleType = request.body.scheduleType === "daily" ? "daily" : "once";
  const timeOfDay = scheduleType === "daily" ? String(request.body.timeOfDay || "22:00") : null;
  const runAt = scheduleType === "once" ? String(request.body.runAt || "") : null;
  const nextRun = scheduleNextRun({ scheduleType, runAt, timeOfDay });
  if (scheduleType === "once" && nextRun <= new Date()) throw new Error("Choose a future date and time for a one-time job.");
  const requestedBudget = Number(request.body.onlineBudget);
  const onlineBudget = Math.max(1, Math.min(PIPELINE_MAX_ONLINE_BUDGET, Number.isFinite(requestedBudget) ? requestedBudget : 10000));
  const datasetIds = Array.isArray(request.body.datasetIds) ? request.body.datasetIds.map(String).filter(Boolean) : [];
  const id = randomUUID();
  await withConnection((connection) => connection.run(
    `INSERT INTO partmaster_pipeline_schedules
     (id, name, schedule_type, enabled, run_at, time_of_day, online_budget, dataset_ids, run_all_remaining, next_run_at)
     VALUES ($id, $name, $scheduleType, true, $runAt, $timeOfDay, $onlineBudget, $datasetIds, $runAllRemaining, $nextRunAt)`,
    {
      id,
      name: String(request.body.name || (scheduleType === "daily" ? "Nightly enrichment" : "Scheduled enrichment")).trim().slice(0, 200),
      scheduleType,
      runAt,
      timeOfDay,
      onlineBudget,
      datasetIds: datasetIds.join(",") || null,
      runAllRemaining: Boolean(request.body.runAllRemaining),
      nextRunAt: localTimestamp(nextRun),
    },
  ));
  response.status(201).json({ id, nextRunAt: localTimestamp(nextRun) });
}));

app.patch("/api/local/pipeline/schedules/:id", asyncRoute(async (request, response) => {
  const existing = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll("SELECT * FROM partmaster_pipeline_schedules WHERE id = $id", { id: request.params.id });
    return reader.getRowObjectsJson()[0];
  });
  if (!existing) return response.status(404).json({ error: "Schedule not found." });
  const enabled = request.body.enabled == null ? Boolean(existing.enabled) : Boolean(request.body.enabled);
  let nextRun = existing.next_run_at;
  if (enabled && !existing.enabled) {
    nextRun = localTimestamp(scheduleNextRun({ scheduleType: existing.schedule_type, runAt: existing.run_at, timeOfDay: existing.time_of_day }));
  }
  await withConnection((connection) => connection.run(
    "UPDATE partmaster_pipeline_schedules SET enabled = $enabled, next_run_at = $nextRun, updated_at = current_timestamp WHERE id = $id",
    { id: request.params.id, enabled, nextRun },
  ));
  response.json({ ok: true, enabled });
}));

app.delete("/api/local/pipeline/schedules/:id", asyncRoute(async (request, response) => {
  await withConnection((connection) => connection.run("DELETE FROM partmaster_pipeline_schedules WHERE id = $id", { id: request.params.id }));
  response.json({ ok: true });
}));

app.post("/api/local/pipeline/schedules/:id/run", asyncRoute(async (request, response) => {
  const schedule = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll("SELECT * FROM partmaster_pipeline_schedules WHERE id = $id", { id: request.params.id });
    return reader.getRowObjectsJson()[0];
  });
  if (!schedule) return response.status(404).json({ error: "Schedule not found." });
  const result = await runPipelineSchedule(schedule, { manual: true });
  response.status(result.jobId ? 202 : 200).json(result);
}));

async function checkPipelineSchedules() {
  if (schedulerChecking || shuttingDown) return;
  schedulerChecking = true;
  try {
    const due = await withConnection(async (connection) => {
      const reader = await connection.runAndReadAll(
        "SELECT * FROM partmaster_pipeline_schedules WHERE enabled = true AND next_run_at <= current_timestamp ORDER BY next_run_at LIMIT 1",
      );
      return reader.getRowObjectsJson()[0];
    });
    if (due) await runPipelineSchedule(due);
  } catch (error) {
    if (error.status !== 409) console.error(`Scheduled enrichment check failed: ${error.message}`);
  } finally {
    schedulerChecking = false;
  }
}

app.get("/api/local/pipeline/catalog", asyncRoute(async (request, response) => {
  const query = String(request.query.q || "").trim().toLowerCase();
  const limit = Math.max(10, Math.min(200, Number(request.query.limit) || 50));
  const result = await withConnection(async (connection) => {
    const values = {};
    let condition = "";
    if (query) {
      condition = "WHERE lower(concat_ws(' ', manufacturer, part_number, description, family_name, extracted_attributes_json)) LIKE $query";
      values.query = `%${query}%`;
    }
    const rowsReader = await connection.runAndReadAll(
      `SELECT * FROM partmaster_offline_parts ${condition} ORDER BY occurrence_count DESC LIMIT ${limit}`, values,
    );
    const statsReader = await connection.runAndReadAll(
      `SELECT count(*) AS unique_parts, coalesce(sum(occurrence_count), 0) AS raw_occurrences,
       count(*) FILTER (WHERE extracted_attribute_count > 0) AS attributed_parts,
       coalesce(sum(extracted_attribute_count), 0) AS attribute_facts,
       count(*) FILTER (WHERE online_status = 'verified') AS online_verified_parts
       ,(SELECT count(*) FROM partmaster_offline_source_pages WHERE status = 'pending') AS pending_source_pages
       ,(SELECT count(*) FROM partmaster_offline_source_pages WHERE status != 'pending') AS processed_source_pages
       FROM partmaster_offline_parts`,
    );
    return { rows: rowsReader.getRowObjectsJson(), stats: statsReader.getRowObjectsJson()[0] };
  });
  response.json(result);
}));

app.get("/api/local/pipeline/sources", asyncRoute(async (_request, response) => {
  const discoveredFiles = await listInboxDataFiles({ partsOnly: true });
  const databaseCoverage = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      `WITH latest AS (
        SELECT * EXCLUDE (rank) FROM (
          SELECT datasets.*, row_number() OVER (PARTITION BY source_file ORDER BY
           EXISTS (SELECT 1 FROM partmaster_offline_part_sources indexed WHERE indexed.dataset_id = datasets.id) DESC,
           imported_at DESC) AS rank
          FROM partmaster_datasets datasets
        ) ranked WHERE rank = 1
       )
       SELECT latest.id AS dataset_id, latest.name, latest.source_file, latest.row_count AS raw_rows,
        coalesce(processing.usable_rows, 0) AS usable_rows,
        coalesce(processing.invalid_rows, 0) AS invalid_rows,
        coalesce(processing.unique_parts, 0) AS unique_parts,
        processing.dataset_id IS NOT NULL AS is_indexed,
        processing.scanned_at,
        count(DISTINCT sources.part_key) FILTER (WHERE parts.part_key IS NOT NULL) AS master_parts,
        count(DISTINCT sources.part_key) FILTER (WHERE parts.extracted_attribute_count > 0) AS parts_with_facts,
        coalesce(sum(parts.extracted_attribute_count), 0) AS product_facts,
        count(DISTINCT sources.part_key) FILTER (WHERE parts.online_status = 'verified') AS online_verified_parts,
        count(DISTINCT nullif(trim(sources.source_url), '')) AS source_pages,
        count(DISTINCT sources.source_url) FILTER (WHERE pages.status != 'pending') AS processed_source_pages,
        count(DISTINCT sources.source_url) FILTER (WHERE pages.status = 'pending') AS pending_source_pages
       FROM latest
       LEFT JOIN partmaster_source_processing processing ON processing.dataset_id = latest.id
       LEFT JOIN partmaster_offline_part_sources sources ON sources.dataset_id = latest.id
       LEFT JOIN partmaster_offline_parts parts ON parts.part_key = sources.part_key
       LEFT JOIN partmaster_offline_source_pages pages ON pages.source_url = sources.source_url
       GROUP BY latest.id, latest.name, latest.source_file, latest.row_count, latest.imported_at,
        processing.dataset_id, processing.usable_rows, processing.invalid_rows, processing.unique_parts, processing.scanned_at
       ORDER BY latest.row_count DESC`,
    );
    const summaryReader = await connection.runAndReadAll(
      `SELECT
        count(DISTINCT sources.part_key) AS raw_unique_parts,
        count(DISTINCT sources.part_key) FILTER (WHERE parts.part_key IS NOT NULL) AS master_parts,
        count(DISTINCT sources.part_key) FILTER (WHERE parts.extracted_attribute_count > 0) AS parts_with_facts,
        (SELECT coalesce(sum(extracted_attribute_count), 0) FROM partmaster_offline_parts) AS product_facts,
        (SELECT count(*) FROM partmaster_offline_source_pages) AS source_pages,
        (SELECT count(*) FROM partmaster_offline_source_pages WHERE status != 'pending') AS processed_source_pages,
        (SELECT count(*) FROM partmaster_offline_source_pages WHERE status = 'pending') AS pending_source_pages
       FROM partmaster_offline_part_sources sources
       LEFT JOIN partmaster_offline_parts parts ON parts.part_key = sources.part_key`,
    );
    return { rows: reader.getRowObjectsJson(), summary: summaryReader.getRowObjectsJson()[0] };
  });
  const rowsBySource = new Map(databaseCoverage.rows.map((row) => [row.source_file, row]));
  const sources = discoveredFiles.map((file) => {
    const indexed = rowsBySource.get(file.name);
    if (!indexed) return {
      dataset_id: null, name: file.name.replace(/\.[^.]+$/, ""), source_file: file.name, source_bytes: file.bytes,
      modified_at: file.modifiedAt, import_status: "not_imported", raw_rows: 0, usable_rows: 0, invalid_rows: 0,
      unique_parts: 0, master_parts: 0, remaining_master_parts: null, parts_with_facts: 0,
      remaining_fact_parts: null, product_facts: 0, online_verified_parts: 0, source_pages: 0,
      processed_source_pages: 0, pending_source_pages: 0, master_coverage_percent: null,
    };
    const uniqueParts = Number(indexed.unique_parts || 0);
    const masterParts = Number(indexed.master_parts || 0);
    const partsWithFacts = Number(indexed.parts_with_facts || 0);
    const isIndexed = Boolean(indexed.is_indexed);
    return {
      ...indexed, source_bytes: file.bytes, modified_at: file.modifiedAt,
      import_status: isIndexed ? "indexed" : "imported_not_indexed",
      remaining_master_parts: isIndexed ? Math.max(0, uniqueParts - masterParts) : null,
      remaining_fact_parts: isIndexed ? Math.max(0, masterParts - partsWithFacts) : null,
      master_coverage_percent: isIndexed ? (uniqueParts ? Math.round((masterParts / uniqueParts) * 1000) / 10 : 100) : null,
    };
  });
  const importedFiles = sources.filter((source) => source.dataset_id).length;
  const indexedFiles = sources.filter((source) => source.import_status === "indexed").length;
  const knownRawRows = sources.reduce((sum, source) => sum + Number(source.raw_rows || 0), 0);
  const indexedRawRows = sources.filter((source) => source.import_status === "indexed").reduce((sum, source) => sum + Number(source.raw_rows || 0), 0);
  const usableRows = sources.reduce((sum, source) => sum + Number(source.usable_rows || 0), 0);
  const invalidRows = sources.filter((source) => source.import_status === "indexed").reduce((sum, source) => sum + Number(source.invalid_rows || 0), 0);
  const rawUniqueParts = Number(databaseCoverage.summary.raw_unique_parts || 0);
  const masterParts = Number(databaseCoverage.summary.master_parts || 0);
  const partsWithFacts = Number(databaseCoverage.summary.parts_with_facts || 0);
  response.json({
    sources: sources.sort((left, right) => Number(right.raw_rows || 0) - Number(left.raw_rows || 0) || left.source_file.localeCompare(right.source_file)),
    rawDataPath: RAWDATA_ROOT,
    summary: {
      discovered_files: sources.length, imported_files: importedFiles, indexed_files: indexedFiles,
      unimported_files: sources.length - importedFiles, unindexed_files: sources.length - indexedFiles,
      known_raw_rows: knownRawRows, indexed_raw_rows: indexedRawRows,
      pending_scan_rows: Math.max(0, knownRawRows - indexedRawRows), usable_rows: usableRows,
      invalid_rows: invalidRows, raw_unique_parts: rawUniqueParts,
      master_parts: masterParts, remaining_master_parts: Math.max(0, rawUniqueParts - masterParts),
      master_coverage_percent: rawUniqueParts ? Math.round((masterParts / rawUniqueParts) * 1000) / 10 : 0,
      parts_with_facts: partsWithFacts, remaining_fact_parts: Math.max(0, masterParts - partsWithFacts),
      product_facts: Number(databaseCoverage.summary.product_facts || 0),
      source_pages: Number(databaseCoverage.summary.source_pages || 0),
      processed_source_pages: Number(databaseCoverage.summary.processed_source_pages || 0),
      pending_source_pages: Number(databaseCoverage.summary.pending_source_pages || 0),
    },
  });
}));

app.get("/api/local/master-dashboard", asyncRoute(async (_request, response) => {
  const dashboard = await withConnection(async (connection) => {
    const summaryReader = await connection.runAndReadAll(
      `SELECT count(*) AS unique_parts, coalesce(sum(occurrence_count), 0) AS usable_occurrences,
       greatest(0, coalesce(sum(occurrence_count), 0) - count(*)) AS duplicate_occurrences,
       count(DISTINCT manufacturer_norm) AS manufacturers, count(DISTINCT family_name) AS families,
       count(*) FILTER (WHERE description IS NULL OR trim(description) = '') AS missing_descriptions,
       count(*) FILTER (WHERE family_name IS NULL OR family_name = 'General Part') AS general_parts,
       count(*) FILTER (WHERE extracted_attribute_count > 0) AS parts_with_facts,
       coalesce(sum(extracted_attribute_count), 0) AS product_facts,
       count(*) FILTER (WHERE online_status = 'verified') AS online_verified_parts,
       count(*) FILTER (WHERE confidence >= .9) AS high_confidence_parts,
       count(*) FILTER (WHERE confidence < .7) AS low_confidence_parts
       FROM partmaster_offline_parts`,
    );
    const manufacturerReader = await connection.runAndReadAll(
      `SELECT CASE manufacturer_norm WHEN 'HARLEYDAVIDSON' THEN 'Harley-Davidson'
        WHEN 'BMW' THEN 'BMW' WHEN 'KTM' THEN 'KTM' WHEN 'HONDA' THEN 'Honda' WHEN 'YAMAHA' THEN 'Yamaha'
        WHEN 'SUZUKI' THEN 'Suzuki' WHEN 'KAWASAKI' THEN 'Kawasaki' ELSE manufacturer_norm END AS label, count(*) AS parts,
       count(*) FILTER (WHERE extracted_attribute_count > 0) AS with_facts,
       count(*) FILTER (WHERE online_status = 'verified') AS verified
       FROM partmaster_offline_parts GROUP BY manufacturer_norm ORDER BY parts DESC`,
    );
    const familyReader = await connection.runAndReadAll(
      `SELECT coalesce(family_name, 'Unclassified') AS label, count(*) AS parts,
       count(*) FILTER (WHERE extracted_attribute_count > 0) AS with_facts
       FROM partmaster_offline_parts GROUP BY family_name ORDER BY parts DESC LIMIT 16`,
    );
    const evidenceReader = await connection.runAndReadAll(
      `SELECT online_status AS label, count(*) AS parts FROM partmaster_offline_parts
       GROUP BY online_status ORDER BY parts DESC`,
    );
    const pagesReader = await connection.runAndReadAll(
      `SELECT count(*) AS source_pages,
       count(*) FILTER (WHERE status = 'pending') AS pending_pages,
       count(*) FILTER (WHERE status != 'pending') AS processed_pages,
       count(*) FILTER (WHERE status = 'failed') AS failed_pages
       FROM partmaster_offline_source_pages`,
    );
    const pipelineReader = await connection.runAndReadAll(
      `SELECT total_rows, scanned_rows, invalid_rows, unique_parts, duplicates_removed,
       attributed_parts, source_pages, online_checked
       FROM partmaster_pipeline_jobs
       WHERE mode = 'full' AND status = 'completed'
       ORDER BY completed_at DESC LIMIT 1`,
    );
    const summary = summaryReader.getRowObjectsJson()[0];
    const pipeline = pipelineReader.getRowObjectsJson()[0];
    if (pipeline) {
      summary.raw_rows = pipeline.total_rows;
      summary.scanned_rows = pipeline.scanned_rows;
      summary.raw_rows_remaining = Math.max(0, Number(pipeline.total_rows || 0) - Number(pipeline.scanned_rows || 0));
      summary.invalid_rows = pipeline.invalid_rows;
      summary.usable_occurrences = Math.max(0, Number(pipeline.total_rows || 0) - Number(pipeline.invalid_rows || 0));
      summary.duplicate_occurrences = pipeline.duplicates_removed;
      summary.master_parts_remaining = Math.max(0, Number(pipeline.unique_parts || 0) - Number(summary.unique_parts || 0));
      summary.parts_missing_facts = Math.max(0, Number(summary.unique_parts || 0) - Number(summary.parts_with_facts || 0));
    }
    return {
      generated_at: new Date().toISOString(),
      summary,
      source_pages: pagesReader.getRowObjectsJson()[0],
      manufacturers: manufacturerReader.getRowObjectsJson(),
      families: familyReader.getRowObjectsJson(),
      evidence: evidenceReader.getRowObjectsJson(),
    };
  });
  response.json(dashboard);
}));

app.get("/api/local/master-catalog/filters", asyncRoute(async (_request, response) => {
  const filters = await withConnection(async (connection) => {
    const manufacturers = await connection.runAndReadAll(
      `SELECT CASE manufacturer_norm WHEN 'HARLEYDAVIDSON' THEN 'Harley-Davidson'
       WHEN 'BMW' THEN 'BMW' WHEN 'KTM' THEN 'KTM' WHEN 'HONDA' THEN 'Honda' WHEN 'YAMAHA' THEN 'Yamaha'
       WHEN 'SUZUKI' THEN 'Suzuki' WHEN 'KAWASAKI' THEN 'Kawasaki' ELSE manufacturer_norm END AS value, count(*) AS count
       FROM partmaster_offline_parts GROUP BY manufacturer_norm ORDER BY value`,
    );
    const families = await connection.runAndReadAll(
      "SELECT coalesce(family_name, 'Unclassified') AS value, count(*) AS count FROM partmaster_offline_parts GROUP BY family_name ORDER BY count DESC, value LIMIT 200",
    );
    return { manufacturers: manufacturers.getRowObjectsJson(), families: families.getRowObjectsJson() };
  });
  response.json(filters);
}));

app.get("/api/local/master-catalog", asyncRoute(async (request, response) => {
  const page = Math.max(1, Number(request.query.page) || 1);
  const pageSize = Math.max(10, Math.min(200, Number(request.query.pageSize) || 50));
  const conditions = [];
  const values = {};
  const query = String(request.query.q || "").trim().toLowerCase();
  if (query) {
    conditions.push("lower(concat_ws(' ', manufacturer, part_number, description, family_name, side, position, extracted_attributes_json)) LIKE $query");
    values.query = `%${query}%`;
  }
  if (request.query.manufacturer) { conditions.push("manufacturer_norm = $manufacturer"); values.manufacturer = normalizePartNumber(normalizeManufacturer(request.query.manufacturer)); }
  if (request.query.family) { conditions.push("coalesce(family_name, 'Unclassified') = $family"); values.family = String(request.query.family); }
  if (request.query.onlineStatus) { conditions.push("online_status = $onlineStatus"); values.onlineStatus = String(request.query.onlineStatus); }
  if (request.query.factStatus === "with_facts") conditions.push("extracted_attribute_count > 0");
  if (request.query.factStatus === "missing_facts") conditions.push("extracted_attribute_count = 0");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sortColumns = {
    occurrences: "occurrence_count", manufacturer: "manufacturer_norm", part_number: "part_number_norm",
    family: "family_name", facts: "extracted_attribute_count", confidence: "confidence", updated: "updated_at",
  };
  const sort = sortColumns[request.query.sort] || "occurrence_count";
  const direction = String(request.query.direction).toLowerCase() === "asc" ? "ASC" : "DESC";
  const result = await withConnection(async (connection) => {
    const countReader = await connection.runAndReadAll(`SELECT count(*) AS count FROM partmaster_offline_parts ${where}`, values);
    const total = Number(countReader.getRowObjectsJson()[0].count);
    const rowsReader = await connection.runAndReadAll(
      `SELECT part_key, CASE manufacturer_norm WHEN 'HARLEYDAVIDSON' THEN 'Harley-Davidson'
        WHEN 'BMW' THEN 'BMW' WHEN 'KTM' THEN 'KTM' WHEN 'HONDA' THEN 'Honda' WHEN 'YAMAHA' THEN 'Yamaha'
        WHEN 'SUZUKI' THEN 'Suzuki' WHEN 'KAWASAKI' THEN 'Kawasaki' ELSE manufacturer END AS manufacturer,
       part_number, description, family_name, component_scope, side, position,
       extracted_attributes_json, extracted_attribute_count, occurrence_count, dataset_count, application_count,
       source_page_count, best_source_url, confidence, attribute_status, online_status, updated_at
       FROM partmaster_offline_parts ${where}
       ORDER BY ${sort} ${direction} NULLS LAST, manufacturer_norm, part_number_norm
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, values,
    );
    return { rows: rowsReader.getRowObjectsJson(), total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
  });
  response.json(result);
}));

app.post("/api/local/pipeline/exports", asyncRoute(async (_request, response) => {
  const attributeKeys = [...new Set(CATEGORY_ATTRIBUTE_SCHEMAS.flatMap((schema) => schema.attributes.map((attribute) => attribute.key)))]
    .filter((key) => !["side", "position"].includes(key));
  const attributeColumns = attributeKeys.map((key) =>
    `json_extract_string(extracted_attributes_json, '$.${key}') AS ${quoteIdentifier(key)}`).join(",\n       ");
  const exports = await withConnection(async (connection) => {
    const stamp = Date.now();
    const catalogFilename = `full-enriched-parts-${stamp}.csv`;
    const sourcesFilename = `full-part-source-traceability-${stamp}.csv`;
    const pagesFilename = `full-source-page-quality-${stamp}.csv`;
    const catalogPath = join(EXPORT_ROOT, catalogFilename);
    const sourcesPath = join(EXPORT_ROOT, sourcesFilename);
    const pagesPath = join(EXPORT_ROOT, pagesFilename);
    await connection.run(
      `COPY (SELECT manufacturer AS "Manufacturer", part_number AS "OEM Part Number",
       description AS "Description", family_name AS "Part Family", component_scope AS "Component Scope",
       side AS "Side", position AS "Position", ${attributeColumns},
       occurrence_count AS "Raw Occurrences", dataset_count AS "Source Datasets",
       application_count AS "Applications", source_page_count AS "Source Pages",
       extracted_attribute_count AS "Extracted Facts", confidence AS "Confidence",
       attribute_status AS "Attribute Status", online_status AS "Online Evidence Status",
       best_source_url AS "Best Source URL", manufacturer_norm AS "Normalized Manufacturer",
       part_number_norm AS "Normalized OEM Number", part_key AS "Global Part Key"
       FROM partmaster_offline_parts ORDER BY manufacturer_norm, part_number_norm)
       TO ${quoteString(catalogPath)} (FORMAT CSV, HEADER true)`,
    );
    await connection.run(
      `COPY (SELECT sources.manufacturer AS "Manufacturer", sources.part_number AS "OEM Part Number",
       datasets.name AS "Dataset", datasets.source_file AS "Source File", sources.source_row_id AS "Representative Row",
       sources.description AS "Source Description", sources.year AS "Year", sources.model AS "Model",
       sources.assembly AS "Assembly", sources.item_number AS "Item Number", sources.quantity AS "Quantity",
       sources.occurrence_count AS "Occurrences", sources.source_url AS "Source URL", sources.part_key AS "Global Part Key"
       FROM partmaster_offline_part_sources sources
       LEFT JOIN partmaster_datasets datasets ON datasets.id = sources.dataset_id
       ORDER BY sources.manufacturer_norm, sources.part_number_norm, datasets.name)
       TO ${quoteString(sourcesPath)} (FORMAT CSV, HEADER true)`,
    );
    await connection.run(
      `COPY (SELECT source_host AS "Source Host", source_url AS "Source URL", part_count AS "Unique Parts",
       occurrence_count AS "Raw Occurrences", priority_score AS "Priority Score", status AS "Check Status",
       verified_parts AS "Verified Parts", error_message AS "Error", checked_at AS "Checked At"
       FROM partmaster_offline_source_pages ORDER BY priority_score DESC)
       TO ${quoteString(pagesPath)} (FORMAT CSV, HEADER true)`,
    );
    return Promise.all([
      { filename: catalogFilename, path: catalogPath },
      { filename: sourcesFilename, path: sourcesPath },
      { filename: pagesFilename, path: pagesPath },
    ].map(async (item) => ({ ...item, bytes: (await stat(item.path)).size, downloadUrl: `/api/local/exports/${encodeURIComponent(item.filename)}` })));
  });
  response.json({ exports });
}));

app.get("/api/local/exports/:filename", asyncRoute(async (request, response) => {
  const filename = basename(String(request.params.filename || ""));
  if (!filename.toLowerCase().endsWith(".csv")) return response.status(400).json({ error: "Only CSV exports can be downloaded." });
  const exportPath = join(EXPORT_ROOT, filename);
  await stat(exportPath);
  response.download(exportPath, filename);
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

app.post("/api/local/datasets/:id/rows/:rowId/enhance", asyncRoute(async (request, response) => {
  const preview = await previewRowEnhancement(request.params.id, request.params.rowId);
  if (request.body.apply && preview.confidence >= 0.94 && Object.keys(preview.changes).length) {
    await applyMissingRowChanges(preview.dataset, preview.columns, request.params.rowId, preview.changes);
  }
  response.json({
    rowId: request.params.rowId,
    changes: preview.changes,
    confidence: preview.confidence,
    reason: preview.reason,
    evidenceUrl: preview.sourceUrl || null,
    evidenceTitle: preview.pageTitle || null,
    matchedItem: preview.matchedItem || null,
    vehicleMapping: preview.vehicleMapping || null,
    catalogItemCount: preview.catalogItemCount || 0,
    applied: Boolean(request.body.apply && preview.confidence >= 0.94 && Object.keys(preview.changes).length),
  });
}));

app.post("/api/local/datasets/:id/row-enhancement-jobs", asyncRoute(async (request, response) => {
  const rowIds = [...new Set((request.body.rowIds || []).map(Number).filter((value) => Number.isInteger(value) && value > 0))].slice(0, 200);
  if (!rowIds.length) return response.status(400).json({ error: "Select at least one visible row to enhance." });
  const job = await withConnection(async (connection) => {
    await getDataset(connection, request.params.id);
    const id = randomUUID();
    await connection.run(
      `INSERT INTO partmaster_row_enhancement_jobs
       (id, dataset_id, status, total_count) VALUES ($id, $datasetId, 'queued', $total)`,
      { id, datasetId: request.params.id, total: rowIds.length },
    );
    for (const rowId of rowIds) {
      await connection.run(
        `INSERT INTO partmaster_row_enhancement_items (id, job_id, row_id)
         VALUES ($id, $jobId, $rowId)`,
        { id: randomUUID(), jobId: id, rowId },
      );
    }
    return { id, datasetId: request.params.id, status: "queued", totalCount: rowIds.length };
  });
  scheduleRowEnhancementJob(job.id);
  response.status(202).json({ job });
}));

app.get("/api/local/row-enhancement-jobs/:id", asyncRoute(async (request, response) => {
  const result = await withConnection(async (connection) => {
    const jobReader = await connection.runAndReadAll(
      "SELECT * FROM partmaster_row_enhancement_jobs WHERE id = $id",
      { id: request.params.id },
    );
    const job = jobReader.getRowObjectsJson()[0];
    if (!job) {
      const error = new Error("Row enhancement job not found.");
      error.status = 404;
      throw error;
    }
    const itemReader = await connection.runAndReadAll(
      `SELECT row_id, status, suggested_changes, confidence, evidence_url, notes
       FROM partmaster_row_enhancement_items WHERE job_id = $id ORDER BY row_id`,
      { id: request.params.id },
    );
    return { job, items: itemReader.getRowObjectsJson() };
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
       (SELECT max(candidate.source_row_id) FROM partmaster_enrichment_candidates candidate WHERE candidate.job_id = jobs.id) AS last_source_row_id,
       (SELECT coalesce(sum(candidate.extracted_attribute_count), 0) FROM partmaster_enrichment_candidates candidate WHERE candidate.job_id = jobs.id) AS attribute_fact_count,
       (SELECT count(*) FROM partmaster_enrichment_candidates candidate WHERE candidate.job_id = jobs.id AND candidate.extracted_attribute_count > 0) AS attributed_candidate_count
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
       (SELECT max(candidate.source_row_id) FROM partmaster_enrichment_candidates candidate WHERE candidate.job_id = jobs.id) AS last_source_row_id,
       (SELECT coalesce(sum(candidate.extracted_attribute_count), 0) FROM partmaster_enrichment_candidates candidate WHERE candidate.job_id = jobs.id) AS attribute_fact_count,
       (SELECT count(*) FROM partmaster_enrichment_candidates candidate WHERE candidate.job_id = jobs.id AND candidate.extracted_attribute_count > 0) AS attributed_candidate_count
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

app.get("/api/local/enrichment/jobs/:id/transformation", asyncRoute(async (request, response) => {
  const result = await withConnection(async (connection) => {
    const jobReader = await connection.runAndReadAll(
      `SELECT jobs.*, datasets.name AS dataset_name, datasets.table_name
       FROM partmaster_enrichment_jobs jobs
       JOIN partmaster_datasets datasets ON datasets.id = jobs.dataset_id
       WHERE jobs.id = $id`,
      { id: request.params.id },
    );
    const job = jobReader.getRowObjectsJson()[0];
    if (!job) {
      const error = new Error("Enrichment job not found.");
      error.status = 404;
      throw error;
    }
    const examplesReader = await connection.runAndReadAll(
      `SELECT id, source_row_id, part_number_raw, part_number_norm, description_raw,
       enriched_part_number, enriched_description, family_name, status, confidence
       FROM partmaster_enrichment_candidates WHERE job_id = $jobId
       ORDER BY CASE status WHEN 'enriched' THEN 0 WHEN 'needs_review' THEN 1 WHEN 'conflict' THEN 2 ELSE 3 END,
        confidence DESC NULLS LAST, source_row_id LIMIT 50`,
      { jobId: request.params.id },
    );
    const examples = examplesReader.getRowObjectsJson();
    const requestedCandidateId = String(request.query.candidateId || "");
    const selectedId = examples.some((example) => example.id === requestedCandidateId)
      ? requestedCandidateId
      : examples[0]?.id;
    if (!selectedId) return { job, examples, candidate: null, raw: null };
    const candidateReader = await connection.runAndReadAll(
      "SELECT * FROM partmaster_enrichment_candidates WHERE id = $candidateId AND job_id = $jobId",
      { candidateId: selectedId, jobId: request.params.id },
    );
    const candidate = candidateReader.getRowObjectsJson()[0];
    const rawReader = await connection.runAndReadAll(
      `SELECT * FROM ${quoteIdentifier(job.table_name)} WHERE _row_id = $rowId`,
      { rowId: candidate.source_row_id },
    );
    return { job, examples, candidate, raw: rawReader.getRowObjectsJson()[0] || null };
  });
  response.json(result);
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
  const candidateIds = Array.isArray(request.body?.candidateIds) ? request.body.candidateIds.filter(Boolean) : [];
  const resumable = await withConnection(async (connection) => {
    const jobReader = await connection.runAndReadAll("SELECT status FROM partmaster_enrichment_jobs WHERE id = $id", { id: request.params.id });
    const job = jobReader.getRowObjectsJson()[0];
    if (!job || !["completed", "paused", "failed"].includes(job.status)) return false;
    const idFilter = candidateIds.length ? "AND id IN (SELECT unnest($candidateIds))" : "";
    await connection.run(
      `UPDATE partmaster_enrichment_candidates SET status = 'pending', processed_at = NULL, decision_notes = NULL
       WHERE job_id = $id AND status IN ('needs_review', 'not_found', 'failed') AND decision IS NULL ${idFilter}`,
      { id: request.params.id, candidateIds },
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
    } else if (request.query.reviewOnly === "true") {
      conditions.push("status IN ('needs_review', 'conflict', 'not_found', 'failed') AND decision IS NULL");
    }
    if (request.query.q) {
      conditions.push(`lower(concat_ws(' ', coalesce(CAST(source_row_id AS VARCHAR), ''), coalesce(manufacturer_raw, ''),
       coalesce(year, ''), coalesce(model, ''), coalesce(assembly, ''), coalesce(item_number, ''),
       coalesce(part_number_raw, ''), coalesce(enriched_part_number, ''), coalesce(description_raw, ''),
       coalesce(enriched_description, ''), coalesce(family_name, ''), coalesce(evidence_title, ''))) LIKE $query`);
      values.query = `%${String(request.query.q).trim().toLowerCase()}%`;
    }
    if (request.query.make) {
      conditions.push("lower(coalesce(manufacturer_raw, '')) LIKE $make");
      values.make = `%${String(request.query.make).trim().toLowerCase()}%`;
    }
    if (request.query.year) {
      conditions.push("coalesce(vehicle_year, year, '') = $year");
      values.year = String(request.query.year).trim();
    }
    if (request.query.category) {
      conditions.push("lower(concat_ws(' ', coalesce(family_name, ''), coalesce(assembly, ''), coalesce(description_raw, ''))) LIKE $category");
      values.category = `%${String(request.query.category).trim().toLowerCase()}%`;
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

app.get("/api/local/review/overview", asyncRoute(async (_request, response) => {
  const overview = await withConnection(async (connection) => {
    const reviewCondition = "status IN ('needs_review', 'conflict', 'not_found', 'failed') AND decision IS NULL";
    const summaryReader = await connection.runAndReadAll(
      `SELECT count(*) AS awaiting_review,
       count(*) FILTER (WHERE status = 'needs_review') AS needs_review,
       count(*) FILTER (WHERE status = 'conflict') AS conflicts,
       count(*) FILTER (WHERE status = 'not_found') AS not_found,
       count(*) FILTER (WHERE status = 'failed') AS failed,
       count(*) FILTER (WHERE trim(coalesce(enriched_part_number, part_number_raw, '')) = '') AS missing_part_numbers,
       count(*) FILTER (WHERE confidence >= .85) AS high_confidence,
       count(*) FILTER (WHERE extracted_attribute_count > 0) AS with_product_facts,
       round(avg(coalesce(confidence, 0)) * 100, 1) AS average_confidence,
       count(DISTINCT coalesce(nullif(trim(manufacturer_raw), ''), nullif(trim(manufacturer_norm), ''), 'Unknown')) AS brands
       FROM partmaster_enrichment_candidates WHERE ${reviewCondition}`,
    );
    const brandsReader = await connection.runAndReadAll(
      `SELECT coalesce(nullif(trim(manufacturer_raw), ''), nullif(trim(manufacturer_norm), ''), 'Unknown') AS brand,
       count(*) AS awaiting_review,
       count(*) FILTER (WHERE status = 'needs_review') AS needs_review,
       count(*) FILTER (WHERE status = 'conflict') AS conflicts,
       count(*) FILTER (WHERE status = 'not_found') AS not_found,
       count(*) FILTER (WHERE status = 'failed') AS failed,
       count(*) FILTER (WHERE trim(coalesce(enriched_part_number, part_number_raw, '')) = '') AS missing_part_numbers,
       count(*) FILTER (WHERE extracted_attribute_count > 0) AS with_product_facts,
       count(DISTINCT coalesce(nullif(trim(family_name), ''), nullif(trim(assembly), ''), 'Unclassified')) AS categories,
       round(avg(coalesce(confidence, 0)) * 100, 1) AS average_confidence
       FROM partmaster_enrichment_candidates WHERE ${reviewCondition}
       GROUP BY 1 ORDER BY awaiting_review DESC, brand`,
    );
    const categoriesReader = await connection.runAndReadAll(
      `SELECT coalesce(nullif(trim(family_name), ''), nullif(trim(assembly), ''), 'Unclassified') AS category,
       count(*) AS awaiting_review,
       count(*) FILTER (WHERE status = 'conflict') AS conflicts,
       count(DISTINCT coalesce(nullif(trim(manufacturer_raw), ''), nullif(trim(manufacturer_norm), ''), 'Unknown')) AS brands
       FROM partmaster_enrichment_candidates WHERE ${reviewCondition}
       GROUP BY 1 ORDER BY awaiting_review DESC, category LIMIT 12`,
    );
    const decisionsReader = await connection.runAndReadAll(
      `SELECT count(*) AS total_decisions,
       count(*) FILTER (WHERE decision = 'approve') AS approved,
       count(*) FILTER (WHERE decision = 'reject') AS rejected,
       count(*) FILTER (WHERE created_at >= current_timestamp - INTERVAL 7 DAY) AS decisions_last_7_days
       FROM partmaster_review_feedback`,
    );
    return {
      summary: summaryReader.getRowObjectsJson()[0],
      brands: brandsReader.getRowObjectsJson(),
      categories: categoriesReader.getRowObjectsJson(),
      decisions: decisionsReader.getRowObjectsJson()[0],
    };
  });
  response.json(overview);
}));

app.get("/api/local/enrichment/candidates/:id/variants", asyncRoute(async (request, response) => {
  const result = await withConnection(async (connection) => {
    const candidateReader = await connection.runAndReadAll(
      "SELECT * FROM partmaster_enrichment_candidates WHERE id = $id",
      { id: request.params.id },
    );
    const candidate = candidateReader.getRowObjectsJson()[0];
    if (!candidate) {
      const error = new Error("Enrichment candidate not found.");
      error.status = 404;
      throw error;
    }
    const familyName = candidate.family_name || inferFamilyName(candidate.description_raw, candidate.assembly);
    const familyKey = normalizeApplicationValue(familyName);
    const reader = await connection.runAndReadAll(
      `SELECT parts.id, parts.part_number, parts.description, parts.component_scope, parts.variant_summary,
       parts.confidence, parts.verification_status, parts.evidence_url,
       max(CASE WHEN attributes.attribute_name = 'side' THEN attributes.attribute_value END) AS side,
       max(CASE WHEN attributes.attribute_name = 'heated' THEN attributes.attribute_value END) AS heated,
       max(CASE WHEN attributes.attribute_name = 'auto_dimming' THEN attributes.attribute_value END) AS auto_dimming,
       max(CASE WHEN attributes.attribute_name = 'power_folding' THEN attributes.attribute_value END) AS power_folding,
       max(CASE WHEN attributes.attribute_name = 'memory' THEN attributes.attribute_value END) AS memory,
       max(CASE WHEN attributes.attribute_name = 'blind_spot' THEN attributes.attribute_value END) AS blind_spot,
       max(CASE WHEN attributes.attribute_name = 'camera' THEN attributes.attribute_value END) AS camera,
       max(CASE WHEN attributes.attribute_name = 'connector_pins' THEN attributes.attribute_value END) AS connector_pins
       FROM partmaster_canonical_parts parts
       JOIN partmaster_part_families families ON families.id = parts.family_id
       LEFT JOIN partmaster_variant_attributes attributes ON attributes.part_id = parts.id
       WHERE parts.manufacturer_norm = $manufacturer AND families.family_key = $familyKey
       GROUP BY parts.id, parts.part_number, parts.description, parts.component_scope, parts.variant_summary,
        parts.confidence, parts.verification_status, parts.evidence_url
       ORDER BY parts.part_number LIMIT 20`,
      { manufacturer: candidate.manufacturer_norm, familyKey },
    );
    const partNumberNorm = normalizePartNumber(candidate.enriched_part_number || candidate.part_number_raw);
    const compatibilityReader = await connection.runAndReadAll(
      `SELECT compatibility.id, compatibility.year, compatibility.model, compatibility.model_code,
       compatibility.assembly, compatibility.evidence_url, compatibility.confidence
       FROM partmaster_part_compatibility compatibility
       JOIN partmaster_canonical_parts parts ON parts.id = compatibility.part_id
       WHERE parts.manufacturer_norm = $manufacturer AND parts.part_number_norm = $partNumber
       ORDER BY compatibility.year, compatibility.model, compatibility.model_code, compatibility.assembly
       LIMIT 250`,
      { manufacturer: candidate.manufacturer_norm, partNumber: partNumberNorm },
    );
    return {
      familyName,
      variants: reader.getRowObjectsJson(),
      compatibility: compatibilityReader.getRowObjectsJson(),
      compatibilitySourceUrl: compatibilityListUrl(candidate),
    };
  });
  response.json(result);
}));

app.post("/api/local/master/parts/:id/check", asyncRoute(async (request, response) => {
  response.json(await checkCanonicalPart(request.params.id));
}));

app.post("/api/local/enrichment/candidates/:id/compatibility", asyncRoute(async (request, response) => {
  const candidate = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      "SELECT * FROM partmaster_enrichment_candidates WHERE id = $id",
      { id: request.params.id },
    );
    return reader.getRowObjectsJson()[0];
  });
  if (!candidate) return response.status(404).json({ error: "Enrichment candidate not found." });
  if (!compatibilityListUrl(candidate)) {
    return response.status(400).json({ error: "This source does not provide a supported compatibility-list URL." });
  }
  const result = await enrichCandidateCompatibility(candidate, {
    force: Boolean(request.body.force),
    sourceUrl: String(request.body.sourceUrl || ""),
    compatibilityText: String(request.body.compatibilityText || ""),
  });
  response.json(result);
}));

app.post("/api/local/master/relationships", asyncRoute(async (request, response) => {
  const relationshipType = String(request.body.relationshipType || "");
  if (!["same_family", "left_right_counterpart", "supersedes", "superseded_by", "interchangeable", "interchangeable_if", "not_interchangeable", "component_of"].includes(relationshipType)) {
    return response.status(400).json({ error: "Choose a supported part relationship type." });
  }
  const relationship = await withConnection(async (connection) => {
    const sourcePartId = String(request.body.sourcePartId || "");
    const targetPartId = String(request.body.targetPartId || "");
    if (!sourcePartId || !targetPartId || sourcePartId === targetPartId) throw new Error("Choose two different canonical parts.");
    const reader = await connection.runAndReadAll(
      `SELECT id FROM partmaster_part_relationships
       WHERE source_part_id = $sourcePartId AND target_part_id = $targetPartId AND relationship_type = $relationshipType`,
      { sourcePartId, targetPartId, relationshipType },
    );
    let id = reader.getRowObjectsJson()[0]?.id;
    if (id) {
      await connection.run(
        `UPDATE partmaster_part_relationships SET conditions = $conditions, confidence = $confidence,
         evidence_url = $evidenceUrl WHERE id = $id`,
        {
          id,
          conditions: String(request.body.conditions || "").trim() || null,
          confidence: Math.max(0, Math.min(1, Number(request.body.confidence) || 0.9)),
          evidenceUrl: String(request.body.evidenceUrl || "").trim() || null,
        },
      );
    } else {
      id = randomUUID();
      await connection.run(
        `INSERT INTO partmaster_part_relationships
         (id, source_part_id, target_part_id, relationship_type, conditions, confidence, evidence_url)
         VALUES ($id, $sourcePartId, $targetPartId, $relationshipType, $conditions, $confidence, $evidenceUrl)`,
        {
          id,
          sourcePartId,
          targetPartId,
          relationshipType,
          conditions: String(request.body.conditions || "").trim() || null,
          confidence: Math.max(0, Math.min(1, Number(request.body.confidence) || 0.9)),
          evidenceUrl: String(request.body.evidenceUrl || "").trim() || null,
        },
      );
    }
    return { id };
  });
  response.json({ relationship });
}));

app.get("/api/local/intelligence/categories", (_request, response) => {
  response.json({ categories: CATEGORY_ATTRIBUTE_SCHEMAS });
});

app.get("/api/local/intelligence/autopilot/jobs", asyncRoute(async (_request, response) => {
  const jobs = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll("SELECT * FROM partmaster_autopilot_jobs ORDER BY created_at DESC LIMIT 50");
    return reader.getRowObjectsJson();
  });
  response.json({ jobs });
}));

app.post("/api/local/intelligence/autopilot/jobs", asyncRoute(async (request, response) => {
  const requestedParts = Math.max(1, Math.min(1000, Number(request.body.requestedParts) || 25));
  const maxOnlineRequests = Math.max(1, Math.min(2000, Number(request.body.maxOnlineRequests) || requestedParts * 2));
  const minConfidence = Math.max(0.8, Math.min(1, Number(request.body.minConfidence) || 0.94));
  const manufacturers = String(request.body.manufacturers || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const categories = String(request.body.categories || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const job = await withConnection(async (connection) => {
    const activeReader = await connection.runAndReadAll("SELECT id FROM partmaster_autopilot_jobs WHERE status IN ('queued', 'running', 'paused') LIMIT 1");
    if (activeReader.getRowObjectsJson().length) { const error = new Error("Finish or resume the existing Autopilot job before starting another."); error.status = 409; throw error; }
    const partsReader = await connection.runAndReadAll(
      `SELECT parts.id, parts.manufacturer, parts.part_number, parts.description, families.family_name,
       scores.overall_score, scores.conflict_risk, scores.missing_fields,
       (100 - scores.overall_score) + scores.conflict_risk * .5
        + CASE WHEN scores.missing_fields LIKE '%evidence%' THEN 15 ELSE 0 END
        + CASE WHEN scores.missing_fields LIKE '%fitment%' THEN 5 ELSE 0 END AS priority_score,
       date_diff('day', coalesce(parts.verified_at, parts.updated_at), current_timestamp) AS age_days
       FROM partmaster_quality_scores scores JOIN partmaster_canonical_parts parts ON parts.id = scores.part_id
       LEFT JOIN partmaster_part_families families ON families.id = parts.family_id
       ORDER BY priority_score DESC, parts.manufacturer, parts.part_number LIMIT 5000`,
    );
    const recheckOlder = Boolean(request.body.recheckOlder);
    const selected = partsReader.getRowObjectsJson().filter((part) => {
      if (manufacturers.length && !manufacturers.some((name) => String(part.manufacturer || "").toLowerCase().includes(name))) return false;
      if (categories.length && !categories.some((name) => `${part.family_name || ""} ${part.description || ""}`.toLowerCase().includes(name))) return false;
      return recheckOlder || part.missing_fields || Number(part.conflict_risk || 0) > 0 || Number(part.age_days || 0) > 180;
    }).slice(0, requestedParts);
    if (!selected.length) throw new Error("No canonical parts match the selected Autopilot filters.");
    const id = randomUUID();
    await connection.run("BEGIN TRANSACTION");
    try {
      await connection.run(
        `INSERT INTO partmaster_autopilot_jobs
         (id, name, status, requested_parts, max_online_requests, min_confidence, manufacturers,
          categories, discover_compatibility, recheck_older, queued_count)
         VALUES ($id, $name, 'queued', $requestedParts, $maxOnlineRequests, $minConfidence,
          $manufacturers, $categories, $discoverCompatibility, $recheckOlder, $queuedCount)`,
        { id, name: String(request.body.name || "Smart master enrichment").trim(), requestedParts, maxOnlineRequests, minConfidence, manufacturers: manufacturers.join(", ") || null, categories: categories.join(", ") || null, discoverCompatibility: request.body.discoverCompatibility !== false, recheckOlder, queuedCount: selected.length },
      );
      for (const part of selected) {
        await connection.run(
          "INSERT INTO partmaster_autopilot_items (id, job_id, part_id, priority_score) VALUES ($id, $jobId, $partId, $priorityScore)",
          { id: randomUUID(), jobId: id, partId: part.id, priorityScore: Number(part.priority_score || 0) },
        );
      }
      await connection.run("COMMIT");
    } catch (error) { await connection.run("ROLLBACK"); throw error; }
    return { id, status: "queued", queuedCount: selected.length };
  });
  scheduleAutopilotJob(job.id);
  response.status(202).json({ job });
}));

app.get("/api/local/intelligence/autopilot/jobs/:id", asyncRoute(async (request, response) => {
  const result = await withConnection(async (connection) => {
    const jobReader = await connection.runAndReadAll("SELECT * FROM partmaster_autopilot_jobs WHERE id = $id", { id: request.params.id });
    const job = jobReader.getRowObjectsJson()[0];
    if (!job) { const error = new Error("Autopilot job not found."); error.status = 404; throw error; }
    const itemsReader = await connection.runAndReadAll(
      `SELECT items.*, parts.manufacturer, parts.part_number, parts.description, families.family_name
       FROM partmaster_autopilot_items items JOIN partmaster_canonical_parts parts ON parts.id = items.part_id
       LEFT JOIN partmaster_part_families families ON families.id = parts.family_id
       WHERE items.job_id = $id ORDER BY coalesce(items.processed_at, items.started_at) DESC NULLS LAST,
        items.priority_score DESC LIMIT 250`, { id: request.params.id },
    );
    return { job, items: itemsReader.getRowObjectsJson() };
  });
  response.json(result);
}));

app.post("/api/local/intelligence/autopilot/jobs/:id/pause", asyncRoute(async (request, response) => {
  await withConnection((connection) => connection.run("UPDATE partmaster_autopilot_jobs SET status = 'paused' WHERE id = $id AND status IN ('queued', 'running')", { id: request.params.id }));
  response.json({ ok: true });
}));

app.post("/api/local/intelligence/autopilot/jobs/:id/resume", asyncRoute(async (request, response) => {
  const workerStillActive = activeAutopilotJobs.has(request.params.id);
  const resumed = await withConnection(async (connection) => {
    if (!workerStillActive) await connection.run("UPDATE partmaster_autopilot_items SET status = 'pending' WHERE job_id = $id AND status = 'processing'", { id: request.params.id });
    await connection.run(`UPDATE partmaster_autopilot_jobs SET status = ${workerStillActive ? "'running'" : "'queued'"}, completed_at = NULL, last_error = NULL WHERE id = $id AND status IN ('paused', 'failed', 'queued')`, { id: request.params.id });
    const reader = await connection.runAndReadAll("SELECT status FROM partmaster_autopilot_jobs WHERE id = $id", { id: request.params.id });
    return ["queued", "running"].includes(reader.getRowObjectsJson()[0]?.status);
  });
  if (resumed && !workerStillActive) scheduleAutopilotJob(request.params.id);
  response.json({ ok: true, resumed });
}));

app.post("/api/local/intelligence/refresh", asyncRoute(async (_request, response) => {
  response.json({ result: await refreshPartIntelligence() });
}));

app.get("/api/local/intelligence/overview", asyncRoute(async (_request, response) => {
  const overview = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      `SELECT
       (SELECT count(*) FROM partmaster_canonical_parts) AS identities,
       (SELECT count(*) FROM partmaster_part_aliases) AS aliases,
       (SELECT count(*) FROM partmaster_field_evidence) AS evidence_observations,
       (SELECT count(DISTINCT source_url) FROM partmaster_field_evidence) AS evidence_sources,
       (SELECT count(*) FROM partmaster_part_relationships) AS relationships,
       (SELECT count(*) FROM partmaster_part_compatibility) AS verified_fitments,
       (SELECT count(*) FROM partmaster_part_applications WHERE vehicle_mapping_method IS NOT NULL) AS mapped_applications,
       (SELECT count(*) FROM partmaster_data_conflicts WHERE status = 'open') AS open_conflicts,
       (SELECT count(*) FROM partmaster_review_feedback) AS reviewer_decisions,
       (SELECT round(avg(overall_score), 1) FROM partmaster_quality_scores) AS average_quality,
       (SELECT count(*) FROM partmaster_quality_scores WHERE overall_score < 70) AS priority_parts,
       (SELECT max(calculated_at) FROM partmaster_quality_scores) AS calculated_at`,
    );
    const sourceReader = await connection.runAndReadAll(
      `SELECT regexp_extract(source_url, 'https?://([^/]+)', 1) AS source_host,
       count(*) AS observations, round(avg(confidence) * 100, 1) AS average_confidence,
       count(*) FILTER (WHERE accepted) AS accepted
       FROM partmaster_field_evidence GROUP BY 1 ORDER BY observations DESC LIMIT 10`,
    );
    return { ...reader.getRowObjectsJson()[0], sources: sourceReader.getRowObjectsJson() };
  });
  response.json({ overview });
}));

app.get("/api/local/intelligence/priority", asyncRoute(async (_request, response) => {
  const result = await withConnection(async (connection) => {
    const partsReader = await connection.runAndReadAll(
      `SELECT parts.id, parts.manufacturer, parts.part_number, parts.description, families.family_name,
       scores.*, (100 - scores.overall_score) + scores.conflict_risk * .5
        + CASE WHEN scores.missing_fields LIKE '%evidence%' THEN 15 ELSE 0 END AS priority_score,
       (SELECT count(*) FROM partmaster_part_applications applications WHERE applications.part_id = parts.id) AS application_count,
       (SELECT count(*) FROM partmaster_data_conflicts conflicts WHERE conflicts.part_id = parts.id AND conflicts.status = 'open') AS conflict_count
       FROM partmaster_quality_scores scores
       JOIN partmaster_canonical_parts parts ON parts.id = scores.part_id
       LEFT JOIN partmaster_part_families families ON families.id = parts.family_id
       ORDER BY priority_score DESC, application_count DESC, parts.manufacturer, parts.part_number LIMIT 100`,
    );
    const candidatesReader = await connection.runAndReadAll(
      `SELECT id, source_row_id, manufacturer_raw, part_number_raw, description_raw, year, model, assembly,
       status, confidence, source_url,
       CASE status WHEN 'conflict' THEN 100 WHEN 'failed' THEN 90 WHEN 'not_found' THEN 80 ELSE 60 END
        + CASE WHEN description_raw IS NULL OR trim(description_raw) = '' THEN 20 ELSE 0 END
        + CASE WHEN part_number_raw IS NULL OR trim(part_number_raw) = '' THEN 25 ELSE 0 END AS priority_score
       FROM partmaster_enrichment_candidates
       WHERE status IN ('needs_review', 'conflict', 'not_found', 'failed') AND decision IS NULL
       ORDER BY priority_score DESC, source_row_id LIMIT 100`,
    );
    return { parts: partsReader.getRowObjectsJson(), candidates: candidatesReader.getRowObjectsJson() };
  });
  response.json(result);
}));

app.get("/api/local/intelligence/conflicts", asyncRoute(async (_request, response) => {
  const conflicts = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      `SELECT conflicts.*, parts.manufacturer, parts.part_number, parts.description, families.family_name
       FROM partmaster_data_conflicts conflicts
       JOIN partmaster_canonical_parts parts ON parts.id = conflicts.part_id
       LEFT JOIN partmaster_part_families families ON families.id = parts.family_id
       WHERE conflicts.status = 'open'
       ORDER BY CASE conflicts.severity WHEN 'critical' THEN 0 WHEN 'review' THEN 1 ELSE 2 END,
        conflicts.detected_at DESC LIMIT 200`,
    );
    return reader.getRowObjectsJson();
  });
  response.json({ conflicts });
}));

app.get("/api/local/intelligence/search", asyncRoute(async (request, response) => {
  response.json(await intelligentPartSearch(request.query.q));
}));

app.get("/api/local/intelligence/relationships", asyncRoute(async (_request, response) => {
  const result = await withConnection(async (connection) => {
    const relationshipsReader = await connection.runAndReadAll(
      `SELECT relationships.*, source.part_number AS source_number, target.part_number AS target_number,
       source.manufacturer, source.description AS source_description, target.description AS target_description
       FROM partmaster_part_relationships relationships
       JOIN partmaster_canonical_parts source ON source.id = relationships.source_part_id
       JOIN partmaster_canonical_parts target ON target.id = relationships.target_part_id
       ORDER BY relationships.created_at DESC LIMIT 200`,
    );
    const suggestionsReader = await connection.runAndReadAll(
      `WITH sides AS (
        SELECT parts.id, parts.manufacturer, parts.part_number, parts.description, parts.family_id,
         max(CASE WHEN attributes.attribute_name = 'side' THEN lower(attributes.attribute_value) END) AS side
        FROM partmaster_canonical_parts parts
        LEFT JOIN partmaster_variant_attributes attributes ON attributes.part_id = parts.id
        GROUP BY parts.id, parts.manufacturer, parts.part_number, parts.description, parts.family_id
       )
       SELECT left_part.id AS source_part_id, right_part.id AS target_part_id,
        left_part.manufacturer, left_part.part_number AS source_number, right_part.part_number AS target_number,
        'left_right_counterpart' AS suggested_type, .75 AS confidence
       FROM sides left_part JOIN sides right_part
        ON right_part.family_id = left_part.family_id AND right_part.manufacturer = left_part.manufacturer
        AND right_part.side = 'right' AND left_part.side = 'left'
       WHERE left_part.id != right_part.id
        AND NOT EXISTS (SELECT 1 FROM partmaster_part_relationships relationships
         WHERE relationships.source_part_id = left_part.id AND relationships.target_part_id = right_part.id)
       ORDER BY left_part.manufacturer, left_part.part_number LIMIT 50`,
    );
    return { relationships: relationshipsReader.getRowObjectsJson(), suggestions: suggestionsReader.getRowObjectsJson() };
  });
  response.json(result);
}));

app.get("/api/local/intelligence/parts/:id", asyncRoute(async (request, response) => {
  const result = await withConnection(async (connection) => {
    const partReader = await connection.runAndReadAll(
      `SELECT parts.*, families.family_name, scores.* EXCLUDE (part_id)
       FROM partmaster_canonical_parts parts
       LEFT JOIN partmaster_part_families families ON families.id = parts.family_id
       LEFT JOIN partmaster_quality_scores scores ON scores.part_id = parts.id WHERE parts.id = $id`, { id: request.params.id },
    );
    const part = partReader.getRowObjectsJson()[0];
    if (!part) { const error = new Error("Canonical part not found."); error.status = 404; throw error; }
    const schema = categorySchemaFor(part.family_name, part.description);
    const queries = await Promise.all([
      connection.runAndReadAll("SELECT * FROM partmaster_variant_attributes WHERE part_id = $id ORDER BY attribute_name", { id: part.id }),
      connection.runAndReadAll("SELECT * FROM partmaster_field_evidence WHERE part_id = $id ORDER BY field_name, confidence DESC", { id: part.id }),
      connection.runAndReadAll("SELECT * FROM partmaster_part_aliases WHERE part_id = $id ORDER BY alias_type, alias_number", { id: part.id }),
      connection.runAndReadAll("SELECT * FROM partmaster_part_applications WHERE part_id = $id ORDER BY year, model LIMIT 250", { id: part.id }),
      connection.runAndReadAll("SELECT * FROM partmaster_part_compatibility WHERE part_id = $id ORDER BY year, model LIMIT 500", { id: part.id }),
      connection.runAndReadAll("SELECT * FROM partmaster_data_conflicts WHERE part_id = $id AND status = 'open' ORDER BY severity", { id: part.id }),
    ]);
    return { part, schema, attributes: queries[0].getRowObjectsJson(), evidence: queries[1].getRowObjectsJson(), aliases: queries[2].getRowObjectsJson(), applications: queries[3].getRowObjectsJson(), compatibility: queries[4].getRowObjectsJson(), conflicts: queries[5].getRowObjectsJson() };
  });
  response.json(result);
}));

app.post("/api/local/intelligence/parts/:id/aliases", asyncRoute(async (request, response) => {
  const aliasNumber = String(request.body.aliasNumber || "").trim();
  const aliasType = String(request.body.aliasType || "alternate").trim();
  if (!aliasNumber || !["alternate", "superseded", "supersedes", "supplier", "casting"].includes(aliasType)) return response.status(400).json({ error: "Provide an alias number and supported alias type." });
  const alias = await withConnection(async (connection) => {
    const partReader = await connection.runAndReadAll("SELECT id FROM partmaster_canonical_parts WHERE id = $id", { id: request.params.id });
    if (!partReader.getRowObjectsJson().length) throw new Error("Canonical part not found.");
    const id = randomUUID();
    await connection.run(
      `INSERT INTO partmaster_part_aliases
       (id, part_id, alias_number, alias_norm, alias_type, status, confidence, evidence_url)
       VALUES ($id, $partId, $aliasNumber, $aliasNorm, $aliasType, $status, $confidence, $evidenceUrl)
       ON CONFLICT (part_id, alias_norm, alias_type) DO UPDATE SET confidence = excluded.confidence,
        evidence_url = excluded.evidence_url, status = excluded.status`,
      { id, partId: request.params.id, aliasNumber, aliasNorm: normalizePartNumber(aliasNumber), aliasType, status: request.body.status === "suggested" ? "suggested" : "verified", confidence: Math.max(0, Math.min(1, Number(request.body.confidence) || 0.9)), evidenceUrl: String(request.body.evidenceUrl || "").trim() || null },
    );
    return { id, aliasNumber, aliasType };
  });
  response.json({ alias });
}));

app.patch("/api/local/enrichment/candidates/:id", asyncRoute(async (request, response) => {
  const decision = String(request.body.decision || "");
  if (!["approve", "reject"].includes(decision)) {
    return response.status(400).json({ error: "Decision must be approve or reject." });
  }
  const reviewedCandidate = await withConnection(async (connection) => {
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
      family_name: String(request.body.familyName || candidate.family_name || inferFamilyName(candidate.description_raw, candidate.assembly)).trim(),
      component_scope: String(request.body.componentScope || candidate.component_scope || "component").trim(),
      heated_state: safeFeatureState(request.body.heatedState, candidate.heated_state || "unknown"),
      auto_dimming_state: safeFeatureState(request.body.autoDimmingState, candidate.auto_dimming_state || "unknown"),
      power_folding_state: safeFeatureState(request.body.powerFoldingState, candidate.power_folding_state || "unknown"),
      memory_state: safeFeatureState(request.body.memoryState, candidate.memory_state || "unknown"),
      blind_spot_state: safeFeatureState(request.body.blindSpotState, candidate.blind_spot_state || "unknown"),
      camera_state: safeFeatureState(request.body.cameraState, candidate.camera_state || "unknown"),
      turn_signal_state: safeFeatureState(request.body.turnSignalState, candidate.turn_signal_state || "unknown"),
      connector_pins: String(request.body.connectorPins || candidate.connector_pins || "").trim() || null,
      required_options: String(request.body.requiredOptions || candidate.required_options || "").trim() || null,
      excluded_options: String(request.body.excludedOptions || candidate.excluded_options || "").trim() || null,
      variant_summary: String(request.body.variantSummary || candidate.variant_summary || "").trim() || null,
      fitment_explanation: String(request.body.fitmentExplanation || candidate.fitment_explanation || "").trim() || null,
      confidence: decision === "approve" ? Math.max(Number(candidate.confidence) || 0, 0.9) : Number(candidate.confidence) || 0,
      decision,
    };
    let reviewedPartId = null;
    if (decision === "approve") {
      if (!normalizePartNumber(edited.enriched_part_number)) throw new Error("An OEM part number is required before approval.");
      reviewedPartId = await promoteCandidate(connection, edited, "human_verified");
    }
    await connection.run(
      `UPDATE partmaster_enrichment_candidates SET
       enriched_part_number = $partNumber, enriched_description = $description, side = $side,
       position = $position, location_notes = $locationNotes, confidence = $confidence,
       family_name = $familyName, component_scope = $componentScope, heated_state = $heatedState,
       auto_dimming_state = $autoDimmingState, power_folding_state = $powerFoldingState,
       memory_state = $memoryState, blind_spot_state = $blindSpotState, camera_state = $cameraState,
       turn_signal_state = $turnSignalState, connector_pins = $connectorPins,
       required_options = $requiredOptions, excluded_options = $excludedOptions,
       variant_summary = $variantSummary, fitment_explanation = $fitmentExplanation,
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
        familyName: edited.family_name,
        componentScope: edited.component_scope,
        heatedState: edited.heated_state,
        autoDimmingState: edited.auto_dimming_state,
        powerFoldingState: edited.power_folding_state,
        memoryState: edited.memory_state,
        blindSpotState: edited.blind_spot_state,
        cameraState: edited.camera_state,
        turnSignalState: edited.turn_signal_state,
        connectorPins: edited.connector_pins,
        requiredOptions: edited.required_options,
        excludedOptions: edited.excluded_options,
        variantSummary: edited.variant_summary,
        fitmentExplanation: edited.fitment_explanation,
        status: decision === "approve" ? "enriched" : "rejected",
        decision,
        notes: String(request.body.notes || "").trim() || null,
      },
    );
    const feedbackFields = [
      ["part_number", candidate.enriched_part_number || candidate.part_number_raw, edited.enriched_part_number],
      ["description", candidate.enriched_description || candidate.description_raw, edited.enriched_description],
      ["side", candidate.side, edited.side], ["position", candidate.position, edited.position],
      ["family", candidate.family_name, edited.family_name], ["component_scope", candidate.component_scope, edited.component_scope],
      ["required_options", candidate.required_options, edited.required_options], ["excluded_options", candidate.excluded_options, edited.excluded_options],
    ].filter(([, before, after]) => String(before || "").trim() !== String(after || "").trim()).map(([field]) => field);
    await connection.run(
      `INSERT INTO partmaster_review_feedback
       (id, candidate_id, part_id, decision, changed_fields, reason, source_host)
       VALUES ($id, $candidateId, $partId, $decision, $changedFields, $reason, $sourceHost)`,
      { id: randomUUID(), candidateId: candidate.id, partId: reviewedPartId, decision, changedFields: feedbackFields.join(", ") || null, reason: String(request.body.notes || "").trim() || null, sourceHost: safeSourceHost(candidate.evidence_url || candidate.source_url) },
    );
    await refreshEnrichmentJobStats(connection, candidate.job_id);
    return edited;
  });
  response.json({ ok: true });
  if (decision === "approve") {
    scheduleCompatibilityEnrichment(reviewedCandidate);
  }
  setImmediate(() => refreshPartIntelligence().catch(() => {}));
}));

app.get("/api/local/master/stats", asyncRoute(async (_request, response) => {
  const stats = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      `SELECT
       (SELECT count(*) FROM partmaster_canonical_parts) AS parts,
       (SELECT count(*) FROM partmaster_part_applications) AS applications,
       (SELECT count(*) FROM partmaster_part_families) AS families,
       (SELECT count(DISTINCT part_id) FROM partmaster_variant_attributes) AS attributed_variants,
       (SELECT count(*) FROM partmaster_part_compatibility) AS compatibility_fitments,
       (SELECT count(DISTINCT part_id) FROM partmaster_part_compatibility) AS compatibility_parts,
       (SELECT count(*) FROM partmaster_page_cache WHERE success) AS cached_pages,
       (SELECT coalesce(sum(extracted_attribute_count), 0) FROM partmaster_enrichment_candidates) AS candidate_attribute_facts,
       (SELECT count(*) FROM partmaster_enrichment_candidates WHERE status IN ('needs_review', 'conflict')) AS awaiting_review,
       (SELECT count(*) FROM partmaster_enrichment_candidates WHERE status = 'enriched') AS enriched_candidates`,
    );
    return reader.getRowObjectsJson()[0];
  });
  response.json({ stats });
}));

app.get("/api/local/master/quality", asyncRoute(async (_request, response) => {
  const quality = await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      `SELECT
       (SELECT count(*) FROM partmaster_canonical_parts) AS total_parts,
       (SELECT count(*) FROM partmaster_canonical_parts
        WHERE manufacturer IS NULL OR trim(manufacturer) = '' OR part_number IS NULL OR trim(part_number) = ''
         OR description IS NULL OR trim(description) = '' OR family_id IS NULL
         OR evidence_url IS NULL OR trim(evidence_url) = '' OR confidence IS NULL) AS incomplete_parts,
       (SELECT count(*) FROM (
        SELECT manufacturer_norm, part_number_norm FROM partmaster_canonical_parts
        GROUP BY 1, 2 HAVING count(*) > 1) duplicates) AS duplicate_part_keys,
       (SELECT count(*) FROM partmaster_canonical_parts WHERE confidence < .8 OR confidence IS NULL) AS low_confidence_parts,
       (SELECT count(*) FROM partmaster_part_applications) AS total_applications,
       (SELECT count(*) FROM partmaster_part_applications WHERE vehicle_mapping_method IS NOT NULL) AS mapped_applications,
       (SELECT count(*) FROM partmaster_part_applications WHERE side IS NOT NULL AND lower(trim(side)) NOT IN ('', 'unknown')) AS applications_with_side,
       (SELECT count(*) FROM partmaster_part_applications WHERE position IS NOT NULL AND trim(position) != '') AS applications_with_position,
       (SELECT count(*) FROM partmaster_part_compatibility) AS compatibility_fitments,
       (SELECT count(*) FROM partmaster_variant_attributes) AS meaningful_variant_attributes,
       (SELECT count(*) FROM partmaster_enrichment_candidates WHERE status IN ('needs_review', 'conflict')) AS awaiting_review`,
    );
    return reader.getRowObjectsJson()[0];
  });
  response.json({ quality });
}));

app.post("/api/local/master/exports", asyncRoute(async (_request, response) => {
  const exports = await withConnection(async (connection) => {
    const stamp = Date.now();
    const partsFilename = `parts-master-${stamp}.csv`;
    const applicationsFilename = `part-applications-${stamp}.csv`;
    const relationshipsFilename = `part-relationships-${stamp}.csv`;
    const compatibilityFilename = `part-compatibility-${stamp}.csv`;
    const intelligenceFilename = `part-intelligence-${stamp}.csv`;
    const attributesFilename = `part-attributes-${stamp}.csv`;
    const evidenceFilename = `field-evidence-${stamp}.csv`;
    const aliasesFilename = `part-aliases-${stamp}.csv`;
    const conflictsFilename = `data-conflicts-${stamp}.csv`;
    const autopilotJobsFilename = `autopilot-runs-${stamp}.csv`;
    const autopilotItemsFilename = `autopilot-outcomes-${stamp}.csv`;
    const partsPath = join(EXPORT_ROOT, partsFilename);
    const applicationsPath = join(EXPORT_ROOT, applicationsFilename);
    const relationshipsPath = join(EXPORT_ROOT, relationshipsFilename);
    const compatibilityPath = join(EXPORT_ROOT, compatibilityFilename);
    const intelligencePath = join(EXPORT_ROOT, intelligenceFilename);
    const attributesPath = join(EXPORT_ROOT, attributesFilename);
    const evidencePath = join(EXPORT_ROOT, evidenceFilename);
    const aliasesPath = join(EXPORT_ROOT, aliasesFilename);
    const conflictsPath = join(EXPORT_ROOT, conflictsFilename);
    const autopilotJobsPath = join(EXPORT_ROOT, autopilotJobsFilename);
    const autopilotItemsPath = join(EXPORT_ROOT, autopilotItemsFilename);
    await connection.run(
      `COPY (SELECT parts.manufacturer AS "Manufacturer", families.family_name AS "Part Family",
       parts.part_number AS "OEM Part Number", parts.description AS "Description",
       parts.component_scope AS "Component Scope", parts.variant_summary AS "Variant Summary",
       max(CASE WHEN attributes.attribute_name = 'side' THEN attributes.attribute_value END) AS "Side",
       max(CASE WHEN attributes.attribute_name = 'heated' THEN attributes.attribute_value END) AS "Heated",
       max(CASE WHEN attributes.attribute_name = 'auto_dimming' THEN attributes.attribute_value END) AS "Auto Dimming",
       max(CASE WHEN attributes.attribute_name = 'power_folding' THEN attributes.attribute_value END) AS "Power Folding",
       max(CASE WHEN attributes.attribute_name = 'memory' THEN attributes.attribute_value END) AS "Memory",
       max(CASE WHEN attributes.attribute_name = 'blind_spot' THEN attributes.attribute_value END) AS "Blind Spot",
       max(CASE WHEN attributes.attribute_name = 'camera' THEN attributes.attribute_value END) AS "Camera",
       max(CASE WHEN attributes.attribute_name = 'turn_signal' THEN attributes.attribute_value END) AS "Turn Signal",
       max(CASE WHEN attributes.attribute_name = 'connector_pins' THEN attributes.attribute_value END) AS "Connector Pins",
       parts.verification_status AS "Verification Status", parts.confidence AS "Confidence",
       parts.evidence_url AS "Evidence URL", parts.verified_at AS "Verified At"
       FROM partmaster_canonical_parts parts
       LEFT JOIN partmaster_part_families families ON families.id = parts.family_id
       LEFT JOIN partmaster_variant_attributes attributes ON attributes.part_id = parts.id
       GROUP BY parts.id, parts.manufacturer, families.family_name, parts.part_number, parts.description,
        parts.component_scope, parts.variant_summary, parts.verification_status, parts.confidence,
        parts.evidence_url, parts.verified_at, parts.manufacturer_norm, parts.part_number_norm
       ORDER BY parts.manufacturer_norm, parts.part_number_norm)
       TO ${quoteString(partsPath)} (FORMAT CSV, HEADER true)`,
    );
    await connection.run(
      `COPY (SELECT parts.manufacturer AS "Manufacturer", parts.part_number AS "OEM Part Number",
       parts.description AS "Description", applications.item_number AS "Item #",
       applications.side AS "Side", applications.position AS "Position",
       applications.location_notes AS "Location Notes", applications.year AS "Year",
       applications.model AS "Model", applications.epid AS "ePID",
       applications.vehicle_make AS "Canonical Vehicle Make",
       applications.vehicle_model AS "Canonical Vehicle Model",
       applications.vehicle_trim AS "Canonical Vehicle Trim",
       applications.vehicle_type AS "Vehicle Type",
       applications.vehicle_motorcycle_type AS "Motorcycle Type",
       applications.vehicle_mapping_method AS "Vehicle Mapping Method",
       applications.vehicle_mapping_confidence AS "Vehicle Mapping Confidence",
       applications.assembly AS "Assembly",
       applications.quantity AS "Quantity", applications.source_url AS "Source URL",
       applications.required_options AS "Required Options", applications.excluded_options AS "Excluded Options",
       applications.fitment_explanation AS "Why It Fits", applications.evidence_url AS "Evidence URL",
       applications.confidence AS "Confidence"
       FROM partmaster_part_applications applications
       JOIN partmaster_canonical_parts parts ON parts.id = applications.part_id
       ORDER BY parts.manufacturer_norm, parts.part_number_norm, applications.year, applications.model)
       TO ${quoteString(applicationsPath)} (FORMAT CSV, HEADER true)`,
    );
    await connection.run(
      `COPY (SELECT source.manufacturer AS "Manufacturer", source.part_number AS "Source Part Number",
       relationships.relationship_type AS "Relationship", target.part_number AS "Target Part Number",
       relationships.conditions AS "Conditions", relationships.confidence AS "Confidence",
       relationships.evidence_url AS "Evidence URL"
       FROM partmaster_part_relationships relationships
       JOIN partmaster_canonical_parts source ON source.id = relationships.source_part_id
       JOIN partmaster_canonical_parts target ON target.id = relationships.target_part_id
       ORDER BY source.manufacturer_norm, source.part_number_norm)
       TO ${quoteString(relationshipsPath)} (FORMAT CSV, HEADER true)`,
    );
    await connection.run(
      `COPY (SELECT parts.manufacturer AS "Manufacturer", parts.part_number AS "OEM Part Number",
       compatibility.year AS "Year", compatibility.model AS "Model",
       compatibility.model_code AS "Model Code", compatibility.assembly AS "Assembly",
       compatibility.confidence AS "Confidence", compatibility.evidence_url AS "Evidence URL",
       compatibility.source_url AS "Compatibility Source URL", compatibility.verified_at AS "Verified At"
       FROM partmaster_part_compatibility compatibility
       JOIN partmaster_canonical_parts parts ON parts.id = compatibility.part_id
       ORDER BY parts.manufacturer_norm, parts.part_number_norm, compatibility.year,
        compatibility.model, compatibility.model_code, compatibility.assembly)
       TO ${quoteString(compatibilityPath)} (FORMAT CSV, HEADER true)`,
    );
    await connection.run(
      `COPY (SELECT parts.manufacturer AS "Manufacturer", parts.part_number AS "OEM Part Number",
       families.family_name AS "Part Family", scores.identity_score AS "Identity Score",
       scores.description_score AS "Description Score", scores.fitment_score AS "Fitment Score",
       scores.variant_score AS "Variant Score", scores.evidence_score AS "Evidence Score",
       scores.freshness_score AS "Freshness Score", scores.conflict_risk AS "Conflict Risk",
       scores.overall_score AS "Overall Score", scores.missing_fields AS "Next Improvements",
       scores.calculated_at AS "Calculated At"
       FROM partmaster_quality_scores scores JOIN partmaster_canonical_parts parts ON parts.id = scores.part_id
       LEFT JOIN partmaster_part_families families ON families.id = parts.family_id
       ORDER BY scores.overall_score, parts.manufacturer_norm, parts.part_number_norm)
       TO ${quoteString(intelligencePath)} (FORMAT CSV, HEADER true)`,
    );
    await connection.run(
      `COPY (SELECT parts.manufacturer AS "Manufacturer", parts.part_number AS "OEM Part Number",
       families.family_name AS "Part Family", attributes.attribute_name AS "Attribute",
       attributes.attribute_value AS "Value", attributes.confidence AS "Confidence",
       attributes.source_method AS "Method", attributes.evidence_url AS "Evidence URL",
       attributes.updated_at AS "Updated At"
       FROM partmaster_variant_attributes attributes
       JOIN partmaster_canonical_parts parts ON parts.id = attributes.part_id
       LEFT JOIN partmaster_part_families families ON families.id = parts.family_id
       ORDER BY parts.manufacturer_norm, parts.part_number_norm, attributes.attribute_name)
       TO ${quoteString(attributesPath)} (FORMAT CSV, HEADER true)`,
    );
    await connection.run(
      `COPY (SELECT parts.manufacturer AS "Manufacturer", parts.part_number AS "OEM Part Number",
       evidence.field_name AS "Field", evidence.field_value AS "Observed Value",
       evidence.source_url AS "Source URL", evidence.source_title AS "Source Title",
       evidence.source_method AS "Method", evidence.confidence AS "Confidence",
       evidence.accepted AS "Accepted", evidence.observed_at AS "Observed At"
       FROM partmaster_field_evidence evidence JOIN partmaster_canonical_parts parts ON parts.id = evidence.part_id
       ORDER BY parts.manufacturer_norm, parts.part_number_norm, evidence.field_name, evidence.confidence DESC)
       TO ${quoteString(evidencePath)} (FORMAT CSV, HEADER true)`,
    );
    await connection.run(
      `COPY (SELECT parts.manufacturer AS "Manufacturer", parts.part_number AS "Canonical OEM Part Number",
       aliases.alias_number AS "Alias Number", aliases.alias_type AS "Alias Type", aliases.status AS "Status",
       aliases.confidence AS "Confidence", aliases.evidence_url AS "Evidence URL"
       FROM partmaster_part_aliases aliases JOIN partmaster_canonical_parts parts ON parts.id = aliases.part_id
       ORDER BY parts.manufacturer_norm, parts.part_number_norm, aliases.alias_type, aliases.alias_norm)
       TO ${quoteString(aliasesPath)} (FORMAT CSV, HEADER true)`,
    );
    await connection.run(
      `COPY (SELECT parts.manufacturer AS "Manufacturer", parts.part_number AS "OEM Part Number",
       conflicts.field_name AS "Field", conflicts.severity AS "Severity", conflicts.values_seen AS "Values Seen",
       conflicts.explanation AS "Explanation", conflicts.status AS "Status", conflicts.detected_at AS "Detected At"
       FROM partmaster_data_conflicts conflicts JOIN partmaster_canonical_parts parts ON parts.id = conflicts.part_id
       ORDER BY conflicts.status, conflicts.severity, parts.manufacturer_norm, parts.part_number_norm)
       TO ${quoteString(conflictsPath)} (FORMAT CSV, HEADER true)`,
    );
    await connection.run(
      `COPY (SELECT name AS "Run Name", status AS "Status", requested_parts AS "Requested Parts",
       max_online_requests AS "Source Check Budget", min_confidence AS "Minimum Confidence",
       manufacturers AS "Manufacturer Filters", categories AS "Category Filters",
       discover_compatibility AS "Discover Compatibility", recheck_older AS "Force Refresh",
       queued_count AS "Queued", processed_count AS "Processed", verified_count AS "Verified",
       review_count AS "Review", no_source_count AS "No Source", not_found_count AS "Not Found",
       failed_count AS "Failed", online_checks AS "Source Checks", created_at AS "Created At",
       started_at AS "Started At", completed_at AS "Completed At", last_error AS "Last Error"
       FROM partmaster_autopilot_jobs ORDER BY created_at DESC)
       TO ${quoteString(autopilotJobsPath)} (FORMAT CSV, HEADER true)`,
    );
    await connection.run(
      `COPY (SELECT jobs.name AS "Run Name", parts.manufacturer AS "Manufacturer",
       parts.part_number AS "OEM Part Number", parts.description AS "Description",
       items.priority_score AS "Priority Score", items.status AS "Outcome", items.attempt_count AS "Attempts",
       items.confidence AS "Confidence", items.fields_updated AS "Fields Updated",
       items.compatibility_added AS "Compatibility Added", items.message AS "Message",
       items.evidence_url AS "Evidence URL", items.processed_at AS "Processed At"
       FROM partmaster_autopilot_items items JOIN partmaster_autopilot_jobs jobs ON jobs.id = items.job_id
       JOIN partmaster_canonical_parts parts ON parts.id = items.part_id
       ORDER BY jobs.created_at DESC, items.priority_score DESC)
       TO ${quoteString(autopilotItemsPath)} (FORMAT CSV, HEADER true)`,
    );
    return [
      { filename: partsFilename, path: partsPath, bytes: (await stat(partsPath)).size },
      { filename: applicationsFilename, path: applicationsPath, bytes: (await stat(applicationsPath)).size },
      { filename: relationshipsFilename, path: relationshipsPath, bytes: (await stat(relationshipsPath)).size },
      { filename: compatibilityFilename, path: compatibilityPath, bytes: (await stat(compatibilityPath)).size },
      { filename: intelligenceFilename, path: intelligencePath, bytes: (await stat(intelligencePath)).size },
      { filename: attributesFilename, path: attributesPath, bytes: (await stat(attributesPath)).size },
      { filename: evidenceFilename, path: evidencePath, bytes: (await stat(evidencePath)).size },
      { filename: aliasesFilename, path: aliasesPath, bytes: (await stat(aliasesPath)).size },
      { filename: conflictsFilename, path: conflictsPath, bytes: (await stat(conflictsPath)).size },
      { filename: autopilotJobsFilename, path: autopilotJobsPath, bytes: (await stat(autopilotJobsPath)).size },
      { filename: autopilotItemsFilename, path: autopilotItemsPath, bytes: (await stat(autopilotItemsPath)).size },
    ];
  });
  response.json({ exports });
}));

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.status || 500).json({ error: friendlyDataError(error) });
});

const vehicleMappingLoadResult = await loadVehicleMappingReferences().catch((error) => ({ loaded: false, reason: error.message }));
const vehicleMappingBackfillResult = vehicleMappingLoadResult.loaded
  ? await backfillApplicationVehicleMappings().catch((error) => ({ backfilled: 0, reason: error.message }))
  : { backfilled: 0 };
await backfillVariantIntelligence();
const intelligenceBackfillResult = await refreshPartIntelligence().catch((error) => ({ partsScored: 0, reason: error.message }));

const resumableJobIds = await withConnection(async (connection) => {
  await connection.run("UPDATE partmaster_enrichment_candidates SET status = 'pending' WHERE status = 'processing'");
  await connection.run("UPDATE partmaster_enrichment_jobs SET status = 'queued' WHERE status = 'running'");
  const reader = await connection.runAndReadAll("SELECT id FROM partmaster_enrichment_jobs WHERE status = 'queued'");
  return reader.getRowObjectsJson().map((job) => job.id);
});

const resumableRowEnhancementJobIds = await withConnection(async (connection) => {
  await connection.run("UPDATE partmaster_row_enhancement_jobs SET status = 'queued' WHERE status = 'running'");
  const reader = await connection.runAndReadAll("SELECT id FROM partmaster_row_enhancement_jobs WHERE status = 'queued'");
  return reader.getRowObjectsJson().map((job) => job.id);
});

const resumableAutopilotJobIds = await withConnection(async (connection) => {
  await connection.run("UPDATE partmaster_autopilot_items SET status = 'pending' WHERE status = 'processing'");
  await connection.run("UPDATE partmaster_autopilot_jobs SET status = 'queued' WHERE status = 'running'");
  const reader = await connection.runAndReadAll("SELECT id FROM partmaster_autopilot_jobs WHERE status = 'queued'");
  return reader.getRowObjectsJson().map((job) => job.id);
});

const resumablePipelineJobIds = await withConnection(async (connection) => {
  await connection.run("UPDATE partmaster_pipeline_jobs SET status = 'queued', phase = 'queued' WHERE status = 'running'");
  const reader = await connection.runAndReadAll("SELECT id FROM partmaster_pipeline_jobs WHERE status = 'queued'");
  return reader.getRowObjectsJson().map((job) => job.id);
});

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`Partmaster local data service: http://127.0.0.1:${PORT}`);
  console.log(`Local data directory: ${DATA_ROOT}`);
  if (vehicleMappingLoadResult.loaded) {
    console.log(`Vehicle mapping reference: ${Number(vehicleMappingLoadResult.vehicles).toLocaleString()} vehicles, ${Number(vehicleMappingLoadResult.aliases).toLocaleString()} source aliases`);
    if (vehicleMappingLoadResult.mpsov) console.log(`MPSOV.csv: ${Number(vehicleMappingLoadResult.mpsov.rows).toLocaleString()} rows, ${Number(vehicleMappingLoadResult.mpsov.new_epids).toLocaleString()} new ePIDs, ${Number(vehicleMappingLoadResult.mpsov.changed_epids).toLocaleString()} updated mappings`);
    if (vehicleMappingBackfillResult.reason) console.log(`Vehicle mapping backfill skipped: ${vehicleMappingBackfillResult.reason}`);
    else if (vehicleMappingBackfillResult.backfilled) console.log(`Vehicle mapping backfill: ${Number(vehicleMappingBackfillResult.backfilled).toLocaleString()} existing applications updated`);
  } else {
    console.log(`Vehicle mapping reference not loaded: ${vehicleMappingLoadResult.reason}`);
  }
  if (intelligenceBackfillResult.reason) console.log(`Parts intelligence refresh skipped: ${intelligenceBackfillResult.reason}`);
  else console.log(`Parts intelligence: ${Number(intelligenceBackfillResult.partsScored || 0).toLocaleString()} parts scored, ${Number(intelligenceBackfillResult.conflicts || 0).toLocaleString()} conflicts detected`);
  resumableJobIds.forEach(scheduleEnrichmentJob);
  resumableRowEnhancementJobIds.forEach(scheduleRowEnhancementJob);
  resumableAutopilotJobIds.forEach(scheduleAutopilotJob);
  resumablePipelineJobIds.forEach(scheduleFullPipeline);
  setTimeout(() => checkPipelineSchedules(), 1000);
});
const schedulerTimer = setInterval(() => checkPipelineSchedules(), 30_000);

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(schedulerTimer);
  console.log(`Received ${signal}; checkpointing local data before shutdown…`);
  server.close();
  const deadline = Date.now() + 20_000;
  while ((activeEnrichmentJobs.size || activeRowEnhancementJobs.size || activeAutopilotJobs.size || activePipelineJobs.size) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  try {
    await withConnection(async (connection) => {
      await connection.run("UPDATE partmaster_enrichment_candidates SET status = 'pending' WHERE status = 'processing'");
      await connection.run("UPDATE partmaster_enrichment_jobs SET status = 'queued' WHERE status = 'running'");
      await connection.run("UPDATE partmaster_row_enhancement_jobs SET status = 'queued' WHERE status = 'running'");
      await connection.run("UPDATE partmaster_autopilot_items SET status = 'pending' WHERE status = 'processing'");
      await connection.run("UPDATE partmaster_autopilot_jobs SET status = 'queued' WHERE status = 'running'");
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
