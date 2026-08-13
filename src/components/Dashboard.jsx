import {
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Database,
  FileSearch,
  Files,
  Gauge,
  HardDrive,
  LoaderCircle,
  Play,
} from "lucide-react";
import { createElement, useCallback, useEffect, useState } from "react";
import { buildPartsLibrary } from "../utils/libraryUtils.js";
import { localDataApi } from "../utils/localDataApi.js";

const LOCAL_DASHBOARD_URL = "http://127.0.0.1:5173/partmaster/";
const ENRICHMENT_RUN_OPTIONS = [
  ["250", "Safe batch · 250 pages"],
  ["1250", "5 cycles · 1,250 pages"],
  ["5000", "Large run · 5,000 pages"],
  ["all", "Run all remaining pages"],
];

function number(value) { return Number(value || 0).toLocaleString(); }

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** index)).toFixed(index > 1 ? 2 : 1)} ${units[index]}`;
}

function MetricCard({ icon, label, value, detail, tone = "blue" }) {
  const tones = {
    blue: "bg-blue-50 text-blue-700",
    amber: "bg-amber-50 text-amber-700",
    emerald: "bg-emerald-50 text-emerald-700",
    violet: "bg-violet-50 text-violet-700",
  };

  return <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-panel"><div className="flex items-start justify-between gap-4"><div><p className="text-sm font-medium text-slate-500">{label}</p><p className="mt-2 text-3xl font-bold tracking-tight text-ink">{number(value)}</p><p className="mt-1 text-xs text-slate-400">{detail}</p></div><span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${tones[tone]}`}>{createElement(icon, { size: 21, "aria-hidden": true })}</span></div></article>;
}

function ProgressMetric({ label, value, detail, tone = "text-slate-950" }) {
  return <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-[10px] font-black uppercase tracking-wide text-slate-500">{label}</p><p className={`mt-1 text-2xl font-black ${tone}`}>{typeof value === "string" ? value : number(value)}</p><p className="mt-1 text-[11px] leading-4 text-slate-500">{detail}</p></article>;
}

function snapshotToProgress(metrics) {
  const summary = metrics.summary || {};
  const pages = metrics.source_pages || {};
  const sources = metrics.raw_sources || [];
  return {
    generated_at: metrics.generated_at,
    live: false,
    job: null,
    sources,
    summary: {
      discovered_files: sources.length,
      indexed_files: sources.filter((source) => source.import_status === "indexed").length,
      known_raw_rows: summary.raw_rows,
      indexed_raw_rows: summary.scanned_rows,
      pending_scan_rows: summary.raw_rows_remaining,
      invalid_rows: summary.invalid_rows,
      usable_rows: summary.usable_occurrences,
      raw_unique_parts: summary.unique_parts,
      master_parts: summary.unique_parts,
      remaining_master_parts: summary.master_parts_remaining,
      parts_with_facts: summary.parts_with_facts,
      remaining_fact_parts: summary.parts_missing_facts,
      source_pages: pages.source_pages,
      processed_source_pages: pages.processed_pages,
      pending_source_pages: pages.pending_pages,
    },
  };
}

function pipelineJobProgress(job) {
  if (!job) return 0;
  if (job.status === "completed" || job.phase === "completed") return 100;
  if (job.status === "queued" || job.phase === "queued") return 2;
  if (job.phase === "importing_sources") return 5;
  if (job.phase === "normalizing_and_deduplicating") {
    const scan = Number(job.total_rows) ? Number(job.scanned_rows || 0) / Number(job.total_rows) : 0;
    return Math.min(50, 5 + scan * 45);
  }
  if (job.phase === "extracting_attributes") {
    const attributes = Number(job.unique_parts) ? Number(job.attribute_processed || 0) / Number(job.unique_parts) : 0;
    return Math.min(75, 50 + attributes * 25);
  }
  if (job.phase === "checking_shared_sources") {
    const online = Number(job.online_budget) ? Number(job.online_checked || 0) / Number(job.online_budget) : 1;
    return Math.min(100, 75 + online * 25);
  }
  return 1;
}

function pipelinePhaseDetails(job) {
  const labels = {
    queued: "Waiting for the worker",
    importing_sources: "Importing source files",
    normalizing_and_deduplicating: "Normalizing and deduplicating raw rows",
    extracting_attributes: "Extracting category-specific product facts",
    checking_shared_sources: "Checking linked supplier pages",
    completed: "Pipeline completed",
    failed: "Pipeline needs attention",
  };
  const label = labels[job?.phase] || String(job?.phase || job?.status || "Starting").replaceAll("_", " ");
  if (job?.phase === "normalizing_and_deduplicating") return `${label} · ${number(job.scanned_rows)} of ${number(job.total_rows)} rows`;
  if (job?.phase === "extracting_attributes") return `${label} · ${number(job.attribute_processed)} of ${number(job.unique_parts)} parts`;
  if (job?.phase === "checking_shared_sources") return `${label} · ${number(job.online_checked)} of ${number(job.online_budget)} pages in this batch`;
  return label;
}

export default function Dashboard({ data, onNavigate }) {
  const library = buildPartsLibrary(data);
  const completed = library.length;
  const recent = library.slice(0, 5);
  const [catalogProgress, setCatalogProgress] = useState(null);
  const [actionBusy, setActionBusy] = useState("");
  const [actionNotice, setActionNotice] = useState({ type: "", message: "" });
  const [enrichmentRunSize, setEnrichmentRunSize] = useState("1250");
  const [confirmRun, setConfirmRun] = useState(null);
  const [backlogView, setBacklogView] = useState("");

  const loadLiveProgress = useCallback(async () => {
    const [sourceAudit, pipelineJobs] = await Promise.all([localDataApi.pipelineSources(), localDataApi.pipelineJobs()]);
    setCatalogProgress({ ...sourceAudit, generated_at: new Date().toISOString(), live: true, job: pipelineJobs.jobs?.[0] || null });
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadProgress() {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}data/master-metrics.json`);
        if (response.ok && !cancelled) setCatalogProgress(snapshotToProgress(await response.json()));
      } catch { /* The live local audit below can still load. */ }
      if (!["127.0.0.1", "localhost", "::1"].includes(window.location.hostname)) return;
      try { if (!cancelled) await loadLiveProgress(); }
      catch { /* Keep the published snapshot if the Mac service is unavailable. */ }
    }
    loadProgress();
    return () => { cancelled = true; };
  }, [loadLiveProgress]);

  const progress = catalogProgress?.summary || {};
  const sources = catalogProgress?.sources || [];
  const rawRows = Number(progress.known_raw_rows || 0);
  const scannedRows = Number(progress.indexed_raw_rows || 0);
  const rawRemaining = Number(progress.pending_scan_rows || 0);
  const masterRemaining = Number(progress.remaining_master_parts || 0);
  const scanPercent = rawRows ? Math.min(100, (scannedRows / rawRows) * 100) : 0;
  const totalBytes = sources.reduce((sum, source) => sum + Number(source.source_bytes || 0), 0);
  const pipelineStatus = catalogProgress?.job?.status || (rawRows && !rawRemaining ? "completed" : "snapshot");
  const activePipeline = ["queued", "running"].includes(catalogProgress?.job?.status);
  const activeJobProgress = pipelineJobProgress(catalogProgress?.job);
  const activeDatasetIds = String(catalogProgress?.job?.dataset_ids || "").split(",").filter(Boolean);
  const usableRows = Math.max(0, Number(progress.usable_rows || 0));
  const masterParts = Number(progress.master_parts || 0);
  const enrichedParts = Number(progress.parts_with_facts || 0);
  const verifiedParts = Number(progress.online_verified_parts || 0);
  const totalPages = Number(progress.source_pages || 0);
  const stages = [
    { label: "Combined CSV rows", done: scannedRows, total: rawRows, left: rawRemaining, tone: "bg-cyan-500", detail: "Rows scanned from all source files" },
    { label: "Usable rows", done: usableRows, total: scannedRows, left: Number(progress.invalid_rows || 0), tone: "bg-blue-500", detail: "Rows with usable identity" },
    { label: "Unique parts in Master", done: masterParts, total: usableRows, left: masterRemaining, tone: "bg-emerald-500", detail: "Deduplicated manufacturer + OEM identities" },
    { label: "Parts enriched", done: enrichedParts, total: masterParts, left: Number(progress.remaining_fact_parts || 0), tone: "bg-violet-500", detail: "Master parts with product facts" },
    { label: "Online verified", done: verifiedParts, total: masterParts, left: Math.max(0, masterParts - verifiedParts), tone: "bg-amber-500", detail: "Parts supported by linked evidence" },
  ];

  useEffect(() => {
    if (!catalogProgress?.live || !activePipeline) return undefined;
    const timer = window.setInterval(() => loadLiveProgress().catch(() => {}), 5000);
    return () => window.clearInterval(timer);
  }, [activePipeline, catalogProgress?.live, loadLiveProgress]);

  function selectedBudget(pagesLeft) {
    return enrichmentRunSize === "all" ? Number(pagesLeft || 0) : Math.min(Number(enrichmentRunSize), Number(pagesLeft || 0));
  }

  async function runSourceAction(source, needsProcessing, pagesLeft) {
    if (!catalogProgress?.live) return;
    setActionBusy(source.source_file); setActionNotice({ type: "", message: "" });
    try {
      const continueOnline = !needsProcessing;
      const onlineBudget = continueOnline ? selectedBudget(pagesLeft) : Math.min(250, Math.max(0, pagesLeft));
      await localDataApi.startPipeline({
        name: `${source.name || source.source_file} — ${continueOnline && onlineBudget >= pagesLeft ? "all remaining enrichment" : continueOnline ? `next ${number(onlineBudget)} enrichment pages` : "source processing"}`,
        importMissing: needsProcessing,
        continueOnline,
        onlineBudget,
        datasetIds: source.dataset_id ? [source.dataset_id] : [],
      });
      await loadLiveProgress();
      setActionNotice({ type: "success", message: `${source.source_file}: ${continueOnline ? `${number(onlineBudget)}-page enrichment run` : "source processing"} started. Progress will refresh here automatically.` });
    } catch (error) {
      setActionNotice({ type: "error", message: error.message });
    } finally { setActionBusy(""); }
  }

  async function runAllSourcesEnrichment() {
    if (!catalogProgress?.live) return;
    const pagesLeft = Number(progress.pending_source_pages || 0);
    const onlineBudget = selectedBudget(pagesLeft);
    setActionBusy("__all__"); setActionNotice({ type: "", message: "" });
    try {
      await localDataApi.startPipeline({
        name: onlineBudget >= pagesLeft ? "All sources — complete remaining enrichment" : `All sources — next ${number(onlineBudget)} enrichment pages`,
        importMissing: false,
        continueOnline: true,
        onlineBudget,
        datasetIds: [],
      });
      await loadLiveProgress();
      setActionNotice({ type: "success", message: `All sources: ${number(onlineBudget)}-page enrichment run started. It will continue without more clicks and can be paused or resumed from Enrichment.` });
    } catch (error) {
      setActionNotice({ type: "error", message: error.message });
    } finally { setActionBusy(""); }
  }

  function requestSourceAction(source, needsProcessing, pagesLeft) {
    const budget = selectedBudget(pagesLeft);
    if (!needsProcessing && enrichmentRunSize === "all" && budget > 5000) {
      setConfirmRun({ kind: "source", source, needsProcessing, pagesLeft, budget });
      return;
    }
    runSourceAction(source, needsProcessing, pagesLeft);
  }

  function requestAllSourcesEnrichment() {
    const budget = selectedBudget(progress.pending_source_pages);
    if (enrichmentRunSize === "all" && budget > 5000) {
      setConfirmRun({ kind: "all", budget });
      return;
    }
    runAllSourcesEnrichment();
  }

  async function confirmLongRun() {
    const pending = confirmRun;
    setConfirmRun(null);
    if (pending?.kind === "source") await runSourceAction(pending.source, pending.needsProcessing, pending.pagesLeft);
    else if (pending?.kind === "all") await runAllSourcesEnrichment();
  }

  return <div className="space-y-6">
    <section className="overflow-hidden rounded-3xl bg-gradient-to-br from-slate-950 via-blue-950 to-emerald-950 text-white shadow-panel"><div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[1.35fr_0.65fr] lg:items-center"><div><div className="flex flex-wrap items-center gap-2"><p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-300">Raw data processing status</p><span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ${catalogProgress?.live ? "bg-emerald-400 text-emerald-950" : "bg-white/10 text-slate-300"}`}>{catalogProgress?.live ? "Live from this Mac" : "Published snapshot"}</span></div><h3 className="mt-3 text-2xl font-black tracking-tight sm:text-3xl">{catalogProgress ? `${number(scannedRows)} of ${number(rawRows)} raw rows scanned` : "Loading catalog progress…"}</h3><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">This measures CSV consolidation. Parts that still need product facts or online checks are already in Master—they are enrichment work, not unprocessed raw rows.</p><div className="mt-6 h-3 overflow-hidden rounded-full bg-white/15" aria-label={`${Math.round(scanPercent)}% of raw rows scanned`}><div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-all" style={{ width: `${scanPercent}%` }} /></div><div className="mt-3 flex flex-wrap justify-between gap-2 text-xs font-bold text-slate-300"><span>{scanPercent.toFixed(1)}% scanned</span><span>{number(rawRemaining)} raw rows remaining</span></div></div><div className="grid grid-cols-2 gap-3"><button type="button" onClick={() => onNavigate("master")} className="rounded-xl bg-white px-4 py-4 text-left text-sm font-semibold text-slate-900 hover:bg-cyan-50"><Database className="mb-3 text-emerald-600" size={21} />Open Master Data<ArrowRight className="mt-3" size={17} /></button><button type="button" onClick={() => onNavigate("enrichment")} className="rounded-xl border border-white/20 bg-white/10 px-4 py-4 text-left text-sm font-semibold text-white hover:bg-white/15"><Gauge className="mb-3 text-cyan-300" size={21} />Open Enrichment<ArrowRight className="mt-3" size={17} /></button></div></div></section>

    {!catalogProgress ? <div className="grid min-h-40 place-items-center rounded-3xl border border-slate-200 bg-white"><LoaderCircle className="animate-spin text-brand-600" size={28} /></div> : <>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8" aria-label="Raw data and master progress metrics"><ProgressMetric label="CSV files" value={progress.discovered_files} detail={`${number(progress.indexed_files)} fully scanned`} /><ProgressMetric label="Source size" value={formatBytes(totalBytes)} detail="Combined raw CSV size" /><ProgressMetric label="Raw rows" value={rawRows} detail={`${number(scannedRows)} scanned`} /><ProgressMetric label="Rows remaining" value={rawRemaining} detail="Still waiting for scan" tone={rawRemaining ? "text-amber-700" : "text-emerald-700"} /><ProgressMetric label="Unique Master parts" value={progress.master_parts} detail={`${number(masterRemaining)} known parts missing`} tone="text-blue-700" /><ProgressMetric label="Need product facts" value={progress.remaining_fact_parts} detail="Already in Master" tone="text-violet-700" /><ProgressMetric label="Pages checked" value={progress.processed_source_pages} detail={`${number(progress.source_pages)} linked pages total`} tone="text-cyan-700" /><ProgressMetric label="Pages remaining" value={progress.pending_source_pages} detail="Controlled online checks" tone="text-amber-700" /></section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-panel sm:p-7" aria-label="Master data completion funnel"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-[0.16em] text-brand-700">End-to-end completion funnel</p><h3 className="mt-1 text-2xl font-black text-slate-950">Where every combined CSV row stands</h3><p className="mt-1 text-sm text-slate-500">Counts are separated by unit: raw rows, unique parts, enriched parts, and verified parts.</p></div><span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-600">{number(totalPages)} linked pages in scope</span></div><div className="mt-6 grid gap-3 lg:grid-cols-5">{stages.map((stage) => { const percent = stage.total ? Math.min(100, (stage.done / stage.total) * 100) : 0; return <article key={stage.label} className="rounded-2xl border border-slate-200 bg-slate-50 p-4"><div className="flex items-start justify-between gap-2"><p className="text-xs font-black uppercase tracking-wide text-slate-500">{stage.label}</p><span className="text-sm font-black text-slate-900">{percent.toFixed(1)}%</span></div><p className="mt-3 text-2xl font-black tabular-nums text-slate-950">{number(stage.done)}</p><p className="mt-1 text-[11px] leading-4 text-slate-500">{stage.detail}</p><div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-200"><div className={`h-full rounded-full ${stage.tone}`} style={{ width: `${percent}%` }} /></div><p className="mt-2 text-xs font-bold text-amber-700">{number(stage.left)} left</p></article>; })}</div><div className="mt-5 grid gap-3 sm:grid-cols-3"><button type="button" onClick={() => setBacklogView("repair")} className={`rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-left transition hover:-translate-y-0.5 hover:shadow-md ${backlogView === "repair" ? "ring-2 ring-amber-400" : ""}`}><p className="text-[10px] font-black uppercase tracking-wide text-amber-700">Held out for repair</p><p className="mt-1 text-xl font-black text-amber-950">{number(progress.invalid_rows)}</p><p className="mt-1 text-xs text-amber-800">Rows without usable identity · View action table →</p></button><button type="button" onClick={() => setBacklogView("facts")} className={`rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-left transition hover:-translate-y-0.5 hover:shadow-md ${backlogView === "facts" ? "ring-2 ring-violet-400" : ""}`}><p className="text-[10px] font-black uppercase tracking-wide text-violet-700">Enrichment backlog</p><p className="mt-1 text-xl font-black text-violet-950">{number(progress.remaining_fact_parts)}</p><p className="mt-1 text-xs text-violet-800">Master parts still needing facts · View action table →</p></button><button type="button" onClick={() => setBacklogView("evidence")} className={`rounded-xl border border-cyan-200 bg-cyan-50 px-4 py-3 text-left transition hover:-translate-y-0.5 hover:shadow-md ${backlogView === "evidence" ? "ring-2 ring-cyan-400" : ""}`}><p className="text-[10px] font-black uppercase tracking-wide text-cyan-700">Evidence backlog</p><p className="mt-1 text-xl font-black text-cyan-950">{number(progress.pending_source_pages)}</p><p className="mt-1 text-xs text-cyan-800">Supplier pages still to check · View action table →</p></button></div>
      {backlogView && <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200"><header className="flex flex-wrap items-center justify-between gap-3 bg-slate-950 px-4 py-4 text-white"><div><p className="text-xs font-black uppercase tracking-widest text-cyan-300">Action table</p><h4 className="mt-1 text-lg font-black">{backlogView === "repair" ? "Rows held out for repair" : backlogView === "facts" ? "Parts still needing product facts" : "Supplier evidence still to check"}</h4></div><button type="button" onClick={() => setBacklogView("")} className="rounded-lg border border-white/20 px-3 py-1.5 text-xs font-bold text-slate-300">Close</button></header><div className="overflow-x-auto"><table className="min-w-full text-xs"><thead className="border-b border-slate-200 bg-slate-50 text-left uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Source CSV</th><th className="px-4 py-3">Rows / parts</th><th className="px-4 py-3">Remaining</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Action</th></tr></thead><tbody className="divide-y divide-slate-100">{sources.map((source) => { const indexed = source.import_status === "indexed" || source.is_indexed === true; const value = backlogView === "repair" ? Number(source.invalid_rows || 0) : backlogView === "facts" ? Number(source.remaining_fact_parts || 0) : Number(source.pending_source_pages || 0); const total = backlogView === "repair" ? Number(source.raw_rows || 0) : backlogView === "facts" ? Number(source.master_parts || 0) : Number(source.source_pages || 0); return <tr key={source.source_file} className="hover:bg-slate-50"><td className="max-w-72 px-4 py-3 font-bold"><span className="break-all">{source.source_file}</span></td><td className="px-4 py-3">{number(total)}</td><td className="px-4 py-3 font-black text-amber-700">{number(value)}</td><td className="px-4 py-3"><span className={`rounded-full px-2 py-1 font-bold ${!indexed ? "bg-amber-100 text-amber-800" : value ? "bg-violet-100 text-violet-800" : "bg-emerald-100 text-emerald-800"}`}>{!indexed ? "Needs processing" : value ? "Action needed" : "Complete"}</span></td><td className="px-4 py-3">{backlogView === "repair" ? <button type="button" onClick={() => onNavigate("review")} className="rounded-lg bg-brand-600 px-3 py-1.5 font-bold text-white">Open repair queue</button> : backlogView === "facts" ? <button type="button" onClick={() => onNavigate("enrichment")} className="rounded-lg bg-violet-600 px-3 py-1.5 font-bold text-white">Enrich parts</button> : <button type="button" disabled={!catalogProgress.live || activePipeline || !value} onClick={() => requestSourceAction(source, false, value)} className="rounded-lg bg-cyan-600 px-3 py-1.5 font-bold text-white disabled:opacity-40">Check pages</button>}</td></tr>; })}</tbody></table></div></div>}
      </section>

      {activePipeline && <section className="relative overflow-hidden rounded-3xl border border-cyan-300 bg-slate-950 p-5 text-white shadow-xl sm:p-6" aria-live="polite"><div className="absolute -right-12 -top-12 h-40 w-40 animate-pulse rounded-full bg-cyan-400/20 blur-2xl" /><div className="relative flex flex-wrap items-start justify-between gap-4"><div className="flex items-start gap-3"><span className="relative mt-1 flex h-4 w-4"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" /><span className="relative inline-flex h-4 w-4 rounded-full bg-emerald-400" /></span><div><p className="text-xs font-black uppercase tracking-[0.16em] text-cyan-300">Background enrichment is running</p><h3 className="mt-1 text-xl font-black">{catalogProgress.job.name}</h3><p className="mt-1 text-sm text-slate-300">{pipelinePhaseDetails(catalogProgress.job)}</p></div></div><div className="text-right"><p className="text-3xl font-black text-cyan-300">{Math.round(activeJobProgress)}%</p><button type="button" onClick={() => onNavigate("enrichment")} className="mt-1 text-xs font-bold text-slate-300 underline decoration-white/30 underline-offset-4 hover:text-white">Open full job controls</button></div></div><div className="relative mt-5 h-4 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-violet-500 via-cyan-400 to-emerald-400 transition-all duration-700" style={{ width: `${activeJobProgress}%` }}><div className="h-full w-full animate-pulse bg-white/20" /></div></div><div className="relative mt-2 flex flex-wrap justify-between gap-2 text-[11px] font-bold text-slate-400"><span>{catalogProgress.job.current_dataset ? `Working on ${catalogProgress.job.current_dataset}` : "Preparing the next safe checkpoint"}</span><span>Refreshes every 5 seconds</span></div></section>}

      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-panel"><header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-4 sm:px-6"><div className="max-w-2xl"><p className="flex items-center gap-2 text-xs font-black uppercase tracking-wide text-brand-700"><Files size={16} />Progress by raw CSV</p><h3 className="mt-1 text-lg font-black">Completed and remaining work for every source</h3><p className="mt-1 text-xs leading-5 text-slate-500">Choose a run size once, then start one CSV or every source. The persistent background job continues without repeated clicking and can be paused or resumed.</p></div><div className="grid min-w-64 gap-2"><div className="flex items-center justify-between gap-2"><span className={`rounded-full px-3 py-1.5 text-xs font-black ${pipelineStatus === "completed" ? "bg-emerald-100 text-emerald-800" : pipelineStatus === "running" ? "bg-blue-100 text-blue-800" : "bg-slate-200 text-slate-700"}`}>Pipeline {pipelineStatus.replaceAll("_", " ")}</span><span className="text-[10px] font-black uppercase text-slate-500">Persistent job</span></div><label className="text-[10px] font-black uppercase tracking-wide text-slate-500">Enrichment run size<select value={enrichmentRunSize} onChange={(event) => setEnrichmentRunSize(event.target.value)} disabled={activePipeline} className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold normal-case tracking-normal text-slate-800 disabled:opacity-50">{ENRICHMENT_RUN_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{catalogProgress.live ? <button type="button" onClick={requestAllSourcesEnrichment} disabled={activePipeline || Boolean(actionBusy) || !Number(progress.pending_source_pages)} className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-black text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">{actionBusy === "__all__" ? <LoaderCircle className="animate-spin" size={15} /> : <Play size={15} />}{activePipeline ? "Background job running" : enrichmentRunSize === "all" ? "Enrich all remaining" : `Run ${number(Math.min(Number(enrichmentRunSize), Number(progress.pending_source_pages || 0)))} pages across all CSVs`}</button> : <a href={LOCAL_DASHBOARD_URL} className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-black text-white"><HardDrive size={15} />Open local to run enrichment</a>}</div></header>{actionNotice.message && <div className={`border-b px-5 py-3 text-sm font-bold ${actionNotice.type === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`} role={actionNotice.type === "error" ? "alert" : "status"}>{actionNotice.message}</div>}<div className="overflow-x-auto"><table className="min-w-full text-xs"><thead className="border-b border-slate-200 text-left uppercase tracking-wide text-slate-500"><tr className="bg-white"><th rowSpan="2" className="whitespace-nowrap border-r border-slate-200 px-3 py-3">CSV source</th><th rowSpan="2" className="whitespace-nowrap px-3 py-3">Size</th><th rowSpan="2" className="whitespace-nowrap px-3 py-3">Raw rows</th><th rowSpan="2" className="whitespace-nowrap border-r border-slate-200 px-3 py-3">Unique raw parts</th><th colSpan="2" className="border-r border-slate-200 bg-blue-50 px-3 py-2 text-center text-blue-700">Raw scan</th><th colSpan="2" className="border-r border-slate-200 bg-emerald-50 px-3 py-2 text-center text-emerald-700">Master identities</th><th colSpan="2" className="border-r border-slate-200 bg-violet-50 px-3 py-2 text-center text-violet-700">Product facts</th><th colSpan="2" className="border-r border-slate-200 bg-cyan-50 px-3 py-2 text-center text-cyan-700">Online pages</th><th rowSpan="2" className="whitespace-nowrap px-3 py-3">Status</th><th rowSpan="2" className="whitespace-nowrap px-3 py-3">Action</th></tr><tr className="border-t border-slate-200 bg-slate-50">{["Completed", "Remaining", "Completed", "Remaining", "Completed", "Remaining", "Completed", "Remaining"].map((heading, index) => <th key={`${heading}-${index}`} className={`whitespace-nowrap px-3 py-2 text-center ${index % 2 === 1 ? "border-r border-slate-200" : ""}`}>{heading}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{sources.map((source) => {
        const indexed = source.import_status === "indexed" || source.is_indexed === true;
        const rawCompleted = indexed ? Number(source.raw_rows || 0) : 0;
        const rawLeft = Math.max(0, Number(source.raw_rows || 0) - rawCompleted);
        const masterCompleted = Number(source.master_parts || 0);
        const masterLeft = Number(source.remaining_master_parts || 0);
        const factsCompleted = Number(source.parts_with_facts || 0);
        const factsLeft = Number(source.remaining_fact_parts || 0);
        const pagesCompleted = Number(source.processed_source_pages || 0);
        const pagesLeft = Number(source.pending_source_pages || 0);
        const fullyComplete = indexed && !masterLeft && !factsLeft && !pagesLeft;
        const masterComplete = indexed && !masterLeft;
        const statusLabel = !indexed ? "Needs processing" : fullyComplete ? "Fully complete" : masterComplete ? "Master complete · enrichment open" : "Master incomplete";
        const statusClass = !indexed || masterLeft ? "bg-amber-100 text-amber-800" : fullyComplete ? "bg-emerald-100 text-emerald-800" : "bg-violet-100 text-violet-800";
        const needsProcessing = !indexed || Boolean(rawLeft || masterLeft);
        const hasRemainingEnrichment = Boolean(factsLeft || pagesLeft);
        const isBusy = actionBusy === source.source_file;
        const sourceIsActive = activePipeline && activeDatasetIds.includes(String(source.dataset_id || ""));
        return <tr key={source.source_file} className={sourceIsActive ? "bg-cyan-50/70 ring-1 ring-inset ring-cyan-200" : "hover:bg-slate-50"}><td className="max-w-64 border-r border-slate-100 px-3 py-3 font-bold text-slate-800"><span className="break-all">{source.source_file}</span>{sourceIsActive && <span className="mt-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wide text-cyan-700"><span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-500 opacity-70" /><span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-600" /></span>Active source</span>}</td><td className="whitespace-nowrap px-3 py-3">{formatBytes(source.source_bytes)}</td><td className="px-3 py-3 font-semibold">{number(source.raw_rows)}</td><td className="border-r border-slate-100 px-3 py-3">{number(source.unique_parts)}</td><td className="px-3 py-3 text-center font-black text-blue-700">{number(rawCompleted)}</td><td className="border-r border-slate-100 px-3 py-3 text-center font-black text-amber-700">{number(rawLeft)}</td><td className="px-3 py-3 text-center font-black text-emerald-700">{number(masterCompleted)}</td><td className="border-r border-slate-100 px-3 py-3 text-center font-black text-amber-700">{number(masterLeft)}</td><td className="px-3 py-3 text-center font-black text-violet-700">{number(factsCompleted)}</td><td className="border-r border-slate-100 px-3 py-3 text-center font-black text-amber-700">{number(factsLeft)}</td><td className="px-3 py-3 text-center font-black text-cyan-700">{number(pagesCompleted)}</td><td className="border-r border-slate-100 px-3 py-3 text-center font-black text-amber-700">{number(pagesLeft)}</td><td className="px-3 py-3"><span className={`inline-block min-w-32 rounded-xl px-2.5 py-1.5 text-center font-black leading-4 ${sourceIsActive ? "bg-cyan-100 text-cyan-800" : statusClass}`}>{sourceIsActive ? "Enrichment running" : statusLabel}</span></td><td className="min-w-48 px-3 py-3">{sourceIsActive ? <div><div className="flex items-center justify-between gap-2 text-[10px] font-black text-cyan-800"><span>{pipelinePhaseDetails(catalogProgress.job).split(" · ")[0]}</span><span>{Math.round(activeJobProgress)}%</span></div><div className="mt-2 h-2.5 overflow-hidden rounded-full bg-cyan-100"><div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-500 transition-all duration-700" style={{ width: `${activeJobProgress}%` }}><div className="h-full w-full animate-pulse bg-white/25" /></div></div><p className="mt-1 text-[10px] font-semibold text-slate-500">{catalogProgress.job.phase === "checking_shared_sources" ? `${number(catalogProgress.job.online_checked)} / ${number(catalogProgress.job.online_budget)} pages` : "Working in the background"}</p></div> : catalogProgress.live ? <button type="button" disabled={activePipeline || Boolean(actionBusy) || (!needsProcessing && !hasRemainingEnrichment)} onClick={() => requestSourceAction(source, needsProcessing, pagesLeft)} title={activePipeline ? "Finish or pause the active pipeline job first." : needsProcessing ? "Scan this source and consolidate its known identities into Master." : "Use the selected run size to refresh facts and check linked supplier pages for this source."} className="inline-flex min-w-32 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-brand-600 px-3 py-2 font-black text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">{isBusy ? <LoaderCircle className="animate-spin" size={14} /> : <Play size={14} />}{activePipeline ? "Worker busy" : needsProcessing ? "Process CSV" : hasRemainingEnrichment ? enrichmentRunSize === "all" ? "Enrich all remaining" : `Enrich ${number(Math.min(Number(enrichmentRunSize), pagesLeft))}` : "Complete"}</button> : <a href={LOCAL_DASHBOARD_URL} title="Open the local Mac application to run this background action." className="inline-flex min-w-32 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-slate-900 px-3 py-2 font-black text-white hover:bg-slate-700"><HardDrive size={14} />Open local</a>}</td></tr>;
      })}</tbody></table>{!sources.length && <div className="px-6 py-10 text-center text-sm text-slate-500">Per-CSV metrics will appear after the source inventory is published or the local service is connected.</div>}</div></section>
    </>}

    <section><div className="mb-3"><p className="text-xs font-black uppercase tracking-wide text-slate-500">Team review workspace</p><p className="mt-1 text-sm text-slate-500">These lightweight GitHub queue counts are separate from the large local catalog.</p></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Team workflow metrics"><MetricCard icon={CheckCircle2} label="Parts processed" value={completed} detail="Finalized library records" tone="emerald" /><MetricCard icon={ClipboardList} label="Awaiting review" value={data.queue.length} detail="Enriched parts requiring approval" tone="amber" /><MetricCard icon={Gauge} label="Waiting to process" value={data.input.length} detail="Raw enrichment requests" tone="violet" /><MetricCard icon={Database} label="Completed batches" value={data.analyses.length} detail={`${data.approved.length} individual approvals`} /></div></section>

    <section className="rounded-2xl border border-slate-200 bg-white shadow-panel"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 sm:px-6"><div><h3 className="font-semibold text-ink">Recently completed</h3><p className="mt-1 text-sm text-slate-500">Latest parts added to your team library</p></div><button type="button" onClick={() => onNavigate("library")} className="inline-flex items-center gap-2 text-sm font-semibold text-brand-700 hover:text-brand-800">View full library <ArrowRight size={16} /></button></div>{recent.length ? <div className="divide-y divide-slate-100">{recent.map((part) => <div key={part.id} className="grid gap-2 px-5 py-4 sm:grid-cols-[1fr_0.8fr_auto] sm:items-center sm:px-6"><div><p className="font-medium text-ink">{part.description}</p><p className="mt-1 text-xs text-slate-500">{part.source_name}</p></div><p className="font-mono text-sm text-slate-700">{part.oem_part_number || "No OEM number"}</p><span className="text-xs text-slate-400">{part.completed_at ? new Date(part.completed_at).toLocaleDateString() : "—"}</span></div>)}</div> : <div className="px-6 py-12 text-center"><HardDrive className="mx-auto text-slate-300" size={34} /><p className="mt-3 text-sm font-medium text-slate-600">No team-library records yet</p><p className="mt-1 text-sm text-slate-400">The large local Master catalog is tracked above and remains available separately.</p><button type="button" onClick={() => onNavigate("analyze")} className="mt-4 inline-flex items-center gap-2 rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700"><FileSearch size={16} />Analyze a part</button></div>}</section>

    {confirmRun && <div className="fixed inset-0 z-[80] grid place-items-center bg-slate-950/70 p-4 backdrop-blur-sm" role="alertdialog" aria-modal="true"><div className="w-full max-w-xl overflow-hidden rounded-3xl border border-amber-300 bg-white shadow-2xl"><div className="bg-amber-50 px-6 py-6 text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-amber-500 text-slate-950"><Gauge size={27} /></span><h3 className="mt-4 text-xl font-black text-amber-950">Run {number(confirmRun.budget)} online page checks?</h3><p className="mt-2 text-sm leading-6 text-amber-900">This is a persistent long-running job for {confirmRun.kind === "all" ? "all CSV sources" : confirmRun.source?.source_file}. It may take many hours or days, use substantial bandwidth and encounter supplier rate limits.</p><p className="mt-3 rounded-xl border border-amber-200 bg-white px-4 py-3 text-xs font-bold leading-5 text-amber-800">Keep the local data service running when possible. Progress is saved in the local Mac database, and the job can be paused or resumed from Enrichment.</p></div><div className="flex flex-wrap justify-center gap-3 px-6 py-5"><button type="button" onClick={() => setConfirmRun(null)} className="rounded-xl border border-slate-300 px-5 py-2.5 text-sm font-bold text-slate-700">Cancel</button><button type="button" onClick={confirmLongRun} className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-black text-slate-950 hover:bg-amber-400"><Play size={17} />Start the full run</button></div></div></div>}
  </div>;
}
