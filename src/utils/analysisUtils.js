const FINAL_HEADERS = ["Item #", "OEM Part Number", "Description", "Side / Position"];

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  if (value || row.length) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }

  return rows.filter((candidate) => candidate.some((cell) => cell.trim()));
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows) {
  return rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
}

export function inspectSource(text) {
  const rows = parseCsv(text);
  const headers = rows[0] || [];
  const normalized = headers.map((header) => header.trim().toLowerCase());
  const requiredHeaders = ["system", "group", "application", "parttype"];
  const structured = requiredHeaders.every((header) => normalized.includes(header));

  if (!structured) {
    return { structured: false, headers: [], records: [], scopes: [], rowCount: rows.length };
  }

  const records = rows.slice(1).map((cells) =>
    Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""])),
  );
  const scopeMap = new Map();

  for (const record of records) {
    if (!record.PartType?.trim()) continue;
    const values = [record.System, record.Group, record.Application].map((value) => value?.trim() || "");
    const key = values.join("||| ");
    if (!scopeMap.has(key)) {
      scopeMap.set(key, {
        key,
        label: values.filter(Boolean).join(" › "),
        system: values[0],
        group: values[1],
        application: values[2],
        count: 0,
      });
    }
    scopeMap.get(key).count += 1;
  }

  return {
    structured: true,
    headers,
    records,
    scopes: [...scopeMap.values()],
    rowCount: records.length,
  };
}

export function extractVin(sourceName) {
  return sourceName.toUpperCase().match(/\b[A-HJ-NPR-Z0-9]{17}\b/)?.[0] || "";
}

export function selectScopeRecords(source, scopeKey) {
  if (!source.structured) return [];
  if (!scopeKey) return source.records.filter((record) => record.PartType?.trim());

  return source.records.filter((record) => {
    const key = [record.System, record.Group, record.Application]
      .map((value) => value?.trim() || "")
      .join("||| ");
    return key === scopeKey && record.PartType?.trim();
  });
}

export function buildAnalysisPrompt({ rawText, sourceName, source, scopeKey, itemHeaders = "", approvedSources = {} }) {
  const vin = extractVin(sourceName);
  const selectedRecords = selectScopeRecords(source, scopeKey);
  const selectedScope = source.scopes.find((scope) => scope.key === scopeKey);
  const sourceData = source.structured
    ? toCsv([
        ["System", "Group", "Application", "Part Type"],
        ...selectedRecords.map((record) => [
          record.System,
          record.Group,
          record.Application,
          record.PartType,
        ]),
      ])
    : rawText.trim();

  const requestedHeaders = itemHeaders.split(",").map((header) => header.trim()).filter(Boolean);
  const sources = Object.values(approvedSources).flat();
  const approvedSourceText = sources.length ? sources.map((item) => `- ${item.name} (${item.priority}): ${item.url}`).join("\\n") : "No approved sources configured; use only supplied source URLs.";
  return `Act as an automotive OEM parts research specialist. Analyze the supplied catalog data and produce a clean, auditable parts list.

Source file: ${sourceName || "Pasted raw text"}
${vin ? `Vehicle VIN from the source filename: ${vin}` : "Vehicle VIN: not supplied"}
${selectedScope ? `Selected catalog scope: ${selectedScope.label}` : "Selected catalog scope: pasted raw data"}

Approved research sources (use only these for online research):
${approvedSourceText}

Required item-specific headers (preserve these exact names):
${requestedHeaders.length ? requestedHeaders.join(" | ") : "No additional headers supplied"}

Requirements:
1. Identify the most likely vehicle make, model, model year, generation, and relevant catalog section. Use the VIN when supplied. Clearly label anything uncertain.
2. Research and match the OEM part number for every distinct part/position in the selected data. Do not invent a number: write NEEDS VERIFICATION when reliable support is unavailable.
3. Explain duplicates, left/right distinctions, numbered diagram positions, supersessions, and specialty clips when relevant.
4. Normalize Honda-style OEM numbers as XXXXX-XXX-XXX. Preserve suffixes and other manufacturers' established formatting.
5. Call out suspicious results, especially when left and right parts share one number.
6. For every requested item-specific header, return a source-supported value or Unknown. Never convert missing evidence into No.
7. Use the approved source list above and include direct source URLs and concise evidence in the research notes.
6. End with exactly one fenced CSV block. The first row must be:
${FINAL_HEADERS.join(",")}
Use one physical part/position per row. Quote CSV values containing commas. Do not put commentary inside the CSV block.

Source data:
---
${sourceData}
---`;
}

function normalizeHeader(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function normalizeOemPartNumber(value) {
  const cleaned = String(value || "").trim();
  const compact = cleaned.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return compact.length === 11 && /^[A-Z0-9]+$/.test(compact)
    ? `${compact.slice(0, 5)}-${compact.slice(5, 8)}-${compact.slice(8)}`
    : cleaned;
}

function extractTableText(response) {
  const fencedBlocks = [...response.matchAll(/```(?:csv)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim());
  const csvBlock = fencedBlocks.find((block) => /item\s*#.*oem\s*part\s*number/i.test(block));
  if (csvBlock) return { kind: "csv", text: csvBlock };

  const lines = response.split(/\r?\n/);
  const markdownStart = lines.findIndex(
    (line) => line.includes("|") && /item\s*#.*oem\s*part\s*number/i.test(line),
  );
  if (markdownStart >= 0) {
    const tableLines = [];
    for (const line of lines.slice(markdownStart)) {
      if (!line.includes("|") || !line.trim()) break;
      tableLines.push(line);
    }
    return { kind: "markdown", text: tableLines.join("\n") };
  }

  const csvStart = lines.findIndex((line) => /item\s*#\s*,\s*oem\s*part\s*number/i.test(line));
  if (csvStart >= 0) return { kind: "csv", text: lines.slice(csvStart).join("\n") };

  throw new Error("No results table found. Ask the AI to include the required fenced CSV block.");
}

export function parseAnalysisResponse(response) {
  const table = extractTableText(response);
  const matrix = table.kind === "markdown"
    ? table.text
        .split(/\r?\n/)
        .filter((line) => !/^\s*\|?\s*:?-+/.test(line))
        .map((line) => line.replace(/^\s*\||\|\s*$/g, "").split("|").map((cell) => cell.trim()))
    : parseCsv(table.text);

  const headers = matrix[0]?.map(normalizeHeader) || [];
  const indexes = {
    item: headers.findIndex((header) => ["item", "itemnumber", "itemno"].includes(header)),
    oem: headers.findIndex((header) => ["oempartnumber", "oemnumber", "partnumber"].includes(header)),
    description: headers.findIndex((header) => ["description", "partdescription", "parttype"].includes(header)),
    position: headers.findIndex((header) => ["sideposition", "position", "side"].includes(header)),
  };

  if (Object.values(indexes).some((index) => index < 0)) {
    throw new Error(`The results table must contain: ${FINAL_HEADERS.join(", ")}.`);
  }

  const results = matrix
    .slice(1)
    .filter((row) => row.some((cell) => cell?.trim()))
    .map((row, index) => ({
      id: crypto.randomUUID(),
      item_number: row[indexes.item]?.trim() || String(index + 1),
      oem_part_number: normalizeOemPartNumber(row[indexes.oem]),
      description: row[indexes.description]?.trim() || "",
      side_position: row[indexes.position]?.trim() || "",
    }));

  if (!results.length) throw new Error("The AI results table did not contain any part rows.");
  return results;
}

export function resultsToCsv(results) {
  return `${toCsv([
    FINAL_HEADERS,
    ...results.map((row) => [
      row.item_number,
      row.oem_part_number,
      row.description,
      row.side_position,
    ]),
  ])}\n`;
}
