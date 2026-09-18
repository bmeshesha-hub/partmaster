export const MASTER_EXPORT_TEMPLATE_VERSION = 2;

export const MASTER_EXPORT_TEMPLATES = [
  { id: "part_number", label: "Part number focused", detail: "One row per canonical part; identity, description, category, and coverage.", columns: ["Make", "Part Number", "Description", "Part Type", "Part Family", "Component Scope", "Side", "Position"] },
  { id: "category", label: "Category focused", detail: "Assembly and category view with each known application row.", columns: ["Make", "Part Type", "Part Family", "Assembly Category", "Part Number", "Description", "Year", "Model"] },
  { id: "attribute", label: "Attribute focused", detail: "One row per product attribute and value for analysis or mapping.", columns: ["Make", "Part Number", "Part Family", "Attribute", "Value", "Value Type", "Method", "Confidence"] },
  { id: "fitment", label: "Fitment focused", detail: "One row per part-to-vehicle application with restrictions and mapping.", columns: ["Make", "Part Number", "Year", "Vehicle Make", "Vehicle Model", "Vehicle Trim", "ePID", "Assembly Category"] },
  { id: "vehicle_fitment", label: "Vehicle fitment matrix", detail: "Fitment rows with mapping confidence, restrictions, quantity, and notes.", columns: ["Make", "Part Number", "Year", "Vehicle Make", "Vehicle Model", "Vehicle Trim", "ePID", "Mapping Confidence"] },
  { id: "assembly_diagram", label: "Assembly / diagram", detail: "Manufacturer fiche view organized by assembly, diagram, position, and reference.", columns: ["Year", "Make", "Model", "Assembly Category", "Assembly GUID", "Diagram GUID", "Pos", "Ref"] },
  { id: "category_attribute", label: "Category attributes", detail: "Category-aware attribute records with evidence and confidence.", columns: ["Make", "Part Number", "Part Type", "Part Family", "Category", "Attribute", "Value", "Method"] },
  { id: "listing_ready", label: "Listing ready", detail: "Clean product title, specifications, reference price, and fitment summary.", columns: ["Make", "Part Number", "Listing Title", "Cleaned Description", "Part Type", "Part Family", "Specifications JSON", "Fitment Summary"] },
  { id: "supersession", label: "Supersession / interchange", detail: "Verified alternate numbers and conditional part relationships.", columns: ["Make", "Part Number", "Relationship Type", "Related Part Number", "Conditions", "Confidence", "Evidence URL"] },
  { id: "source_traceability", label: "Source traceability", detail: "Field-level evidence for auditing and verification.", columns: ["Make", "Part Number", "Field", "Observed Value", "Source URL", "Method", "Confidence", "Accepted"] },
  { id: "quality_review", label: "Data-quality review", detail: "Parts with missing descriptions, classification, attributes, confidence, or review flags.", columns: ["Make", "Part Number", "Description", "Part Type", "Part Family", "Attribute Status", "Online Status", "Review Reasons"] },
  { id: "vehicle_summary", label: "Vehicle summary", detail: "One row per vehicle application with part, fitment, assembly, and mapping counts.", columns: ["Year", "Vehicle Make", "Vehicle Model", "Vehicle Trim", "Vehicle Type", "Part Count", "Fitment Row Count", "Assembly Count"] },
  { id: "manufacturer_specific", label: "Manufacturer-specific", detail: "Manufacturer-ready identity and specifications layout for brand-specific workflows.", columns: ["Make", "Part Number", "Description", "Part Type", "Part Family", "Component Scope", "Side", "Specifications JSON"] },
  { id: "original", label: "Original", detail: "The source scraper row in its original field order and values, plus the preserved raw record.", columns: ["Year", "Make", "Model", "Part category", "Source URL", "POS.", "CODE", "DESCRIPTION", "QTY", "VALIDITY", "NOTES", "dt", "jobId", "Raw Record JSON"] },
  { id: "raw_enriched", label: "Raw + enriched", detail: "Every raw source row plus the standardized master fields and provenance.", columns: ["Year", "Make", "Model", "Fitment Notes", "Est. Year Fitment", "Part Number", "Supersedes Part", "Cleaned Description", "Industry Taxonomy (ACES/PIES)", "Specs", "Availability", "Price (Float)", "Currency", "Pos", "Ref", "Assembly GUID", "Diagram GUID", "Brand Code", "Assembly Category", "Source URL", "Raw Description", "Raw Part Type", "Raw Price", "Raw Quantity", "Raw ePID", "Source Date", "Source Job ID", "Dataset ID", "Source File", "Source Row ID", "Raw Record JSON"] },
  { id: "raw", label: "Raw source", detail: "Every raw source row preserved as JSON with source and row identity.", columns: ["Dataset ID", "Source File", "Source Row ID", "Source URL", "Raw Record JSON"] },
];

export function masterExportTemplate(templateId) {
  return MASTER_EXPORT_TEMPLATES.find((template) => template.id === templateId) || null;
}
