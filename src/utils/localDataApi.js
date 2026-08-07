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
  openFolder: () => request("/open-folder", { method: "POST", body: "{}" }),
  startImport: (filename, name) => request("/imports", { method: "POST", body: JSON.stringify({ filename, name }) }),
  importJob: (jobId) => request(`/imports/${encodeURIComponent(jobId)}`),
  filters: (datasetId) => request(`/datasets/${encodeURIComponent(datasetId)}/filters`),
  rows: (datasetId, parameters) => {
    const query = new URLSearchParams(Object.entries(parameters).filter(([, value]) => value !== "" && value != null));
    return request(`/datasets/${encodeURIComponent(datasetId)}/rows?${query}`);
  },
  updateRow: (datasetId, rowId, changes) => request(`/datasets/${encodeURIComponent(datasetId)}/rows/${encodeURIComponent(rowId)}`, { method: "PATCH", body: JSON.stringify({ changes }) }),
  deleteRow: (datasetId, rowId) => request(`/datasets/${encodeURIComponent(datasetId)}/rows/${encodeURIComponent(rowId)}`, { method: "DELETE" }),
  exportRows: (datasetId, filters) => request(`/datasets/${encodeURIComponent(datasetId)}/exports`, { method: "POST", body: JSON.stringify(filters) }),
  deleteDataset: (datasetId) => request(`/datasets/${encodeURIComponent(datasetId)}`, { method: "DELETE" }),
  enrichmentJobs: () => request("/enrichment/jobs"),
  enrichmentJob: (jobId) => request(`/enrichment/jobs/${encodeURIComponent(jobId)}`),
  startEnrichment: (options) => request("/enrichment/jobs", { method: "POST", body: JSON.stringify(options) }),
  pauseEnrichment: (jobId) => request(`/enrichment/jobs/${encodeURIComponent(jobId)}/pause`, { method: "POST", body: "{}" }),
  resumeEnrichment: (jobId) => request(`/enrichment/jobs/${encodeURIComponent(jobId)}/resume`, { method: "POST", body: "{}" }),
  reprocessEnrichmentReview: (jobId) => request(`/enrichment/jobs/${encodeURIComponent(jobId)}/reprocess-review`, { method: "POST", body: "{}" }),
  enrichmentCandidates: (parameters = {}) => {
    const query = new URLSearchParams(Object.entries(parameters).filter(([, value]) => value !== "" && value != null));
    return request(`/enrichment/candidates?${query}`);
  },
  candidateVariants: (candidateId) => request(`/enrichment/candidates/${encodeURIComponent(candidateId)}/variants`),
  savePartRelationship: (relationship) => request("/master/relationships", { method: "POST", body: JSON.stringify(relationship) }),
  reviewEnrichmentCandidate: (candidateId, changes) => request(`/enrichment/candidates/${encodeURIComponent(candidateId)}`, { method: "PATCH", body: JSON.stringify(changes) }),
  masterStats: () => request("/master/stats"),
  exportMaster: () => request("/master/exports", { method: "POST", body: "{}" }),
};
