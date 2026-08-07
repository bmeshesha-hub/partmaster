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
const compatibilityQueue = [];
const queuedCompatibilityKeys = new Set();
let compatibilityWorkerRunning = false;
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

  CREATE INDEX IF NOT EXISTS enrichment_candidates_job_status_idx
    ON partmaster_enrichment_candidates (job_id, status);
  CREATE INDEX IF NOT EXISTS canonical_parts_lookup_idx
    ON partmaster_canonical_parts (manufacturer_norm, part_number_norm);
  CREATE INDEX IF NOT EXISTS part_applications_part_idx
    ON partmaster_part_applications (part_id);
  CREATE INDEX IF NOT EXISTS variant_attributes_part_idx
    ON partmaster_variant_attributes (part_id);
  CREATE INDEX IF NOT EXISTS part_compatibility_part_idx
    ON partmaster_part_compatibility (part_id)
`));

await withConnection((connection) => connection.run(`
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
  ALTER TABLE partmaster_canonical_parts ADD COLUMN IF NOT EXISTS family_id VARCHAR;
  ALTER TABLE partmaster_canonical_parts ADD COLUMN IF NOT EXISTS component_scope VARCHAR;
  ALTER TABLE partmaster_canonical_parts ADD COLUMN IF NOT EXISTS variant_summary VARCHAR;
  ALTER TABLE partmaster_part_applications ADD COLUMN IF NOT EXISTS required_options VARCHAR;
  ALTER TABLE partmaster_part_applications ADD COLUMN IF NOT EXISTS excluded_options VARCHAR;
  ALTER TABLE partmaster_part_applications ADD COLUMN IF NOT EXISTS fitment_explanation VARCHAR;
  CREATE UNIQUE INDEX IF NOT EXISTS part_applications_key_idx
    ON partmaster_part_applications (application_key);
  CREATE INDEX IF NOT EXISTS canonical_parts_family_idx
    ON partmaster_canonical_parts (family_id)
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
  const text = `${description || ""} ${assembly || ""}`.toUpperCase();
  if (/\b(MIRROR|REARVIEW|REAR VIEW)\b/.test(text)) return "Exterior Mirror";
  if (/\b(BRAKE|CALIPER|ROTOR|DISC)\b/.test(text)) return "Brake System";
  if (/\b(HEADLAMP|HEADLIGHT)\b/.test(text)) return "Headlight";
  if (/\b(TAILLAMP|TAIL LIGHT|TAILLIGHT)\b/.test(text)) return "Tail Light";
  if (/\b(BUMPER)\b/.test(text)) return "Bumper";
  if (/\b(DOOR)\b/.test(text)) return "Door";
  if (/\b(WHEEL|RIM)\b/.test(text)) return "Wheel";
  const fallback = String(assembly || description || "Unclassified Part").split(/[|,]/, 1)[0].trim();
  return titleCase(fallback).slice(0, 160) || "Unclassified Part";
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

async function syncVariantAttributes(connection, partId, candidate) {
  const attributes = {
    side: candidate.side || "Unknown",
    component_scope: candidate.component_scope || "component",
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
  };
  for (const [name, value] of Object.entries(attributes)) {
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
  await syncVariantAttributes(connection, partId, candidate);

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
    requiredOptions: candidate.required_options || null,
    excludedOptions: candidate.excluded_options || null,
    fitmentExplanation: candidate.fitment_explanation || null,
    confidence: candidate.confidence || 0,
  };
  if (applicationId) {
    await connection.run(
      `UPDATE partmaster_part_applications SET
       year = $year, model = $model, assembly = $assembly, item_number = $itemNumber,
       side = $side, position = $position, location_notes = $locationNotes, quantity = $quantity,
       source_url = $sourceUrl, evidence_url = $evidenceUrl, required_options = $requiredOptions,
       excluded_options = $excludedOptions, fitment_explanation = $fitmentExplanation, confidence = $confidence,
       updated_at = current_timestamp WHERE id = $id`,
      {
        id: applicationValues.id,
        year: applicationValues.year,
        model: applicationValues.model,
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
       (id, application_key, part_id, dataset_id, source_row_id, year, model, assembly, item_number, side, position,
        location_notes, quantity, source_url, evidence_url, required_options, excluded_options, fitment_explanation, confidence)
       VALUES ($id, $applicationKey, $partId, $datasetId, $sourceRowId, $year, $model, $assembly, $itemNumber, $side,
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
  let update = applyVariantIntelligence({
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
  }, inferVariantIntelligence(candidate), candidate);

  if (!candidate.source_url) {
    if (!candidate.part_number_norm) update.status = "not_found";
    return update;
  }

  const { html, finalUrl } = await getEvidencePage(candidate.source_url);
  const evidence = extractPageEvidence(html, candidate.part_number_raw);
  const evidenceLocation = inferLocation(evidence.description, evidence.title);
  update = applyVariantIntelligence({
    ...update,
    enrichedPartNumber: candidate.part_number_raw || evidence.productNumber || null,
    enrichedDescription: evidence.description || candidate.description_raw || null,
    side: evidenceLocation.side !== "Unknown" ? evidenceLocation.side : localLocation.side,
    position: evidenceLocation.position || localLocation.position || (candidate.item_number ? `Position ${candidate.item_number}` : null),
    evidenceUrl: finalUrl,
    evidenceTitle: evidence.title || null,
  }, inferVariantIntelligence(candidate, evidence.description), candidate);

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
               family_name = $familyName, component_scope = $componentScope,
               heated_state = $heatedState, auto_dimming_state = $autoDimmingState,
               power_folding_state = $powerFoldingState, memory_state = $memoryState,
               blind_spot_state = $blindSpotState, camera_state = $cameraState,
               turn_signal_state = $turnSignalState, connector_pins = $connectorPins,
               required_options = $requiredOptions, excluded_options = $excludedOptions,
               variant_summary = $variantSummary, fitment_explanation = $fitmentExplanation,
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
                familyName: result.familyName,
                componentScope: result.componentScope,
                heatedState: result.heatedState,
                autoDimmingState: result.autoDimmingState,
                powerFoldingState: result.powerFoldingState,
                memoryState: result.memoryState,
                blindSpotState: result.blindSpotState,
                cameraState: result.cameraState,
                turnSignalState: result.turnSignalState,
                connectorPins: result.connectorPins,
                requiredOptions: result.requiredOptions,
                excludedOptions: result.excludedOptions,
                variantSummary: result.variantSummary,
                fitmentExplanation: result.fitmentExplanation,
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
       WHERE family_name IS NULL AND status IN ('needs_review', 'conflict', 'not_found', 'failed') LIMIT 10000`,
    );
    for (const candidate of candidatesReader.getRowObjectsJson()) {
      const intelligence = applyVariantIntelligence({}, inferVariantIntelligence(candidate), candidate);
      await connection.run(
        `UPDATE partmaster_enrichment_candidates SET family_name = $familyName,
         component_scope = $componentScope, heated_state = $heatedState,
         auto_dimming_state = $autoDimmingState, power_folding_state = $powerFoldingState,
         memory_state = $memoryState, blind_spot_state = $blindSpotState, camera_state = $cameraState,
         turn_signal_state = $turnSignalState, connector_pins = $connectorPins,
         required_options = $requiredOptions, excluded_options = $excludedOptions,
         variant_summary = $variantSummary, fitment_explanation = $fitmentExplanation
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
        },
      );
    }
  });
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
       GROUP BY parts.id, parts.part_number, parts.description, parts.component_scope, parts.variant_summary
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
  if (!["same_family", "supersedes", "superseded_by", "interchangeable", "interchangeable_if", "not_interchangeable", "component_of"].includes(relationshipType)) {
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
    if (decision === "approve") {
      if (!normalizePartNumber(edited.enriched_part_number)) throw new Error("An OEM part number is required before approval.");
      await promoteCandidate(connection, edited, "human_verified");
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
    await refreshEnrichmentJobStats(connection, candidate.job_id);
    return edited;
  });
  response.json({ ok: true });
  if (decision === "approve") {
    scheduleCompatibilityEnrichment(reviewedCandidate);
  }
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
    const relationshipsFilename = `part-relationships-${stamp}.csv`;
    const compatibilityFilename = `part-compatibility-${stamp}.csv`;
    const partsPath = join(EXPORT_ROOT, partsFilename);
    const applicationsPath = join(EXPORT_ROOT, applicationsFilename);
    const relationshipsPath = join(EXPORT_ROOT, relationshipsFilename);
    const compatibilityPath = join(EXPORT_ROOT, compatibilityFilename);
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
       applications.model AS "Model", applications.assembly AS "Assembly",
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
    return [
      { filename: partsFilename, path: partsPath, bytes: (await stat(partsPath)).size },
      { filename: applicationsFilename, path: applicationsPath, bytes: (await stat(applicationsPath)).size },
      { filename: relationshipsFilename, path: relationshipsPath, bytes: (await stat(relationshipsPath)).size },
      { filename: compatibilityFilename, path: compatibilityPath, bytes: (await stat(compatibilityPath)).size },
    ];
  });
  response.json({ exports });
}));

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.status || 500).json({ error: error.message || "Local data service error." });
});

await backfillVariantIntelligence();

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
