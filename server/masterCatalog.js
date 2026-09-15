// Shared product projection for browsing, application APIs, and CSV exports.
// Keep vehicle fields together: independent year/model lists imply false fitments.
const normalizeSql = (column) => `upper(regexp_replace(coalesce(${column}, ''), '[^A-Za-z0-9]', '', 'g'))`;
const identityMatch = (alias = "canonical") => `${normalizeSql(`${alias}.manufacturer_norm`)} = ${normalizeSql("parts.manufacturer_norm")} AND ${alias}.part_number_norm = parts.part_number_norm`;
const canonicalMatch = `${identityMatch()} AND canonical.verification_status != 'rejected'`;
const numericFilter = (value) => value !== "" && value != null && Number.isFinite(Number(value));

export function catalogFilters(filters = {}) {
  const conditions = ["coalesce(parts.record_type, 'product') = 'product'",
    "length(parts.part_number_norm) BETWEEN 3 AND 50",
    "regexp_matches(parts.part_number_norm, '[0-9]')",
    "NOT regexp_matches(parts.part_number_norm, '^(0+|NA|NONE|NULL|UNKNOWN|UNAVAILABLE|NOTAVAILABLE|TBD|MISSING|X+)$')",
    `NOT EXISTS (SELECT 1 FROM partmaster_canonical_parts rejected WHERE ${identityMatch("rejected")} AND rejected.verification_status = 'rejected')`];
  const values = {};
  const q = String(filters.q || "").trim().toLowerCase();
  if (q) {
    conditions.push(`(lower(concat_ws(' ', parts.manufacturer, parts.part_number, parts.description, parts.family_name,
      parts.side, parts.position, parts.extracted_attributes_json)) LIKE $query
      OR EXISTS (SELECT 1 FROM partmaster_canonical_parts canonical
        JOIN partmaster_part_applications fitment ON fitment.part_id = canonical.id
        WHERE ${canonicalMatch} AND lower(concat_ws(' ', fitment.year, fitment.vehicle_make,
          fitment.vehicle_model, fitment.model, fitment.vehicle_trim, fitment.assembly, fitment.epid,
          fitment.required_options, fitment.excluded_options)) LIKE $query)
      OR EXISTS (SELECT 1 FROM partmaster_canonical_parts canonical
        JOIN partmaster_part_aliases alias ON alias.part_id = canonical.id
        WHERE ${canonicalMatch} AND alias.status = 'verified' AND lower(alias.alias_number) LIKE $query)
      OR EXISTS (SELECT 1 FROM partmaster_canonical_parts canonical
        JOIN partmaster_variant_attributes attribute ON attribute.part_id = canonical.id
        WHERE ${canonicalMatch} AND lower(concat_ws(' ', attribute.attribute_name, attribute.attribute_value)) LIKE $query)
      OR EXISTS (SELECT 1 FROM partmaster_canonical_parts canonical
        JOIN partmaster_part_compatibility fitment ON fitment.part_id = canonical.id
        WHERE ${canonicalMatch} AND lower(concat_ws(' ', fitment.year, fitment.model, fitment.model_code, fitment.assembly)) LIKE $query))`);
    values.query = `%${q}%`;
  }
  if (filters.manufacturer) {
    conditions.push(`${normalizeSql("parts.manufacturer_norm")} = $manufacturer`);
    values.manufacturer = String(filters.manufacturer).toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
  if (filters.family) { conditions.push("coalesce(parts.family_name, 'Unclassified') = $family"); values.family = String(filters.family); }
  if (filters.onlineStatus) { conditions.push("parts.online_status = $onlineStatus"); values.onlineStatus = String(filters.onlineStatus); }
  const hasAttributes = `(coalesce(parts.extracted_attribute_count, 0) > 0 OR EXISTS (
    SELECT 1 FROM partmaster_canonical_parts canonical JOIN partmaster_variant_attributes attribute ON attribute.part_id = canonical.id
    WHERE ${canonicalMatch} AND nullif(trim(attribute.attribute_value), '') IS NOT NULL))`;
  if (filters.factStatus === "with_facts") conditions.push(hasAttributes);
  if (filters.factStatus === "missing_facts") conditions.push(`NOT ${hasAttributes}`);
  if (filters.descriptionStatus === "missing") conditions.push("nullif(trim(parts.description), '') IS NULL");
  if (filters.descriptionStatus === "present") conditions.push("nullif(trim(parts.description), '') IS NOT NULL");
  const hasFitments = `(EXISTS (SELECT 1 FROM partmaster_canonical_parts canonical
    JOIN partmaster_part_applications fitment ON fitment.part_id = canonical.id WHERE ${canonicalMatch})
    OR EXISTS (SELECT 1 FROM partmaster_canonical_parts canonical
    JOIN partmaster_part_compatibility fitment ON fitment.part_id = canonical.id WHERE ${canonicalMatch}))`;
  if (filters.fitmentStatus === "present") conditions.push(hasFitments);
  if (filters.fitmentStatus === "missing") conditions.push(`NOT ${hasFitments}`);
  for (const [key, column, comparison] of [["minConfidence", "confidence", ">="], ["maxConfidence", "confidence", "<="], ["minOccurrences", "occurrence_count", ">="]]) {
    if (numericFilter(filters[key])) { conditions.push(`parts.${column} ${comparison} $${key}`); values[key] = Number(filters[key]); }
  }
  return { where: `WHERE ${conditions.join(" AND ")}`, values };
}

export function catalogOrder(filters = {}) {
  const columns = { part_number: "part_number_norm", manufacturer: "manufacturer_norm", family: "family_name", facts: "extracted_attribute_count", occurrences: "occurrence_count", confidence: "confidence", updated: "updated_at" };
  const column = columns[filters.sort] || "part_number_norm";
  const direction = String(filters.direction).toLowerCase() === "desc" ? "DESC" : "ASC";
  return `parts.${column} ${direction} NULLS LAST, parts.manufacturer_norm, parts.part_number_norm, parts.part_key`;
}

export function catalogQuery(filters = {}, pagination = "") {
  const { where } = catalogFilters(filters);
  return `WITH selected_parts AS (
    SELECT parts.* FROM partmaster_offline_parts parts ${where} ORDER BY ${catalogOrder(filters)} ${pagination}
  ) SELECT parts.*, attributes.attributes_json, fitments.fitments_json, aliases.aliases_json,
    relationships.relationships_json, compatibility.compatibility_json, flags.review_flags,
    conflicts.conflicts_json
  FROM selected_parts parts
  LEFT JOIN LATERAL (
    SELECT to_json(list(struct_pack("name" := name, "values" := attribute_values) ORDER BY name)) AS attributes_json FROM (
      SELECT name, list(DISTINCT value ORDER BY value) AS attribute_values FROM (
        SELECT key AS name, CASE WHEN json_type(value) = 'VARCHAR' THEN json_extract_string(value, '$') ELSE value::VARCHAR END AS value
        FROM json_each(CASE WHEN json_valid(parts.extracted_attributes_json) THEN parts.extracted_attributes_json ELSE '{}' END)
        UNION ALL
        SELECT attribute.attribute_name, attribute.attribute_value FROM partmaster_canonical_parts canonical
        JOIN partmaster_variant_attributes attribute ON attribute.part_id = canonical.id WHERE ${canonicalMatch}
      ) facts WHERE nullif(trim(value), '') IS NOT NULL AND lower(trim(value)) NOT IN ('null', 'unknown', 'n/a') GROUP BY name
    ) grouped
  ) attributes ON true
  LEFT JOIN LATERAL (
    SELECT to_json(list(DISTINCT struct_pack(
      "year" := nullif(trim(fitment.year), ''), "make" := nullif(trim(fitment.vehicle_make), ''),
      "model" := coalesce(nullif(trim(fitment.vehicle_model), ''), nullif(trim(fitment.model), '')),
      "trim" := nullif(trim(fitment.vehicle_trim), ''), "vehicle_type" := fitment.vehicle_type,
      "motorcycle_type" := fitment.vehicle_motorcycle_type, "epid" := fitment.epid,
      "assembly" := fitment.assembly, "item_number" := fitment.item_number, "side" := fitment.side,
      "position" := fitment.position, "quantity" := fitment.quantity, "location_notes" := fitment.location_notes,
      "required_options" := fitment.required_options, "excluded_options" := fitment.excluded_options,
      "notes" := fitment.fitment_explanation,
      "vehicle_reference" := CASE WHEN nullif(trim(fitment.vehicle_mapping_method), '') IS NOT NULL
        AND nullif(trim(fitment.epid), '') IS NOT NULL THEN 'mapped' ELSE 'unmapped' END
    ))) AS fitments_json FROM partmaster_canonical_parts canonical
    JOIN partmaster_part_applications fitment ON fitment.part_id = canonical.id WHERE ${canonicalMatch}
  ) fitments ON true
  LEFT JOIN LATERAL (
    SELECT to_json(list(DISTINCT struct_pack("number" := alias.alias_number, "type" := alias.alias_type))) AS aliases_json
    FROM partmaster_canonical_parts canonical JOIN partmaster_part_aliases alias ON alias.part_id = canonical.id
    WHERE ${canonicalMatch} AND alias.status = 'verified'
  ) aliases ON true
  LEFT JOIN LATERAL (
    SELECT to_json(list(DISTINCT struct_pack("type" := relation.relationship_type,
      "manufacturer" := target.manufacturer, "part_number" := target.part_number, "conditions" := relation.conditions))) AS relationships_json
    FROM partmaster_canonical_parts canonical
    JOIN partmaster_part_relationships relation ON relation.source_part_id = canonical.id
    JOIN partmaster_canonical_parts target ON target.id = relation.target_part_id
    WHERE ${canonicalMatch} AND target.verification_status != 'rejected'
  ) relationships ON true
  LEFT JOIN LATERAL (
    SELECT to_json(list(DISTINCT struct_pack("year" := fitment.year, "model" := fitment.model,
      "model_code" := fitment.model_code, "assembly" := fitment.assembly))) AS compatibility_json
    FROM partmaster_canonical_parts canonical JOIN partmaster_part_compatibility fitment ON fitment.part_id = canonical.id
    WHERE ${canonicalMatch}
  ) compatibility ON true
  LEFT JOIN LATERAL (
    SELECT string_agg(flag_code, ', ' ORDER BY flag_code) AS review_flags
    FROM partmaster_master_review_flags WHERE part_key = parts.part_key AND status = 'open'
  ) flags ON true
  LEFT JOIN LATERAL (
    SELECT to_json(list(struct_pack("field" := conflict.field_name, "values" := conflict.values_seen,
      "explanation" := conflict.explanation))) AS conflicts_json
    FROM partmaster_canonical_parts canonical JOIN partmaster_data_conflicts conflict ON conflict.part_id = canonical.id
    WHERE ${canonicalMatch} AND conflict.status = 'open'
  ) conflicts ON true
  ORDER BY ${catalogOrder(filters)}`;
}

function array(value) {
  try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

export function catalogPart(row, includeAudit = false) {
  const part = Object.fromEntries(["part_key", "manufacturer", "part_number", "description", "family_name", "component_scope", "side", "position", "updated_at"].map((key) => [key, row[key] ?? null]));
  part.attributes = array(row.attributes_json);
  part.fitments = array(row.fitments_json);
  part.alternate_numbers = array(row.aliases_json);
  part.relationships = array(row.relationships_json);
  part.additional_fitments = array(row.compatibility_json);
  part.unresolved_details = array(row.conflicts_json);
  if (includeAudit) part.audit = Object.fromEntries(["occurrence_count", "dataset_count", "application_count", "source_page_count", "extracted_attribute_count", "confidence", "attribute_status", "online_status", "best_source_url", "review_flags"].map((key) => [key, row[key] ?? null]));
  return part;
}

export function catalogExportQuery(filters = {}, includeAudit = false) {
  return `SELECT part_key AS "Part Key", manufacturer AS "Manufacturer", part_number AS "OEM Part Number",
    description AS "Description", family_name AS "Part Family", component_scope AS "Component Scope",
    side AS "Side", position AS "Position", coalesce(attributes_json, '[]') AS "Product Attributes JSON",
    coalesce(fitments_json, '[]') AS "Vehicle Fitments JSON", coalesce(compatibility_json, '[]') AS "Additional Fitments JSON",
    coalesce(aliases_json, '[]') AS "Alternate Part Numbers JSON", coalesce(relationships_json, '[]') AS "Part Relationships JSON",
    coalesce(conflicts_json, '[]') AS "Unresolved Details JSON", updated_at AS "Updated At"
    ${includeAudit ? `, occurrence_count AS "Occurrences", dataset_count AS "Datasets", application_count AS "Applications",
      source_page_count AS "Source Pages", extracted_attribute_count AS "Extracted Facts", confidence AS "Confidence",
      attribute_status AS "Attribute Status", online_status AS "Online Evidence Status", best_source_url AS "Best Source URL", review_flags AS "Review Flags"` : ""}
    FROM (${catalogQuery(filters)}) catalog`;
}
