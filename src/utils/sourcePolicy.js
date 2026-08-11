export const SOURCE_POLICY_KEY = "partmaster.approvedSources";
export const FEATURE_SETTINGS_KEY = "partmaster.featureSettings";

export const DEFAULT_APPROVED_SOURCES = {
  Ford: [
    { name: "Ford Parts", url: "https://parts.ford.com/", priority: "Official OEM" },
    { name: "Ford Parts Catalog", url: "https://fordpartscatalog.com/", priority: "Established catalog" },
    { name: "Ford Dealer Parts", url: "https://dealer.parts.ford.com/", priority: "Authorized dealer" },
    { name: "Ford Parts Giant", url: "https://www.fordpartsgiant.com/", priority: "Established catalog" },
    { name: "Tasca Parts", url: "https://www.tascaparts.com/", priority: "Authorized dealer" },
    { name: "Lakeland Ford Parts", url: "https://parts.lakelandford.com/", priority: "Authorized dealer" },
    { name: "OEM Parts Online", url: "https://ford.oempartsonline.com/", priority: "Established catalog" },
  ],
  General: [],
};

export const DEFAULT_FEATURE_SETTINGS = {
  approvedSources: true,
  itemSpecificResearch: true,
  onlineEnrichment: true,
  aiPromptAssistant: true,
  openAiApi: false,
  fieldEvidence: true,
  conflictReview: true,
};

export function loadFeatureSettings() {
  try { return { ...DEFAULT_FEATURE_SETTINGS, ...(JSON.parse(localStorage.getItem(FEATURE_SETTINGS_KEY) || "{}")) }; } catch { return DEFAULT_FEATURE_SETTINGS; }
}

export function saveFeatureSettings(settings) { localStorage.setItem(FEATURE_SETTINGS_KEY, JSON.stringify(settings)); }

export function loadApprovedSources() {
  try {
    const saved = JSON.parse(localStorage.getItem(SOURCE_POLICY_KEY) || "null");
    return saved && typeof saved === "object" ? saved : DEFAULT_APPROVED_SOURCES;
  } catch {
    return DEFAULT_APPROVED_SOURCES;
  }
}

export function saveApprovedSources(sources) {
  localStorage.setItem(SOURCE_POLICY_KEY, JSON.stringify(sources));
}

export function sourcePolicyText(sources, manufacturer = "") {
  const key = Object.keys(sources).find((name) => name.toLowerCase() === String(manufacturer).toLowerCase());
  const entries = sources[key] || sources.General || [];
  if (!entries.length) return "No approved source list is configured for this brand. Use only source URLs supplied with the input and mark unsupported values Unknown.";
  return entries.map((source) => `- ${source.name} (${source.priority}): ${source.url}`).join("\n");
}
