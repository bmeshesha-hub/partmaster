import { MASTER_EXPORT_TEMPLATE_VERSION, masterExportTemplate } from "../../shared/masterExportTemplates.js";

const value = (input) => input == null ? "" : String(input);
const first = (...inputs) => inputs.find((input) => input !== false && input != null && value(input).trim() !== "") ?? "";
const json = (input) => JSON.stringify(input ?? [], null, 0);

function fitmentsFor(part) {
  const fitments = [...(Array.isArray(part?.fitments) ? part.fitments : []), ...(Array.isArray(part?.additional_fitments) ? part.additional_fitments : [])];
  return fitments.length ? fitments : [null];
}

function attributesFor(part) {
  return (Array.isArray(part?.attributes) ? part.attributes : []).flatMap((attribute) => {
    const values = Array.isArray(attribute?.values) ? attribute.values : [attribute?.value];
    return values.filter((item) => value(item).trim() !== "").map((item) => ({ name: attribute.name, value: item }));
  });
}

function vehicleMake(part, fitment) {
  return first(fitment?.make, fitment?.vehicle_make, part?.manufacturer);
}

function vehicleModel(fitment) {
  return first(fitment?.model, fitment?.vehicle_model);
}

function fitmentSummary(part) {
  return fitmentsFor(part).filter(Boolean).map((fitment) => [fitment.year, vehicleMake(part, fitment), vehicleModel(fitment), fitment.trim].filter((item) => value(item).trim() !== "").join(" ")).filter(Boolean).join("; ");
}

function sourceUrl(part) {
  return first(part?.audit?.best_source_url, part?.source_url);
}

function listingTitle(part) {
  return [part?.manufacturer, part?.part_number, part?.description].filter((item) => value(item).trim() !== "").join(" - ");
}

function reviewReasons(part) {
  const reasons = [];
  if (!value(part?.description).trim()) reasons.push("Missing description");
  if (!value(part?.family_name).trim() || part.family_name === "General Part") reasons.push("Needs family classification");
  if (!part?.attributes?.length) reasons.push("Missing attributes");
  if (part?.audit && (part.audit.confidence == null || Number(part.audit.confidence) < 0.8)) reasons.push("Low confidence");
  if (part?.audit?.review_flags) reasons.push(value(part.audit.review_flags));
  return reasons.join("; ");
}

function rowsForPart(part, templateId) {
  const attributes = attributesFor(part);
  const specifications = json(part?.attributes || []);
  const base = {
    Make: part?.manufacturer,
    "Part Number": part?.part_number,
    Description: part?.description,
    "Part Type": first(part?.part_type, part?.family_name),
    "Part Family": part?.family_name,
    "Component Scope": part?.component_scope,
    Side: part?.side,
    Position: part?.position,
  };

  if (templateId === "part_number" || templateId === "manufacturer_specific") {
    return [{ ...base, "Specifications JSON": specifications }];
  }
  if (templateId === "listing_ready") {
    return [{ ...base, "Listing Title": listingTitle(part), "Cleaned Description": part?.description, "Specifications JSON": specifications, "Fitment Summary": fitmentSummary(part) }];
  }
  if (templateId === "quality_review") {
    const reasons = reviewReasons(part);
    return reasons ? [{ ...base, "Attribute Status": part?.attributes?.length ? "with_facts" : "missing_facts", "Online Status": part?.audit?.online_status || "snapshot", "Review Reasons": reasons }] : [];
  }
  if (templateId === "attribute" || templateId === "category_attribute") {
    return attributes.map((attribute) => ({ ...base, Category: part?.family_name, Attribute: attribute.name, Value: attribute.value, "Value Type": typeof attribute.value, Method: "published_snapshot", Confidence: part?.audit?.confidence ?? "" }));
  }
  if (templateId === "supersession") {
    const relationships = (Array.isArray(part?.relationships) ? part.relationships : []).map((relationship) => ({ ...base, "Relationship Type": relationship.type, "Related Part Number": relationship.part_number, Conditions: relationship.conditions, Confidence: relationship.confidence, "Evidence URL": relationship.evidence_url || sourceUrl(part) }));
    const aliases = (Array.isArray(part?.alternate_numbers) ? part.alternate_numbers : []).map((alias) => ({ ...base, "Relationship Type": alias.type || "alternate", "Related Part Number": alias.number, Conditions: "Verified alternate number", Confidence: part?.audit?.confidence ?? "", "Evidence URL": sourceUrl(part) }));
    return [...relationships, ...aliases];
  }
  if (templateId === "raw") {
    return [{ "Dataset ID": "published-master-snapshot", "Source File": "master-catalog snapshot", "Source Row ID": part?.part_key, "Source URL": sourceUrl(part), "Raw Record JSON": json(part) }];
  }
  return fitmentsFor(part).map((fitment) => {
    const make = vehicleMake(part, fitment);
    const model = vehicleModel(fitment);
    const common = {
      Make: part?.manufacturer,
      "Part Number": part?.part_number,
      Description: part?.description,
      "Part Type": first(part?.part_type, part?.family_name),
      "Part Family": part?.family_name,
      Year: fitment?.year,
      "Vehicle Make": make,
      "Vehicle Model": model,
      "Vehicle Trim": fitment?.trim,
      ePID: fitment?.epid,
      "Assembly Category": fitment?.assembly,
      "Mapping Confidence": fitment?.vehicle_reference === "mapped" ? 1 : "",
      "Mapping Method": fitment?.vehicle_reference || "published_snapshot",
      "Fitment Notes": fitment?.notes || fitment?.location_notes,
      "Source URL": sourceUrl(part),
      "Cleaned Description": part?.description,
      Specs: specifications,
      Availability: part?.audit?.online_status || "Published",
      "Assembly GUID": fitment?.assembly_guid,
      "Diagram GUID": fitment?.diagram_guid,
      Pos: fitment?.item_number || fitment?.position,
      Ref: fitment?.item_number,
    };
    if (templateId === "original") return {
      Year: fitment?.year,
      Make: part?.manufacturer,
      Model: model,
      "Part category": fitment?.assembly,
      "Source URL": sourceUrl(part),
      "POS.": fitment?.item_number || fitment?.position,
      CODE: part?.part_number,
      DESCRIPTION: part?.description,
      QTY: fitment?.quantity,
      VALIDITY: "",
      NOTES: "",
      dt: "",
      jobId: "",
      "Raw Record JSON": json(part),
    };
    if (templateId === "category") return { ...common, Model: model, Ref: fitment?.item_number, Quantity: fitment?.quantity };
    if (templateId === "fitment") return common;
    if (templateId === "vehicle_fitment") return common;
    if (templateId === "assembly_diagram") return common;
    return {
      Year: fitment?.year,
      Make: part?.manufacturer,
      Model: model,
      "Fitment Notes": fitment?.notes || fitment?.location_notes,
      "Est. Year Fitment": fitment?.estimated_year_fitment,
      "Part Number": part?.part_number,
      "Supersedes Part": "",
      "Cleaned Description": part?.description,
      "Industry Taxonomy (ACES/PIES)": part?.family_name,
      Specs: specifications,
      Availability: part?.audit?.online_status || "Published",
      "Price (Float)": "",
      Currency: "",
      Pos: fitment?.item_number || fitment?.position,
      Ref: fitment?.item_number,
      "Assembly GUID": fitment?.assembly_guid,
      "Diagram GUID": fitment?.diagram_guid,
      "Brand Code": "",
      "Assembly Category": fitment?.assembly,
      "Source URL": sourceUrl(part),
      "Raw Description": part?.description,
      "Raw Part Type": first(part?.part_type, part?.family_name),
      "Raw Price": "",
      "Raw Quantity": fitment?.quantity,
      "Raw ePID": fitment?.epid,
      "Source Date": "",
      "Source Job ID": "",
      "Dataset ID": "published-master-snapshot",
      "Source File": "master-catalog snapshot",
      "Source Row ID": part?.part_key,
      "Raw Record JSON": json(part),
    };
  });
}

function vehicleSummaryRows(parts) {
  const groups = new Map();
  parts.forEach((part) => {
    (Array.isArray(part?.fitments) ? part.fitments : []).forEach((fitment) => {
      const row = {
        Year: fitment?.year,
        "Vehicle Make": vehicleMake(part, fitment),
        "Vehicle Model": vehicleModel(fitment),
        "Vehicle Trim": fitment?.trim,
        "Vehicle Type": fitment?.vehicle_type,
      };
      const key = [row.Year, row["Vehicle Make"], row["Vehicle Model"], row["Vehicle Trim"], row["Vehicle Type"]].map(value).join("\u001f");
      const current = groups.get(key) || { ...row, partNumbers: new Set(), assemblies: new Set(), fitmentCount: 0, mappedCount: 0 };
      current.partNumbers.add(part?.part_number);
      if (value(fitment?.assembly).trim()) current.assemblies.add(fitment.assembly);
      current.fitmentCount += 1;
      if (fitment?.vehicle_reference === "mapped") current.mappedCount += 1;
      groups.set(key, current);
    });
  });
  return [...groups.values()].map((row) => ({
    Year: row.Year,
    "Vehicle Make": row["Vehicle Make"],
    "Vehicle Model": row["Vehicle Model"],
    "Vehicle Trim": row["Vehicle Trim"],
    "Vehicle Type": row["Vehicle Type"],
    "Part Count": row.partNumbers.size,
    "Fitment Row Count": row.fitmentCount,
    "Assembly Count": row.assemblies.size,
  }));
}

function orderedRow(row, columns) {
  return Object.fromEntries(columns.map((column) => [column, row?.[column] ?? ""]));
}

export function staticMasterTemplatePreview(parts, templateId, limit = 10) {
  const definition = masterExportTemplate(templateId);
  if (!definition) throw new Error(`Unknown export template: ${templateId}`);
  const rows = templateId === "vehicle_summary" ? vehicleSummaryRows(parts).slice(0, limit) : [];
  if (templateId !== "vehicle_summary") {
    for (const part of parts || []) {
      for (const row of rowsForPart(part, templateId)) {
        rows.push(orderedRow(row, definition.columns));
        if (rows.length >= limit) break;
      }
      if (rows.length >= limit) break;
    }
  }
  return { version: MASTER_EXPORT_TEMPLATE_VERSION, columns: definition.columns, rows, total: rows.length };
}

export function staticMasterTemplateCsv(parts, templateId) {
  const definition = masterExportTemplate(templateId);
  if (!definition) throw new Error(`Unknown export template: ${templateId}`);
  const lines = [definition.columns.map(csvCell).join(",")];
  const append = (row) => lines.push(definition.columns.map((column) => csvCell(row?.[column])).join(","));
  if (templateId === "vehicle_summary") vehicleSummaryRows(parts).forEach(append);
  else (parts || []).forEach((part) => rowsForPart(part, templateId).forEach(append));
  return `\ufeff${lines.join("\r\n")}\r\n`;
}

function csvCell(input) {
  const text = input == null ? "" : typeof input === "object" ? JSON.stringify(input) : String(input);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
