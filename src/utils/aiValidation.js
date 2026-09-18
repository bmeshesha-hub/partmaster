const CHANGE_KEYS = [
  "partNumber", "description", "familyName", "componentScope", "side", "position", "locationNotes",
  "heatedState", "autoDimmingState", "powerFoldingState", "memoryState", "blindSpotState", "cameraState",
  "turnSignalState", "connectorPins", "requiredOptions", "excludedOptions", "variantSummary",
  "fitmentExplanation", "evidenceUrl", "attributes",
];

const SNAKE_CASE_KEYS = {
  part_number: "partNumber", enriched_part_number: "partNumber", enriched_description: "description",
  family_name: "familyName", component_scope: "componentScope", location_notes: "locationNotes",
  heated_state: "heatedState", auto_dimming_state: "autoDimmingState", power_folding_state: "powerFoldingState",
  blind_spot_state: "blindSpotState", turn_signal_state: "turnSignalState", connector_pins: "connectorPins",
  required_options: "requiredOptions", excluded_options: "excludedOptions", variant_summary: "variantSummary",
  fitment_explanation: "fitmentExplanation", evidence_url: "evidenceUrl",
};

const value = (input) => input == null ? "" : String(input);

function rawRecord(candidate) {
  try {
    const parsed = JSON.parse(candidate?.raw_record_json || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function currentValues(candidate) {
  return {
    partNumber: candidate.enriched_part_number || candidate.part_number_raw || "",
    description: candidate.enriched_description || candidate.description_raw || "",
    familyName: candidate.family_name || "",
    componentScope: candidate.component_scope || "",
    side: candidate.side || "",
    position: candidate.position || "",
    locationNotes: candidate.location_notes || "",
    attributes: parseAttributes(candidate.extracted_attributes_json),
  };
}

function parseAttributes(input) {
  if (!input) return {};
  if (typeof input === "object" && !Array.isArray(input)) return input;
  try {
    const parsed = JSON.parse(String(input));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function missingFields(candidate) {
  return [
    ["partNumber", candidate.enriched_part_number || candidate.part_number_raw],
    ["description", candidate.enriched_description || candidate.description_raw],
    ["familyName", candidate.family_name],
    ["side", candidate.side && !["unknown", "Unknown"].includes(candidate.side) ? candidate.side : ""],
    ["position", candidate.position],
  ].filter(([, fieldValue]) => !value(fieldValue).trim()).map(([field]) => field);
}

export function buildAiValidationPrompt(candidates) {
  const records = candidates.map((candidate) => ({
    candidate_id: candidate.id,
    source_row_id: candidate.source_row_id,
    source: {
      year: candidate.year || "",
      make: candidate.manufacturer_raw || "",
      model: candidate.model || "",
      assembly: candidate.assembly || "",
      item_number: candidate.item_number || "",
      source_url: candidate.source_url || "",
      raw_record: rawRecord(candidate),
    },
    current_master_values: currentValues(candidate),
    missing_fields: missingFields(candidate),
  }));
  return `You are validating automotive and powersports parts data for a human review queue.

Rules:
1. Use only the supplied source row, current values, and source URL context. Do not invent values.
2. Clean obvious casing, whitespace, duplicated text, and source formatting errors only when the correction is unambiguous.
3. Populate missing attributes only when the evidence supports them. Use an empty changes object when no safe change is available.
4. Preserve the OEM part number exactly unless the source clearly proves a correction.
5. Do not make broad fitment claims from a part description alone.
6. Every input candidate_id must appear exactly once in the response.
7. Return JSON only. No Markdown, no code fences, and no commentary outside the JSON.

Return this exact shape:
{
  "reviews": [
    {
      "candidate_id": "the supplied candidate_id",
      "decision": "recommend" | "no_change" | "needs_human",
      "confidence": 0.0,
      "changes": {
        "partNumber": "only if safe",
        "description": "cleaned description only if safe",
        "familyName": "standardized part family only if supported",
        "componentScope": "component or complete_assembly",
        "side": "left, right, front, rear, or Unknown",
        "position": "position if supported",
        "locationNotes": "fitment or installation note if supported",
        "attributes": { "attribute_name": "value" }
      },
      "evidence": ["short source-grounded reasons"],
      "notes": "uncertainties or human checks required"
    }
  ]
}

Candidates to review:
${JSON.stringify(records, null, 2)}`;
}

function parseJsonText(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const parsed = JSON.parse(cleaned);
  return Array.isArray(parsed) ? { reviews: parsed } : parsed;
}

function normalizeChanges(changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return {};
  const normalized = {};
  for (const [key, raw] of Object.entries(changes)) {
    const normalizedKey = SNAKE_CASE_KEYS[key] || key;
    if (!CHANGE_KEYS.includes(normalizedKey) || raw == null || raw === "") continue;
    if (normalizedKey === "attributes") {
      if (typeof raw !== "object" || Array.isArray(raw)) continue;
      const attributes = Object.fromEntries(Object.entries(raw).filter(([name, attributeValue]) => name.trim() && attributeValue != null && String(attributeValue).trim()));
      if (Object.keys(attributes).length) normalized.attributes = attributes;
    } else if (["partNumber", "description", "familyName", "componentScope", "side", "position", "locationNotes", "heatedState", "autoDimmingState", "powerFoldingState", "memoryState", "blindSpotState", "cameraState", "turnSignalState", "connectorPins", "requiredOptions", "excludedOptions", "variantSummary", "fitmentExplanation", "evidenceUrl"].includes(normalizedKey)) {
      normalized[normalizedKey] = String(raw).trim();
    }
  }
  return normalized;
}

export function validateAiValidationResponse(text, candidates) {
  const parsed = parseJsonText(text);
  if (!parsed || !Array.isArray(parsed.reviews)) throw new Error("Expected a JSON object with a reviews array.");
  const selectedIds = new Set(candidates.map((candidate) => candidate.id));
  const seen = new Set();
  const reviews = parsed.reviews.map((review, index) => {
    const candidateId = String(review?.candidate_id || review?.candidateId || review?.id || "").trim();
    if (!candidateId || !selectedIds.has(candidateId)) throw new Error(`Review ${index + 1} has an unknown candidate_id.`);
    if (seen.has(candidateId)) throw new Error(`Candidate ${candidateId} appears more than once.`);
    seen.add(candidateId);
    const decision = String(review?.decision || "").trim().toLowerCase();
    if (!["recommend", "no_change", "needs_human"].includes(decision)) throw new Error(`Candidate ${candidateId} has an invalid decision.`);
    const confidence = Number(review?.confidence);
    return {
      candidateId,
      decision,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      changes: normalizeChanges(review?.changes),
      evidence: Array.isArray(review?.evidence) ? review.evidence.map(value).filter((item) => item.trim()) : [],
      notes: value(review?.notes).trim(),
    };
  });
  const missingIds = candidates.map((candidate) => candidate.id).filter((id) => !seen.has(id));
  return { reviews, missingIds, complete: missingIds.length === 0 };
}
