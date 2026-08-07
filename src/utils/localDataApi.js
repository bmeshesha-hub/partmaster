const API_ROOT = "/api/local";

async function request(path, options) {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Local data request failed (${response.status}).`);
  return body;
}

export const localDataApi = {
  health: () => request("/health"),
  files: () => request("/files"),
  datasets: () => request("/datasets"),
  vehicleMappings: () => request("/vehicle-mappings"),
  openFolder: () => request("/open-folder", { method: "POST", body: "{}" }),
  startImport: (filename, name) => request("/imports", { method: "POST", body: JSON.stringify({ filename, name }) }),
  importJob: (jobId) => request(`/imports/${encodeURIComponent(jobId)}`),
  filters: (datasetId) => request(`/datasets/${encodeURIComponent(datasetId)}/filters`),
  rows: (datasetId, parameters) => {
    const query = new URLSearchParams(Object.entries(parameters).filter(([, value]) => value !== "" && value != null));
    return request(`/datasets/${encodeURIComponent(datasetId)}/rows?${query}`);
  },
  updateRow: (datasetId, rowId, changes) => request(`/datasets/${encodeURIComponent(datasetId)}/rows/${encodeURIComponent(rowId)}`, { method: "PATCH", body: JSON.stringify({ changes }) }),
  previewRowEnhancement: (datasetId, rowId) => request(`/datasets/${encodeURIComponent(datasetId)}/rows/${encodeURIComponent(rowId)}/enhance`, { method: "POST", body: JSON.stringify({ apply: false }) }),
  startRowEnhancement: (datasetId, rowIds) => request(`/datasets/${encodeURIComponent(datasetId)}/row-enhancement-jobs`, { method: "POST", body: JSON.stringify({ rowIds }) }),
  rowEnhancementJob: (jobId) => request(`/row-enhancement-jobs/${encodeURIComponent(jobId)}`),
  deleteRow: (datasetId, rowId) => request(`/datasets/${encodeURIComponent(datasetId)}/rows/${encodeURIComponent(rowId)}`, { method: "DELETE" }),
  exportRows: (datasetId, filters) => request(`/datasets/${encodeURIComponent(datasetId)}/exports`, { method: "POST", body: JSON.stringify(filters) }),
  deleteDataset: (datasetId) => request(`/datasets/${encodeURIComponent(datasetId)}`, { method: "DELETE" }),
  pipelineJobs: () => request("/pipeline/jobs"),
  startPipeline: (options) => request("/pipeline/jobs", { method: "POST", body: JSON.stringify(options) }),
  pausePipeline: (jobId) => request(`/pipeline/jobs/${encodeURIComponent(jobId)}/pause`, { method: "POST", body: "{}" }),
  resumePipeline: (jobId) => request(`/pipeline/jobs/${encodeURIComponent(jobId)}/resume`, { method: "POST", body: "{}" }),
  pipelineCatalog: (query = "") => request(`/pipeline/catalog${query ? `?q=${encodeURIComponent(query)}` : ""}`),
  exportPipelineCatalog: () => request("/pipeline/exports", { method: "POST", body: "{}" }),
  enrichmentJobs: () => request("/enrichment/jobs"),
  enrichmentJob: (jobId) => request(`/enrichment/jobs/${encodeURIComponent(jobId)}`),
  enrichmentTransformation: (jobId, candidateId = "") => request(`/enrichment/jobs/${encodeURIComponent(jobId)}/transformation${candidateId ? `?candidateId=${encodeURIComponent(candidateId)}` : ""}`),
  startEnrichment: (options) => request("/enrichment/jobs", { method: "POST", body: JSON.stringify(options) }),
  pauseEnrichment: (jobId) => request(`/enrichment/jobs/${encodeURIComponent(jobId)}/pause`, { method: "POST", body: "{}" }),
  resumeEnrichment: (jobId) => request(`/enrichment/jobs/${encodeURIComponent(jobId)}/resume`, { method: "POST", body: "{}" }),
  reprocessEnrichmentReview: (jobId) => request(`/enrichment/jobs/${encodeURIComponent(jobId)}/reprocess-review`, { method: "POST", body: "{}" }),
  enrichmentCandidates: (parameters = {}) => {
    const query = new URLSearchParams(Object.entries(parameters).filter(([, value]) => value !== "" && value != null));
    return request(`/enrichment/candidates?${query}`);
  },
  candidateVariants: (candidateId) => request(`/enrichment/candidates/${encodeURIComponent(candidateId)}/variants`),
  checkMasterPart: (partId) => request(`/master/parts/${encodeURIComponent(partId)}/check`, { method: "POST", body: "{}" }),
  fetchCandidateCompatibility: (candidateId, options = {}) => request(`/enrichment/candidates/${encodeURIComponent(candidateId)}/compatibility`, { method: "POST", body: JSON.stringify(options) }),
  savePartRelationship: (relationship) => request("/master/relationships", { method: "POST", body: JSON.stringify(relationship) }),
  reviewEnrichmentCandidate: (candidateId, changes) => request(`/enrichment/candidates/${encodeURIComponent(candidateId)}`, { method: "PATCH", body: JSON.stringify(changes) }),
  masterStats: () => request("/master/stats"),
  masterQuality: () => request("/master/quality"),
  intelligenceOverview: () => request("/intelligence/overview"),
  intelligenceCategories: () => request("/intelligence/categories"),
  intelligencePriority: () => request("/intelligence/priority"),
  intelligenceConflicts: () => request("/intelligence/conflicts"),
  intelligenceRelationships: () => request("/intelligence/relationships"),
  autopilotJobs: () => request("/intelligence/autopilot/jobs"),
  autopilotJob: (jobId) => request(`/intelligence/autopilot/jobs/${encodeURIComponent(jobId)}`),
  startAutopilot: (options) => request("/intelligence/autopilot/jobs", { method: "POST", body: JSON.stringify(options) }),
  pauseAutopilot: (jobId) => request(`/intelligence/autopilot/jobs/${encodeURIComponent(jobId)}/pause`, { method: "POST", body: "{}" }),
  resumeAutopilot: (jobId) => request(`/intelligence/autopilot/jobs/${encodeURIComponent(jobId)}/resume`, { method: "POST", body: "{}" }),
  refreshIntelligence: () => request("/intelligence/refresh", { method: "POST", body: "{}" }),
  searchIntelligence: (query) => request(`/intelligence/search?q=${encodeURIComponent(query)}`),
  intelligencePart: (partId) => request(`/intelligence/parts/${encodeURIComponent(partId)}`),
  addPartAlias: (partId, alias) => request(`/intelligence/parts/${encodeURIComponent(partId)}/aliases`, { method: "POST", body: JSON.stringify(alias) }),
  exportMaster: () => request("/master/exports", { method: "POST", body: "{}" }),
};
