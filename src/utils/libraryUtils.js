function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildPartsLibrary({ approved = [], analyses = [] }) {
  const analyzedParts = analyses.flatMap((analysis) =>
    (analysis.parts || []).map((part, index) => ({
      id: `${analysis.id || "analysis"}-${index}`,
      item_number: part.item_number || String(index + 1),
      oem_part_number: part.oem_part_number || "",
      description: part.description || "",
      side_position: part.side_position || "",
      source_type: "Analysis",
      source_name: analysis.source_name || "Imported data",
      scope: analysis.scope || "",
      vin: analysis.vin || "",
      completed_at: analysis.saved_at || "",
    })),
  );

  const approvedParts = approved.map((item, index) => ({
    id: `approved-${item.id || index}`,
    item_number: String(index + 1),
    oem_part_number: item.approved_variant?.oem_part_number || "",
    description: item.base_part || item.part_name || "Approved part",
    side_position: item.approved_variant?.name || "",
    source_type: "Queue approval",
    source_name: item.base_part || "Review queue",
    scope: "",
    vin: item.vin || "",
    completed_at: item.approved_at || "",
  }));

  return [...analyzedParts, ...approvedParts].sort((left, right) =>
    String(right.completed_at).localeCompare(String(left.completed_at)),
  );
}

export function exportLibraryCsv(parts) {
  const headers = [
    "Item #",
    "OEM Part Number",
    "Description",
    "Side / Position",
    "Source",
    "VIN",
    "Application / Scope",
    "Completed At",
  ];
  const rows = parts.map((part) => [
    part.item_number,
    part.oem_part_number,
    part.description,
    part.side_position,
    part.source_name,
    part.vin,
    part.scope,
    part.completed_at,
  ]);

  return `${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
