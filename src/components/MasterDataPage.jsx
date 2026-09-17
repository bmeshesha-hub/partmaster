import { BarChart3, ChevronLeft, ChevronRight, Database, Download, ExternalLink, Globe2, HardDrive, LoaderCircle, Search, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CatalogPartRow from "./CatalogPartRow.jsx";
import { localDataApi } from "../utils/localDataApi.js";
import { MASTER_EXPORT_TEMPLATES } from "../../shared/masterExportTemplates.js";
import { staticMasterTemplateCsv, staticMasterTemplatePreview } from "../utils/staticMasterExports.js";

const INITIAL_QUERY = { q: "", manufacturer: "", family: "", onlineStatus: "", factStatus: "", fitmentStatus: "", descriptionStatus: "", minConfidence: "", maxConfidence: "", minOccurrences: "", sort: "part_number", direction: "asc", page: 1, pageSize: 50 };
const LOCAL_URL = "http://127.0.0.1:5173/partmaster/";
const GOOGLE_DRIVE_MASTERDATA_URL = import.meta.env.VITE_GOOGLE_DRIVE_MASTERDATA_URL || "";
const SNAPSHOT_BASE = `${import.meta.env.BASE_URL}data/`;
async function loadPublishedCatalog() {
  const indexResponse = await fetch(`${SNAPSHOT_BASE}master-catalog-index.json`);
  if (indexResponse.ok) {
    const index = await indexResponse.json();
    const chunkResponses = await Promise.all((index.chunks || []).map((chunk) => fetch(`${SNAPSHOT_BASE.replace(/data\/$/, "")}${chunk}`)));
    if (chunkResponses.every((response) => response.ok)) {
      const chunks = await Promise.all(chunkResponses.map((response) => response.json()));
      return { ...index, rows: chunks.flatMap((chunk) => chunk.rows || []) };
    }
  }
  const legacyResponse = await fetch(`${SNAPSHOT_BASE}master-catalog.json`);
  return legacyResponse.ok ? legacyResponse.json() : null;
}

function number(value) { return Number(value || 0).toLocaleString(); }
function percent(value, total) { return Number(total) ? `${Math.round((Number(value || 0) / Number(total)) * 100)}%` : "0%"; }
function validPartNumber(value) {
  const normalized = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized.length >= 3 && normalized.length <= 50 && /[0-9]/.test(normalized)
    && !/^(0+|NA|NONE|NULL|UNKNOWN|UNAVAILABLE|NOTAVAILABLE|TBD|MISSING|X+)$/.test(normalized);
}
function MetricCard({ label, value, detail, tone = "text-slate-950", onClick }) {
  const content = <><p className="text-[11px] font-black uppercase tracking-wide text-slate-500">{label}</p><p className={`mt-2 text-2xl font-black ${tone}`}>{number(value)}</p><p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p>{onClick && <p className="mt-3 text-[11px] font-black text-brand-700">Click for quick view →</p>}</>;
  return onClick ? <button type="button" onClick={onClick} className="rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md">{content}</button> : <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">{content}</article>;
}

function TemplatePreview({ preview, loading, error }) {
  if (loading) return <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-500">Loading 10-row preview…</div>;
  if (error) return <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{error}</div>;
  if (!preview?.rows?.length) return <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-500">No rows are available for this template yet.</div>;
  return <div className="mt-4 overflow-hidden rounded-xl border border-slate-200"><div className="overflow-x-auto"><table className="min-w-full text-left text-xs"><thead className="bg-slate-100 text-[10px] font-black uppercase tracking-wide text-slate-600"><tr>{preview.columns.map((column) => <th key={column} className="whitespace-nowrap px-3 py-2">{column}</th>)}</tr></thead><tbody className="divide-y divide-slate-100 bg-white">{preview.rows.map((row, index) => <tr key={`${index}-${row[preview.columns[0]]}`} className="align-top">{preview.columns.map((column) => <td key={column} className="max-w-64 truncate whitespace-nowrap px-3 py-2 font-mono text-[11px] text-slate-700" title={String(row[column] ?? "")}>{row[column] == null || row[column] === "" ? "—" : String(row[column])}</td>)}</tr>)}</tbody></table></div></div>;
}

function Bars({ title, subtitle, rows, valueKey = "parts", accent = "bg-brand-500" }) {
  const max = Math.max(...(rows || []).map((row) => Number(row[valueKey] || 0)), 1);
  return <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-panel sm:p-6"><div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700"><BarChart3 size={19} /></span><div><h3 className="font-black">{title}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{subtitle}</p></div></div><div className="mt-5 space-y-3">{(rows || []).map((row) => <div key={row.label}><div className="mb-1 flex items-center justify-between gap-3 text-xs"><span className="truncate font-bold text-slate-700" title={row.label}>{row.label}</span><span className="font-black text-slate-900">{number(row[valueKey])}</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${accent}`} style={{ width: `${Math.max(1, (Number(row[valueKey]) / max) * 100)}%` }} /></div></div>)}</div></section>;
}

export default function MasterDataPage() {
  const [metrics, setMetrics] = useState(null);
  const [metricSource, setMetricSource] = useState("snapshot");
  const [connected, setConnected] = useState(null);
  const [localServiceAvailable, setLocalServiceAvailable] = useState(null);
  const [filters, setFilters] = useState({ manufacturers: [], families: [] });
  const [query, setQuery] = useState(INITIAL_QUERY);
  const [catalog, setCatalog] = useState({ rows: [], total: 0, page: 1, pages: 1, pageSize: 50 });
  const [tableLoading, setTableLoading] = useState(false);
  const [tableError, setTableError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const [fullExporting, setFullExporting] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const [masterTab, setMasterTab] = useState("catalog");
  const [fpaExporting, setFpaExporting] = useState(false);
  const [fpaExportMessage, setFpaExportMessage] = useState("");
  const [fitmentRecoveryStarting, setFitmentRecoveryStarting] = useState(false);
  const [exportTemplate, setExportTemplate] = useState("raw_enriched");
  const [templatePreview, setTemplatePreview] = useState({ columns: [], rows: [] });
  const [templatePreviewLoading, setTemplatePreviewLoading] = useState(false);
  const [templatePreviewError, setTemplatePreviewError] = useState("");
  const [templateExporting, setTemplateExporting] = useState(false);
  const [templateCapabilities, setTemplateCapabilities] = useState(null);
  const requestSerial = useRef(0);
  const [tableDensity, setTableDensity] = useState("standard");
  const [publishedCatalog, setPublishedCatalog] = useState(null);
  const publicMode = !["127.0.0.1", "localhost", "::1"].includes(window.location.hostname);

  useEffect(() => {
    Promise.all([
      fetch(`${import.meta.env.BASE_URL}data/master-metrics.json`).then((response) => response.ok ? response.json() : null),
      loadPublishedCatalog(),
    ]).then(([snapshot, catalogSnapshot]) => {
      if (snapshot) setMetrics(snapshot);
      if (catalogSnapshot?.rows) {
        setPublishedCatalog(catalogSnapshot);
        setFilters(catalogSnapshot.filters || { manufacturers: [], families: [] });
        setMetrics((current) => ({ ...(current || {}), summary: { ...(current?.summary || {}), ...(catalogSnapshot.summary || {}) } }));
      }
    }).catch(() => null);
    const localHostname = ["127.0.0.1", "localhost", "::1"].includes(window.location.hostname);
    if (!localHostname) {
      setConnected(true);
      return;
    }
    Promise.all([localDataApi.masterDashboard(), localDataApi.masterCatalogFilters(), localDataApi.pipelineSources()])
      .then(([dashboard, availableFilters, sourceAudit]) => {
        setLocalServiceAvailable(true);
        const coverage = sourceAudit.summary || {};
        const liveDashboard = {
          ...dashboard,
          summary: {
            ...dashboard.summary,
            raw_rows: coverage.known_raw_rows,
            scanned_rows: coverage.indexed_raw_rows,
            raw_rows_remaining: coverage.pending_scan_rows,
            invalid_rows: coverage.invalid_rows,
            duplicate_occurrences: Math.max(0, Number(coverage.usable_rows || 0) - Number(coverage.raw_unique_parts || 0)),
            master_parts_remaining: coverage.remaining_master_parts,
            parts_missing_facts: coverage.remaining_fact_parts,
          },
          source_pages: {
            ...dashboard.source_pages,
            source_pages: coverage.source_pages,
            processed_pages: coverage.processed_source_pages,
            pending_pages: coverage.pending_source_pages,
          },
        };
        setMetrics(liveDashboard); setMetricSource("live"); setFilters(availableFilters); setConnected(true);
      })
      .catch(() => {
        setLocalServiceAvailable(false);
        // The published snapshot remains browseable when the optional local
        // DuckDB service is unavailable. Editing/enrichment still requires it.
        setMetricSource("snapshot");
        setConnected(true);
      });
  }, []);

  useEffect(() => {
    if (publicMode || connected !== true) return undefined;
    let active = true;
    localDataApi.masterTemplateCapabilities()
      .then((result) => { if (active) setTemplateCapabilities(result); })
      .catch(() => { if (active) setTemplateCapabilities({ templates: [], error: "The local data service is older than this site. Restart it to enable export templates." }); });
    return () => { active = false; };
  }, [connected, publicMode]);

  useEffect(() => {
    if (!publicMode || masterTab !== "export" || !publishedCatalog?.rows) return undefined;
    let active = true;
    setTemplateCapabilities({ templates: MASTER_EXPORT_TEMPLATES, source: "published_snapshot" });
    setTemplatePreviewLoading(true);
    setTemplatePreviewError("");
    const timer = window.setTimeout(() => {
      try {
        const preview = staticMasterTemplatePreview(publishedCatalog.rows, exportTemplate);
        if (active) setTemplatePreview(preview);
      } catch (error) {
        if (active) {
          setTemplatePreview({ columns: [], rows: [] });
          setTemplatePreviewError(error.message);
        }
      } finally {
        if (active) setTemplatePreviewLoading(false);
      }
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [exportTemplate, masterTab, publicMode, publishedCatalog]);

  useEffect(() => {
    if (masterTab !== "export" || publicMode || connected !== true || localServiceAvailable === false) return undefined;
    if (!templateCapabilities) return undefined;
    if (templateCapabilities.error) {
      setTemplatePreview({ columns: [], rows: [] });
      setTemplatePreviewError(templateCapabilities.error);
      return undefined;
    }
    if (!templateCapabilities.templates?.some((template) => template.id === exportTemplate)) {
      setTemplatePreview({ columns: [], rows: [] });
      setTemplatePreviewError("This template is not supported by the local data service.");
      return undefined;
    }
    let active = true;
    setTemplatePreviewLoading(true); setTemplatePreviewError("");
    localDataApi.masterTemplatePreview(exportTemplate)
      .then((result) => { if (active) setTemplatePreview(result); })
      .catch((error) => { if (active) { setTemplatePreview({ columns: [], rows: [] }); setTemplatePreviewError(error.message); } })
      .finally(() => { if (active) setTemplatePreviewLoading(false); });
    return () => { active = false; };
  }, [connected, exportTemplate, localServiceAvailable, masterTab, publicMode, templateCapabilities]);

  const loadCatalog = useCallback(async (parameters) => {
    if (!connected) return;
    if ((publicMode || localServiceAvailable === false) && !publishedCatalog) return;
    const serial = ++requestSerial.current;
    setTableLoading(true); setTableError("");
    try {
      let result;
      if (publishedCatalog && (publicMode || localServiceAvailable === false)) {
        const search = String(parameters.q || "").trim().toLowerCase();
        const matches = publishedCatalog.rows.filter((part) => {
          if (!validPartNumber(part.part_number)) return false;
          const text = JSON.stringify(part).toLowerCase();
          const hasFitment = Boolean(part.fitments?.length || part.additional_fitments?.length);
          return (!search || text.includes(search)) && (!parameters.manufacturer || part.manufacturer === parameters.manufacturer) && (!parameters.family || (part.family_name || "Unclassified") === parameters.family) && (!parameters.fitmentStatus || (parameters.fitmentStatus === "present" ? hasFitment : !hasFitment)) && (!parameters.factStatus || (parameters.factStatus === "with_facts" ? part.attributes?.length : !part.attributes?.length)) && (!parameters.descriptionStatus || (parameters.descriptionStatus === "present" ? part.description : !part.description));
        });
        const pageSize = Number(parameters.pageSize || 50); const page = Number(parameters.page || 1);
        result = { rows: matches.slice((page - 1) * pageSize, page * pageSize), total: matches.length, page, pages: Math.max(1, Math.ceil(matches.length / pageSize)), pageSize };
      } else result = await localDataApi.masterCatalog(parameters);
      if (serial === requestSerial.current) setCatalog(result);
    }
    catch (error) { if (serial === requestSerial.current) { setCatalog({ rows: [], total: 0, page: 1, pages: 1 }); setTableError(error.message); } }
    finally { if (serial === requestSerial.current) setTableLoading(false); }
  }, [connected, localServiceAvailable, publishedCatalog, publicMode]);

  useEffect(() => {
    if (!connected) return undefined;
    const timer = window.setTimeout(() => loadCatalog({ ...query, view: masterTab === "quality" ? "audit" : "catalog" }), 300);
    return () => { window.clearTimeout(timer); requestSerial.current += 1; };
  }, [connected, loadCatalog, query, masterTab]);

  const summary = metrics?.summary || {};
  const sourcePages = metrics?.source_pages || {};
  const partsMissingFacts = Number(summary.parts_missing_facts ?? Math.max(0, Number(summary.unique_parts || 0) - Number(summary.parts_with_facts || 0)));
  const visibleFamilies = useMemo(() => (metrics?.families || []).slice(0, 10), [metrics]);
  const updateQuery = (changes) => setQuery((current) => ({ ...current, ...changes, page: changes.page || 1 }));
  async function exportFiltered() {
    setExporting(true); setExportMessage("");
    try { const result = await localDataApi.exportMasterCatalog({ ...query, view: masterTab === "quality" ? "audit" : "catalog" }); setExportMessage(`Exported ${number(result.count)} matching parts.`); (result.exports || []).forEach((item) => { const link = document.createElement("a"); link.href = item.downloadUrl; link.download = item.filename; link.click(); }); }
    catch (error) { setExportMessage(error.message); } finally { setExporting(false); }
  }
  async function exportAllMasterData() {
    setFullExporting(true); setExportMessage("");
    try {
      if (publicMode) {
        if (!publishedCatalog?.rows?.length) throw new Error("The published catalog snapshot is still loading.");
        const blob = new Blob([staticMasterTemplateCsv(publishedCatalog.rows, "part_number")], { type: "text/csv;charset=utf-8" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "master-catalog-published.csv";
        document.body.appendChild(link); link.click(); link.remove();
        URL.revokeObjectURL(link.href);
        setExportMessage("Downloaded the published catalog snapshot. The complete raw-to-master extract remains available from the local catalog service.");
        return;
      }
      const result = await localDataApi.exportMasterCatalog();
      const exports = result.exports || [];
      const catalogExport = exports.find((item) => item.filename.startsWith("master-catalog-all-"));
      const masterExtract = exports.find((item) => item.filename.startsWith("master-extract-all-"));
      if (!catalogExport) throw new Error("The master catalog export was not generated.");
      [catalogExport, masterExtract].filter(Boolean).forEach((item) => {
        const link = document.createElement("a");
        link.href = item.downloadUrl || `/api/local/exports/${encodeURIComponent(item.filename)}`;
        link.download = item.filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
      });
      setExportMessage(masterExtract
        ? `Downloaded the complete catalog and the raw-to-master extract: ${masterExtract.filename}.`
        : `Downloaded the complete master catalog: ${catalogExport.filename}.`);
    }
    catch (error) { setExportMessage(error.message); } finally { setFullExporting(false); }
  }
  async function exportSelectedTemplate() {
    setTemplateExporting(true); setExportMessage("");
    try {
      const label = MASTER_EXPORT_TEMPLATES.find((template) => template.id === exportTemplate)?.label || "selected";
      if (publicMode) {
        if (!publishedCatalog?.rows?.length) throw new Error("The published catalog snapshot is still loading.");
        const blob = new Blob([staticMasterTemplateCsv(publishedCatalog.rows, exportTemplate)], { type: "text/csv;charset=utf-8" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `master-template-${exportTemplate}-published.csv`;
        document.body.appendChild(link); link.click(); link.remove();
        URL.revokeObjectURL(link.href);
        setExportMessage(`Downloaded the ${label} template from the published catalog snapshot.`);
      } else {
        const result = await localDataApi.exportMasterTemplate(exportTemplate);
        const item = result.exports?.[0];
        if (!item) throw new Error("The selected template export was not generated.");
        const link = document.createElement("a");
        link.href = item.downloadUrl || `/api/local/exports/${encodeURIComponent(item.filename)}`;
        link.download = item.filename;
        document.body.appendChild(link); link.click(); link.remove();
        setExportMessage(`Downloaded the ${label} template.`);
      }
    } catch (error) { setExportMessage(error.message); }
    finally { setTemplateExporting(false); }
  }
  async function exportFpa() {
    setFpaExporting(true); setFpaExportMessage("");
    try { const result = await localDataApi.exportFpa(); const item = result.exports?.[0]; if (!item) throw new Error("No FPA export was generated."); const link = document.createElement("a"); link.href = item.downloadUrl; link.download = item.filename; document.body.appendChild(link); link.click(); link.remove(); setFpaExportMessage(`Exported ${number(result.count)} ready fitment rows.`); }
    catch (error) { setFpaExportMessage(error.message); } finally { setFpaExporting(false); }
  }
  async function startOnlineFitmentRecovery() {
    setFitmentRecoveryStarting(true); setFpaExportMessage("");
    try {
      const result = await localDataApi.startFitmentEnrichment({ mode: "online_recovery", name: "Online fitment recovery — missing vehicle fields", batchSize: 1000, intervalMinutes: 5 });
      setFpaExportMessage(result.candidateCount ? `Queued ${number(result.candidateCount)} unresolved fitment rows for targeted online recovery. Batches: 1,000 rows, then a 5-minute pause.` : "No unresolved fitment rows are waiting for online recovery.");
    }
    catch (error) { setFpaExportMessage(error.message); }
    finally { setFitmentRecoveryStarting(false); }
  }
  async function revalidateMasterData() {
    setRevalidating(true); setExportMessage("");
    try {
      const result = await localDataApi.revalidateMasterCatalog();
      setMetrics((current) => current ? { ...current, summary: { ...current.summary, unique_parts: result.remaining_parts } } : current);
      await loadCatalog({ ...query, view: "audit" });
      const mappingStatus = result.vehicle_mapping_validation?.status === "passed"
        ? " Vehicle mapping validation passed for both workbook tabs."
        : " Vehicle mapping validation is not passing; fitment mappings should be reviewed."
      if (result.quarantined) {
        const reasons = (result.reasons || []).map((item) => `${item.reason_code}: ${number(item.count)}`).join(", ");
        setExportMessage(`Quarantined ${number(result.quarantined)} impure part numbers${reasons ? ` (${reasons})` : ""}; ${number(result.review_flags || 0)} softer review flags remain. Source rows were preserved.${mappingStatus}`);
      } else setExportMessage(`No hard impurities found; ${number(result.review_flags || 0)} softer review flags remain. Availability and discontinued status do not affect catalog inclusion.${mappingStatus}`);
    }
    catch (error) { setExportMessage(error.message); } finally { setRevalidating(false); }
  }

  const control = "mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium normal-case tracking-normal";
  const isAudit = masterTab === "quality";
  const templateCapabilitiesKnown = Boolean(templateCapabilities && !templateCapabilities.error);
  const selectedTemplateSupported = templateCapabilitiesKnown && templateCapabilities.templates?.some((template) => template.id === exportTemplate);
  const templateCanRun = selectedTemplateSupported || Boolean(templateCapabilities?.error);
  const chooseTab = (tab) => {
    setMasterTab(tab);
    setExportMessage("");
    if (tab !== "quality") setQuery((current) => ({ ...current, onlineStatus: "", minConfidence: "", maxConfidence: "", minOccurrences: "", sort: ["occurrences", "confidence"].includes(current.sort) ? "part_number" : current.sort, direction: ["occurrences", "confidence"].includes(current.sort) ? "asc" : current.direction, page: 1 }));
  };

  return <div className="space-y-6">
    <section className="rounded-3xl bg-gradient-to-br from-slate-950 via-blue-950 to-emerald-950 px-6 py-7 text-white shadow-panel sm:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-cyan-300"><Database size={16} />Shared parts catalog</p><h3 className="mt-2 text-3xl font-black tracking-tight">Know the part. Find the fit. See every detail.</h3><p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">Reusable part identities, vehicle fitments, and detailed specifications for Partout Pro and other apps. Help sellers describe parts accurately and buyers check compatibility.</p></div><span className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-bold">{metricSource === "live" ? "Local catalog connected" : "Catalog snapshot"}</span></div>
    </section>
    <nav className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm" aria-label="Master data views">{[["catalog", "Parts catalog"], ["export", "Export for apps"], ["quality", "Data quality"]].map(([tab, title]) => <button key={tab} type="button" onClick={() => chooseTab(tab)} aria-pressed={masterTab === tab} className={`rounded-xl px-4 py-2 text-sm font-black ${masterTab === tab ? "bg-brand-700 text-white" : "text-slate-600 hover:bg-slate-50"}`}>{title}</button>)}</nav>

    {masterTab === "export" ? <section className="rounded-3xl border border-emerald-200 bg-white p-6 shadow-panel sm:p-8">
      <p className="text-xs font-black uppercase tracking-wide text-emerald-700">Partout Pro & other apps</p><h3 className="mt-2 text-2xl font-black">A reusable catalog with complete part details</h3><p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">{publicMode ? "Browse the published master snapshot, choose a column layout, preview 10 rows, and download the selected CSV directly in your browser." : "Download the canonical catalog plus a raw-to-master extract built from every imported source row. Fitment restrictions stay attached to the correct vehicle, and raw provenance remains available for review."}</p>
      <div className="mt-6 grid gap-4 md:grid-cols-3">{[["Part identity", "Manufacturer, OEM number, description, family, component scope, and side or position."], ["Fitment & installation", "Year, make, model, trim, ePID, assembly, quantity, and required or excluded options for each fitment."], ["Specifications & alternatives", "All recorded product and variant attributes, confirmed alternate numbers, and conditional replacement relationships."]].map(([title, description]) => <article key={title} className="rounded-2xl border border-slate-200 bg-slate-50 p-4"><h4 className="font-black">{title}</h4><p className="mt-2 text-sm leading-6 text-slate-600">{description}</p></article>)}</div>
      <div className="mt-6 rounded-2xl border border-cyan-200 bg-cyan-50/70 p-4"><p className="text-xs font-black uppercase tracking-wide text-cyan-800">{publicMode ? "Published snapshot exports" : "Raw → master extract"}</p><p className="mt-1 text-sm leading-6 text-cyan-950">{publicMode ? "Public previews and CSV downloads are generated from the published master snapshot in your browser. The complete raw source rows, internal evidence, and enrichment workers remain local." : "Every raw source row is enriched with Year, Make, Model, Fitment Notes, Est. Year Fitment, Part Number, Supersedes Part, Cleaned Description, Industry Taxonomy, Specs, Availability, numeric Price, Currency, Pos, Ref, Assembly GUID, Diagram GUID, Brand Code, and source traceability."}</p></div>
      <div className="mt-6 rounded-2xl border border-violet-200 bg-violet-50/50 p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-wide text-violet-700">Choose an export template</p><h4 className="mt-1 text-lg font-black text-violet-950">Different column arrangements for different workflows</h4><p className="mt-1 text-sm leading-5 text-violet-900">Select a format, review the first 10 rows, then export the full matching dataset.</p></div><span className="rounded-full bg-white px-3 py-1 text-[11px] font-black text-violet-700">{templatePreview.rows.length || 0} preview rows</span></div><div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{MASTER_EXPORT_TEMPLATES.map((template) => { const supported = !templateCapabilitiesKnown || templateCapabilities.templates?.some((item) => item.id === template.id); return <button key={template.id} type="button" onClick={() => setExportTemplate(template.id)} disabled={templateCapabilitiesKnown && !supported} className={`rounded-xl border p-3 text-left transition ${exportTemplate === template.id ? "border-violet-500 bg-white shadow-sm ring-2 ring-violet-200" : "border-violet-100 bg-white/60 hover:border-violet-300"} disabled:cursor-not-allowed disabled:opacity-50`}><span className="block text-sm font-black text-slate-900">{template.label}</span><span className="mt-1 block text-xs leading-5 text-slate-600">{template.detail}</span><span className="mt-2 block truncate font-mono text-[10px] text-violet-700">{template.columns.join(" · ")}</span></button>; })}</div><div className="mt-5 flex flex-wrap items-center justify-between gap-3"><p className="text-xs font-bold text-slate-600">Preview: {MASTER_EXPORT_TEMPLATES.find((template) => template.id === exportTemplate)?.label}</p><button type="button" onClick={exportSelectedTemplate} disabled={templateExporting || !connected || !templateCanRun} className="inline-flex items-center gap-2 rounded-xl bg-violet-700 px-4 py-2.5 text-sm font-black text-white disabled:opacity-50"><Download size={16} />{templateExporting ? "Preparing template…" : "Export selected template"}</button></div><TemplatePreview preview={templatePreview} loading={templatePreviewLoading} error={templatePreviewError} /></div>
      <div className="mt-6 flex flex-wrap gap-3"><button type="button" onClick={exportAllMasterData} disabled={!connected || fullExporting} className="inline-flex items-center gap-2 rounded-xl bg-brand-700 px-5 py-3 text-sm font-black text-white disabled:opacity-50"><Download size={17} />{fullExporting ? "Preparing exports…" : publicMode ? "Download published catalog" : "Download catalog + raw-to-master extract"}</button><button type="button" onClick={() => chooseTab("catalog")} className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-bold">Filter & preview parts</button>{GOOGLE_DRIVE_MASTERDATA_URL && <a href={GOOGLE_DRIVE_MASTERDATA_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-5 py-3 text-sm font-black text-emerald-800"><ExternalLink size={17} />Open approved Drive snapshot</a>}</div>
      <p className="mt-4 text-xs leading-5 text-slate-500">{publicMode ? "Public CSVs are generated from the catalog snapshot currently published with this site. For the complete raw-to-master extract with source provenance, use the local catalog service." : <>The button downloads both the canonical catalog and <span className="font-mono">master-extract-all-*.csv</span>. The raw-to-master file excludes marketplace sales/live metrics and keeps source provenance for every row.</>}</p>
      {exportMessage && <p role="status" className="mt-4 rounded-xl bg-slate-100 p-3 text-sm">{exportMessage}</p>}
      {!connected && <p className="mt-4 text-sm font-semibold text-amber-800">Connect the local data service to download the catalog.</p>}
      <details className="mt-6 rounded-xl border border-slate-200 p-4"><summary className="cursor-pointer text-sm font-bold text-slate-600">Legacy FPA integration</summary><p className="mt-3 text-sm text-slate-500">Keep the existing FPA format for integrations that require its fitment rows and internal evidence fields. Use the parts catalog above for the shared application format.</p><button type="button" onClick={exportFpa} disabled={fpaExporting || !connected || publicMode} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold disabled:opacity-50"><Download size={15} />{fpaExporting ? "Preparing…" : "Download legacy FPA CSV"}</button>{publicMode && <p className="mt-3 text-xs text-slate-500">Legacy FPA export is available from the local catalog service.</p>}{fpaExportMessage && <p role="status" className="mt-3 text-sm">{fpaExportMessage}</p>}</details>
    </section> : <>
      {isAudit ? <>
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5"><h3 className="font-black text-amber-950">Internal data quality & traceability</h3><p className="mt-2 text-sm text-amber-900">Review collection coverage, source evidence, and processing status here. Open a part’s details to inspect its provenance. Audit exports include internal fields alongside the product data.</p><button type="button" onClick={startOnlineFitmentRecovery} disabled={fitmentRecoveryStarting || !connected} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-bold text-amber-900 disabled:opacity-50"><Globe2 size={15} />{fitmentRecoveryStarting ? "Queuing recovery…" : "Recover missing fitments online"}</button>{fpaExportMessage && <p role="status" className="mt-3 text-sm">{fpaExportMessage}</p>}</section>
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><MetricCard label="Raw source rows" value={summary.raw_rows} detail={`${number(summary.scanned_rows)} scanned`} /><MetricCard label="Duplicates consolidated" value={summary.duplicate_occurrences} detail="Repeated source appearances" /><MetricCard label="Source pages" value={sourcePages.source_pages} detail={`${number(sourcePages.processed_pages)} processed`} /><MetricCard label="Quality review" value={summary.parts_needing_review} detail={`${number(summary.review_flags)} open flags`} tone="text-amber-700" /></section>
        <div className="grid gap-6 lg:grid-cols-2"><Bars title="Parts by manufacturer" subtitle="Catalog coverage by manufacturer" rows={metrics?.manufacturers} /><Bars title="Largest part families" subtitle="Catalog coverage by category" rows={visibleFamilies} accent="bg-emerald-500" /></div>
      </> : <section className="grid gap-3 sm:grid-cols-3"><MetricCard label="Catalog parts" value={summary.unique_parts} detail="Shared manufacturer and OEM identities" /><MetricCard label="Parts with specifications" value={summary.parts_with_facts} detail={`${percent(summary.parts_with_facts, summary.unique_parts)} have extracted attributes`} tone="text-emerald-700" /><MetricCard label="Awaiting specifications" value={partsMissingFacts} detail="Available details remain searchable" tone="text-amber-700" /></section>}

      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-panel"><header className="border-b border-slate-200 px-5 py-5 sm:px-6"><h3 className="text-xl font-black">Find a part and inspect its details</h3><p className="mt-2 text-sm text-slate-500">Search by OEM or alternate number, description, vehicle model, category, or specification.</p></header>
      {connected === false ? <div className="flex flex-wrap items-center justify-between gap-4 p-6"><div><h4 className="flex items-center gap-2 font-black"><HardDrive size={19} />Connect your local parts catalog</h4><p className="mt-2 text-sm text-slate-600">Start <code className="text-xs">npm run dev:local</code> to browse the detailed records stored on this Mac.</p></div><a href={LOCAL_URL} className="inline-flex items-center gap-2 rounded-xl bg-brand-700 px-5 py-3 text-sm font-black text-white"><ExternalLink size={16} />Open local catalog</a></div> : connected === null ? <div className="grid min-h-40 place-items-center"><LoaderCircle className="animate-spin text-brand-600" size={26} /></div> : <>
        <div className="grid gap-3 border-b border-slate-200 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-[11px] font-bold text-slate-600 sm:col-span-2">Search parts & fitments<input value={query.q} onChange={(event) => updateQuery({ q: event.target.value })} placeholder="Part number, CB500, heated, aluminum…" className={control} /></label>
          <label className="text-[11px] font-bold text-slate-600">Manufacturer<select value={query.manufacturer} onChange={(event) => updateQuery({ manufacturer: event.target.value })} className={control}><option value="">All manufacturers</option>{filters.manufacturers.map((item) => <option key={item.value} value={item.value}>{item.value}</option>)}</select></label>
          <label className="text-[11px] font-bold text-slate-600">Part family<select value={query.family} onChange={(event) => updateQuery({ family: event.target.value })} className={control}><option value="">All families</option>{filters.families.map((item) => <option key={item.value} value={item.value}>{item.value}</option>)}</select></label>
          <label className="text-[11px] font-bold text-slate-600">Vehicle fitment<select value={query.fitmentStatus} onChange={(event) => updateQuery({ fitmentStatus: event.target.value })} className={control}><option value="">All parts</option><option value="present">Has recorded fitment</option><option value="missing">Fitment not recorded</option></select></label>
          <label className="text-[11px] font-bold text-slate-600">Specifications<select value={query.factStatus} onChange={(event) => updateQuery({ factStatus: event.target.value })} className={control}><option value="">All parts</option><option value="with_facts">Has specifications</option><option value="missing_facts">Specifications not recorded</option></select></label>
          <label className="text-[11px] font-bold text-slate-600">Description<select value={query.descriptionStatus} onChange={(event) => updateQuery({ descriptionStatus: event.target.value })} className={control}><option value="">All parts</option><option value="present">Has description</option><option value="missing">Description not recorded</option></select></label>
          <label className="text-[11px] font-bold text-slate-600">Sort by<select value={`${query.sort}:${query.direction}`} onChange={(event) => { const [sort, direction] = event.target.value.split(":"); updateQuery({ sort, direction }); }} className={control}><option value="part_number:asc">OEM number A–Z</option><option value="manufacturer:asc">Manufacturer A–Z</option><option value="family:asc">Family A–Z</option><option value="facts:desc">Most extracted attributes</option><option value="updated:desc">Recently updated</option>{isAudit && <><option value="occurrences:desc">Most occurrences</option><option value="confidence:desc">Highest confidence</option></>}</select></label>
          {isAudit && <><label className="text-[11px] font-bold text-slate-600">Evidence status<select value={query.onlineStatus} onChange={(event) => updateQuery({ onlineStatus: event.target.value })} className={control}><option value="">All evidence</option><option value="verified">Online verified</option><option value="queued">Queued</option></select></label><label className="text-[11px] font-bold text-slate-600">Minimum confidence<input type="number" min="0" max="1" step="0.01" value={query.minConfidence} onChange={(event) => updateQuery({ minConfidence: event.target.value })} className={control} /></label><label className="text-[11px] font-bold text-slate-600">Minimum occurrences<input type="number" min="0" value={query.minOccurrences} onChange={(event) => updateQuery({ minOccurrences: event.target.value })} className={control} /></label></>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3 text-xs"><p aria-live="polite" className="font-semibold text-slate-600">{tableLoading ? "Searching…" : `${number(catalog.total)} matching parts`}</p><div className="flex flex-wrap items-center gap-2">
          {isAudit && <button type="button" onClick={revalidateMasterData} disabled={revalidating || exporting || tableLoading} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 font-bold text-amber-800 disabled:opacity-50"><ShieldCheck size={14} />{revalidating ? "Revalidating…" : "Revalidate part numbers"}</button>}
          <button type="button" onClick={exportFiltered} disabled={exporting || revalidating || tableLoading} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-3 py-2 font-bold text-white disabled:opacity-50"><Download size={14} />{exporting ? "Preparing export…" : isAudit ? "Export filtered audit CSV" : "Export matching parts"}</button>
          <button type="button" onClick={() => setQuery(INITIAL_QUERY)} className="rounded-lg border border-slate-300 px-3 py-2 font-bold text-slate-600">Clear filters</button><SlidersHorizontal size={15} className="text-slate-400" />
          <select aria-label="Table density" value={tableDensity} onChange={(event) => setTableDensity(event.target.value)} className="rounded-lg border border-slate-300 bg-white px-2 py-2"><option value="compact">Compact</option><option value="standard">Standard</option><option value="detailed">Detailed</option></select><select aria-label="Rows per page" value={query.pageSize} onChange={(event) => updateQuery({ pageSize: Number(event.target.value) })} className="rounded-lg border border-slate-300 bg-white px-2 py-2">{[25, 50, 100, 200].map((size) => <option key={size} value={size}>{size} per page</option>)}</select>
        </div></div>
        {exportMessage && <p role="status" className="border-b border-slate-200 bg-slate-50 px-5 py-3 text-sm">{exportMessage}</p>}
        {tableError && <p role="alert" className="border-b border-red-200 bg-red-50 px-5 py-3 text-sm text-red-800">{tableError}</p>}
        <div className="relative min-w-0 overflow-x-auto" aria-busy={tableLoading}>{tableLoading && <div className="absolute inset-0 z-10 grid min-h-32 place-items-center bg-white/75"><LoaderCircle className="animate-spin text-brand-600" size={28} /></div>}<table className="w-full min-w-[1050px] table-fixed text-xs"><caption className="sr-only">Parts catalog with vehicle fitments and specifications</caption><colgroup>{[22, 12, 23, 10, 24, 9].map((width, index) => <col key={index} style={{ width: `${width}%` }} />)}</colgroup><thead className="border-b border-slate-200 bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500"><tr>{["Part identity & description", "Category / scope", "Vehicle fitment", "Side / position", "Attributes & specifications", "Details"].map((heading) => <th key={heading} scope="col" className="px-4 py-3">{heading}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{catalog.rows.map((part) => <CatalogPartRow key={part.part_key} part={part} density={tableDensity} audit={isAudit} />)}</tbody></table>
        {!catalog.rows.length && !tableLoading && !tableError && <div className="grid min-h-44 place-items-center text-center"><div><Search className="mx-auto text-slate-300" size={28} /><p className="mt-2 text-sm font-bold text-slate-600">No parts match these filters.</p><p className="mt-1 text-xs text-slate-500">Try an OEM number, vehicle model, or broader category.</p></div></div>}</div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4"><p className="text-xs text-slate-500">Page {number(catalog.page)} of {number(catalog.pages)}</p><div className="flex gap-2"><button type="button" disabled={query.page <= 1 || tableLoading} onClick={() => updateQuery({ page: query.page - 1 })} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-bold disabled:opacity-40"><ChevronLeft size={15} />Previous</button><button type="button" disabled={query.page >= catalog.pages || tableLoading} onClick={() => updateQuery({ page: query.page + 1 })} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-bold disabled:opacity-40">Next<ChevronRight size={15} /></button></div></footer>
      </>}
      </section>
    </>}
  </div>;
}
