import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { catalogExportQuery, catalogFilters, catalogPart, catalogQuery } from "./masterCatalog.js";

const database = await DuckDBInstance.create(":memory:");
const connection = await database.connect();
const source = await readFile(new URL("./localDataServer.js", import.meta.url), "utf8");
const tables = ["offline_parts", "canonical_parts", "part_applications", "variant_attributes", "part_aliases", "part_relationships", "part_compatibility", "master_review_flags", "data_conflicts"];
for (const table of tables) {
  const name = `partmaster_${table}`;
  await connection.run(source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n  \\);`))[0]);
  for (const match of source.matchAll(new RegExp(`ALTER TABLE ${name} ADD COLUMN IF NOT EXISTS [^;]+;`, "g"))) await connection.run(match[0]);
}
await connection.run(`
  INSERT INTO partmaster_offline_parts (part_key, manufacturer, manufacturer_norm, part_number, part_number_norm, description, family_name,
    extracted_attributes_json, extracted_attribute_count, occurrence_count, record_type)
  VALUES ('honda:100', 'Honda', 'HONDA', '100', '100', 'Mirror', 'Mirror', '{"heated":false,"connector_pins":0,"finish":"black"}', 3, 19, 'product'),
    ('honda:200', 'Honda', 'HONDA', '200', '200', 'Bracket', 'Bracket', 'invalid json', 0, 2, 'product'),
    ('honda:300', 'Honda', 'HONDA', '300', '300', 'Rejected part', 'Mirror', '{}', 0, 1, 'product'),
    ('honda:400', 'Honda', 'HONDA', '400', '400', 'Catalog heading', NULL, '{}', 0, 1, 'heading');
  INSERT INTO partmaster_canonical_parts (id, manufacturer, manufacturer_norm, part_number, part_number_norm, verification_status)
  VALUES ('c1', 'Honda', 'Honda', '100', '100', 'human_verified'), ('c2', 'Honda', 'Honda', '200', '200', 'human_verified'),
    ('c3', 'Honda', 'Honda', '300', '300', 'rejected');
  INSERT INTO partmaster_part_applications (id, application_key, part_id, dataset_id, source_row_id, year, vehicle_make, model, vehicle_model,
    vehicle_trim, epid, vehicle_mapping_method, required_options, excluded_options, quantity, side, assembly)
  VALUES ('f1', 'f1', 'c1', 'd1', 1, '2020', 'Honda', 'CB500', 'CB500', 'ABS', '123', 'reference', 'ABS', 'Sport', '1', 'Left', 'Handlebar'),
    ('f2', 'f2', 'c1', 'd1', 2, '2022', 'Honda', 'CB650', '', 'Sport', NULL, NULL, 'Sport', 'ABS', '2', 'Right', 'Handlebar');
  INSERT INTO partmaster_variant_attributes (id, part_id, attribute_name, attribute_value)
  VALUES ('v1', 'c1', 'finish', 'silver'), ('v2', 'c2', 'material', 'Aluminum');
  INSERT INTO partmaster_part_aliases (id, part_id, alias_number, alias_norm, alias_type, status)
  VALUES ('a1', 'c1', 'ALT-100', 'ALT100', 'oem', 'verified'), ('a2', 'c1', 'UNVERIFIED-100', 'UNVERIFIED100', 'oem', 'pending');
  INSERT INTO partmaster_part_relationships (id, source_part_id, target_part_id, relationship_type, conditions)
  VALUES ('r1', 'c1', 'c2', 'not_interchangeable', 'Different mount');
  INSERT INTO partmaster_data_conflicts (id, conflict_key, part_id, field_name, severity, values_seen, explanation)
  VALUES ('x1', 'x1', 'c1', 'finish', 'medium', '["black","silver"]', 'Confirm finish before listing');
  INSERT INTO partmaster_part_compatibility (id, compatibility_key, part_id, year, model, model_code, assembly)
  VALUES ('k1', 'k1', 'c2', '2019', 'CB300', 'CB300R', 'Frame');
`);

after(() => { connection.closeSync(); database.closeSync(); });
async function rows(filters = {}) {
  const reader = await connection.runAndReadAll(catalogQuery(filters), catalogFilters(filters).values);
  return reader.getRowObjectsJson();
}

test("catalog preserves complete fitments, attributes, and conditional relationships", async () => {
  const [row] = await rows({ q: "ALT-100" });
  const part = catalogPart(row);
  assert.equal(part.part_number, "100");
  assert.equal(part.audit, undefined);
  assert.equal(part.occurrence_count, undefined);
  assert.deepEqual(part.attributes.find((item) => item.name === "connector_pins").values, ["0"]);
  assert.deepEqual(part.attributes.find((item) => item.name === "heated").values, ["false"]);
  assert.deepEqual(part.attributes.find((item) => item.name === "finish").values, ["black", "silver"]);
  const first = part.fitments.find((item) => item.year === "2020");
  const second = part.fitments.find((item) => item.year === "2022");
  assert.equal(first.model, "CB500");
  assert.equal(first.required_options, "ABS");
  assert.equal(second.model, "CB650");
  assert.equal(second.excluded_options, "ABS");
  assert.equal(second.vehicle_reference, "unmapped");
  assert.equal(part.alternate_numbers.length, 1);
  assert.equal(part.relationships[0].type, "not_interchangeable");
  assert.equal(part.relationships[0].conditions, "Different mount");
  assert.equal(part.unresolved_details[0].field, "finish");
  assert.equal(catalogPart(row, true).audit.occurrence_count, "19");
});

test("browse and export share eligibility and filters including recorded fitment and variant attributes", async () => {
  for (const [filters, expected] of [[{}, ["100", "200"]], [{ q: "CB650" }, ["100"]], [{ q: "CB300R" }, ["200"]],
    [{ q: "Aluminum" }, ["200"]], [{ q: "UNVERIFIED-100" }, []], [{ factStatus: "with_facts" }, ["100", "200"]],
    [{ factStatus: "missing_facts" }, []], [{ fitmentStatus: "present" }, ["100", "200"]], [{ fitmentStatus: "missing" }, []],
    [{ manufacturer: "Honda", minOccurrences: "" }, ["100", "200"]], [{ minOccurrences: 3 }, ["100"]]]) {
    assert.deepEqual((await rows(filters)).map((row) => row.part_number), expected, JSON.stringify(filters));
    const exported = await connection.runAndReadAll(catalogExportQuery(filters), catalogFilters(filters).values);
    assert.deepEqual(exported.getRowObjectsJson().map((row) => row["OEM Part Number"]), expected);
  }
});

test("CSV round trip keeps attribute values and vehicle restrictions without collection metadata", async () => {
  const folder = await mkdtemp(join(tmpdir(), "partmaster-catalog-test-"));
  try {
    const path = join(folder, "catalog.csv").replaceAll("'", "''");
    await connection.run(`COPY (${catalogExportQuery()}) TO '${path}' (FORMAT CSV, HEADER true)`);
    const reader = await connection.runAndReadAll(`SELECT * FROM read_csv('${path}', all_varchar = true)`);
    const [part] = reader.getRowObjectsJson();
    for (const field of ["Occurrences", "Datasets", "Applications", "Source Pages", "Extracted Facts", "Confidence", "Attribute Status", "Raw Price/MSRP"]) assert.equal(field in part, false);
    assert.equal(JSON.parse(part["Vehicle Fitments JSON"]).length, 2);
    assert.equal(JSON.parse(part["Product Attributes JSON"]).find((item) => item.name === "finish").values.length, 2);
    const audit = await connection.runAndReadAll(catalogExportQuery({}, true));
    assert.ok("Occurrences" in audit.getRowObjectsJson()[0]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
