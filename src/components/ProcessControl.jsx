import { CirclePause, Clock3, LoaderCircle, Play, RefreshCw, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { localDataApi } from "../utils/localDataApi.js";
import LocalWorkspaceUnavailable from "./LocalWorkspaceUnavailable.jsx";

const ACTIVE = ["queued", "running", "processing"];
const typeConfig = {
  pipeline: { label: "Full pipeline", color: "indigo", pause: localDataApi.pausePipeline, resume: localDataApi.resumePipeline },
  enrichment: { label: "Enrichment", color: "violet", pause: localDataApi.pauseEnrichment, resume: localDataApi.resumeEnrichment },
  autopilot: { label: "Intelligence Autopilot", color: "cyan", pause: localDataApi.pauseAutopilot, resume: localDataApi.resumeAutopilot },
};
const toneClasses = { indigo: ["bg-indigo-50", "text-indigo-700", "bg-indigo-500"], violet: ["bg-violet-50", "text-violet-700", "bg-violet-500"], cyan: ["bg-cyan-50", "text-cyan-700", "bg-cyan-500"] };

function progress(type, job) {
  if (!job) return 0;
  if (job.status === "completed") return 100;
  if (type === "pipeline") {
    if (job.phase === "checking_shared_sources") return 90 + (Number(job.online_checked || 0) / Math.max(1, Number(job.online_budget || 1))) * 10;
    if (job.phase === "extracting_attributes") return 60 + (Number(job.attribute_processed || 0) / Math.max(1, Number(job.unique_parts || 1))) * 30;
    return job.phase === "normalizing_and_deduplicating" ? 5 + (Number(job.scanned_rows || 0) / Math.max(1, Number(job.total_rows || 1))) * 55 : 3;
  }
  return Number(job.queued_count) ? (Number(job.processed_count || job.completed_count || 0) / Number(job.queued_count)) * 100 : 0;
}

function actionLabel(type, job, isActive) {
  if (!isActive) return job.status === "completed" ? "Finished successfully" : job.status === "paused" ? "Paused at a safe checkpoint" : job.status === "failed" ? "Needs attention" : "Ready";
  if (type === "pipeline") return { importing_sources: "Importing source files", normalizing_and_deduplicating: "Normalizing and removing duplicates", extracting_attributes: "Extracting product facts", checking_shared_sources: "Checking shared supplier sources", queued: "Waiting for worker" }[job.phase] || "Processing the local catalog";
  if (type === "enrichment") return job.status === "queued" ? "Queued for enrichment" : "Reading evidence and enriching parts";
  return job.status === "queued" ? "Queued for intelligence checks" : "Checking part quality and evidence";
}

function activityHints(type, job) {
  if (type === "pipeline") return { importing_sources: ["Opening source files", "Reading catalog rows", "Preparing records"], normalizing_and_deduplicating: ["Cleaning identifiers", "Comparing duplicates", "Building the master index"], extracting_attributes: ["Classifying parts", "Extracting product facts", "Checking category clues"], checking_shared_sources: ["Opening supplier pages", "Matching evidence", "Saving verified findings"] }[job.phase] || ["Starting worker", "Preparing next batch", "Processing locally"];
  if (type === "enrichment") return ["Reading source evidence", "Comparing part details", "Scoring confidence"];
  return ["Finding priority parts", "Checking quality signals", "Updating intelligence"];
}

function detailStats(type, job) {
  if (type === "pipeline") return [["Rows scanned", job.scanned_rows], ["Parts found", job.unique_parts], ["Pages checked", job.online_checked]];
  if (type === "enrichment") return [["Verified", job.enriched_count], ["Review queue", Number(job.review_count || 0) + Number(job.conflict_count || 0)], ["Not found", job.not_found_count]];
  return [["Verified", job.verified_count], ["Review queue", job.review_count], ["Failed", job.failed_count]];
}

function currentWork(type, job, fallbackProcessed, fallbackTotal) {
  if (type === "pipeline" && job.phase === "checking_shared_sources") {
    return { label: "supplier pages checked", processed: Number(job.online_checked || 0), total: Number(job.online_budget || 0) };
  }
  if (type === "pipeline" && job.phase === "extracting_attributes") {
    return { label: "parts analyzed", processed: Number(job.attribute_processed || 0), total: Number(job.unique_parts || 0) };
  }
  if (type === "pipeline" && job.phase === "normalizing_and_deduplicating") {
    return { label: "rows scanned", processed: Number(job.scanned_rows || 0), total: Number(job.total_rows || 0) };
  }
  return { label: "items processed", processed: fallbackProcessed, total: fallbackTotal };
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "Calculating…";
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "Under 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) return `${hours}h ${remainder ? `${remainder}m` : ""}`.trim();
  return `${Math.floor(hours / 24)}d ${hours % 24 ? `${hours % 24}h` : ""}`.trim();
}

function JobCard({ item, onControl, busy }) {
  const { type, job } = item;
  const config = typeConfig[type];
  const [iconBg, iconText, barBg] = toneClasses[config.color];
  const percent = Math.min(100, Math.max(0, progress(type, job)));
  const isActive = ACTIVE.includes(job.status);
  const isResumable = ["paused", "failed"].includes(job.status);
  const processed = Number(job.processed_count || job.completed_count || job.scanned_rows || 0);
  const total = Number(job.queued_count || job.total_rows || job.requested_parts || 0);
  const work = currentWork(type, job, processed, total);
  const previousTarget = useRef(work.processed);
  const [animatedProcessed, setAnimatedProcessed] = useState(work.processed);
  useEffect(() => {
    const from = previousTarget.current; const to = work.processed; previousTarget.current = to;
    if (from === to) return undefined;
    const started = performance.now(); const duration = 850;
    let frame;
    const tick = (now) => { const ratio = Math.min(1, (now - started) / duration); const eased = 1 - ((1 - ratio) ** 3); setAnimatedProcessed(Math.round(from + ((to - from) * eased))); if (ratio < 1) frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [work.processed]);
  const stats = detailStats(type, job).filter(([, value]) => value != null);
  const hints = activityHints(type, job);
  const [activityIndex, setActivityIndex] = useState(0);
  const rateSample = useRef({ processed: work.processed, at: performance.now(), phase: job.phase });
  const [throughput, setThroughput] = useState(0);
  const [eta, setEta] = useState(null);
  useEffect(() => {
    const now = performance.now(); const sample = rateSample.current;
    if (sample.phase !== job.phase || work.processed < sample.processed) { rateSample.current = { processed: work.processed, at: now, phase: job.phase }; setThroughput(0); setEta(null); return; }
    const elapsed = (now - sample.at) / 1000; const delta = work.processed - sample.processed;
    if (delta > 0 && elapsed >= 0.25) {
      const rate = delta / elapsed; const remaining = Math.max(0, work.total - work.processed);
      rateSample.current = { processed: work.processed, at: now, phase: job.phase }; setThroughput(rate); setEta(rate ? remaining / rate : null);
    }
  }, [job.phase, work.processed, work.total]);
  useEffect(() => { if (!isActive) return undefined; const timer = window.setInterval(() => setActivityIndex((index) => (index + 1) % hints.length), 1800); return () => window.clearInterval(timer); }, [isActive, hints.length]);
  return <article className={`process-card rounded-2xl border border-slate-200 bg-white p-5 shadow-panel ${isActive ? "process-card-active" : ""}`}>
    <div className="flex items-start justify-between gap-4"><div className="flex min-w-0 items-start gap-3"><span className={`process-icon grid h-10 w-10 shrink-0 place-items-center rounded-xl ${iconBg} ${iconText}`}><Workflow size={20} /></span><div className="min-w-0"><p className="text-xs font-black uppercase tracking-wide text-slate-500">{config.label}</p><h3 className="mt-1 truncate font-bold text-slate-900">{job.name || "Unnamed process"}</h3><p className="mt-1 text-xs text-slate-500">Started {job.started_at ? new Date(job.started_at).toLocaleString() : "Not started"}</p></div></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${isActive ? "process-live-badge bg-blue-50 text-blue-700" : job.status === "completed" ? "bg-emerald-50 text-emerald-700" : job.status === "failed" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>{isActive && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-current align-middle" />}{job.status?.replaceAll("_", " ")}</span></div>
    <div className="mt-5"><div className="flex justify-between text-xs font-semibold text-slate-500"><span className={isActive ? "text-brand-700" : ""}>{actionLabel(type, job, isActive)}</span><span>{Math.round(percent)}%</span></div><div className="process-progress mt-2 h-2 overflow-hidden rounded-full bg-slate-100"><div className={`process-progress-fill h-full rounded-full ${barBg} transition-all`} style={{ width: `${percent}%` }} /></div><div className="mt-3 flex flex-wrap items-baseline justify-between gap-3"><p className="text-lg font-black tabular-nums text-slate-900">{work.total ? `${animatedProcessed.toLocaleString()} / ${work.total.toLocaleString()}` : "—"}</p><p className="text-xs font-semibold text-slate-500">{work.label}</p></div><div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-bold"><span className="text-amber-700">{work.total > work.processed ? `${(work.total - work.processed).toLocaleString()} remaining` : "Phase complete"}</span>{isActive && <><span className="text-slate-400">{throughput ? `${throughput.toFixed(1)} ${work.label}/sec` : "Measuring speed…"}</span><span className="text-brand-700">ETA: {eta ? formatDuration(eta) : "Calculating…"}</span></>}</div>{isActive && <p className="process-activity mt-3 flex items-center gap-2 text-xs font-bold text-brand-700"><span className="process-activity-dots inline-flex gap-0.5"><i /><i /><i /></span><span key={activityIndex}>{hints[activityIndex]}</span><span className="text-slate-400">· working continuously</span></p>}</div>
    {stats.length > 0 && <div className="mt-4 grid grid-cols-3 gap-2">{stats.map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 px-3 py-2"><p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 text-sm font-black tabular-nums text-slate-900">{Number(value || 0).toLocaleString()}</p></div>)}</div>}
    <div className="mt-5 flex justify-end">{isActive ? <button type="button" disabled={busy} onClick={() => onControl(type, "pause", job.id)} className="inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-800 disabled:opacity-50"><CirclePause size={16} />Pause safely</button> : isResumable ? <button type="button" disabled={busy} onClick={() => onControl(type, "resume", job.id)} className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-3 py-2 text-sm font-bold text-white disabled:opacity-50"><Play size={16} />Resume</button> : null}</div>
  </article>;
}

export default function ProcessControl({ mode = "monitor", onModeChange }) {
  const [items, setItems] = useState([]); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [available, setAvailable] = useState(true); const [logs, setLogs] = useState([]);
  const load = useCallback(async () => {
    try { const [pipeline, enrichment, autopilot] = await Promise.all([localDataApi.pipelineJobs(), localDataApi.enrichmentJobs(), localDataApi.autopilotJobs()]); const nextItems = [...(pipeline.jobs || []).map((job) => ({ type: "pipeline", job })), ...(enrichment.jobs || []).map((job) => ({ type: "enrichment", job })), ...(autopilot.jobs || []).map((job) => ({ type: "autopilot", job }))].sort((a, b) => String(b.job.created_at).localeCompare(String(a.job.created_at))); setItems(nextItems); setAvailable(true); setError(""); }
    catch (requestError) { setAvailable(false); setError(requestError.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let active = true;
    const readNetworkLog = async () => { try { const result = await localDataApi.networkLog(); if (active && result.events?.length) setLogs(result.events.map((event, index) => ({ id: `network-${index}-${event.at}`, at: new Date(event.at).toLocaleTimeString(), message: event.kind === "request" ? `FETCH ${event.host} · ${event.ip} · request started` : event.kind === "response" ? `RESPONSE ${event.host} · HTTP ${event.status} · ${event.ms}ms · ${Number(event.bytes || 0).toLocaleString()} bytes` : `ERROR ${event.host} · ${event.message}`, level: event.kind === "error" ? "error" : event.kind === "response" ? "success" : "network" }))); } catch { /* Worker may be unavailable. */ } };
    readNetworkLog(); const timer = window.setInterval(readNetworkLog, 4000); return () => { active = false; window.clearInterval(timer); };
  }, []);
  const active = useMemo(() => items.filter(({ job }) => ACTIVE.includes(job.status)), [items]);
  useEffect(() => { if (!active.length) return undefined; const timer = window.setInterval(load, 4000); return () => window.clearInterval(timer); }, [active.length, load]);
  async function control(type, action, id) { setBusy(true); try { await typeConfig[type][action](id); await load(); } catch (requestError) { setError(requestError.message); } finally { setBusy(false); } }
  if (!available && !loading) return <LocalWorkspaceUnavailable />;
  return <div className="space-y-6">
    <section className="rounded-3xl bg-slate-950 px-5 py-7 text-white shadow-2xl sm:px-8"><div className="flex flex-wrap items-start justify-between gap-5"><div><p className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-cyan-300"><Workflow size={15} />Process control center</p><h3 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">Monitor every process from one place</h3><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">Live status for imports, enrichment, the full local pipeline, and intelligence checks. Progress is saved at safe checkpoints so paused or failed work can be resumed.</p></div><div className="rounded-2xl border border-white/10 bg-white/10 px-5 py-4"><p className="text-xs font-bold uppercase tracking-wide text-slate-400">Active now</p><p className="mt-1 text-3xl font-black text-cyan-300">{active.length}</p></div></div></section>
    {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">{error}</div>}
    {mode === "logs" ? <section className="overflow-hidden rounded-3xl border border-slate-700 bg-slate-950 shadow-2xl"><header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-slate-900 px-5 py-4"><div><p className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-cyan-300"><span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />Live worker stream</p><h3 className="mt-1 text-lg font-black text-white">Network and process activity</h3></div><span className="rounded-full bg-emerald-400/10 px-3 py-1.5 text-xs font-bold text-emerald-300">{active.length ? "CONNECTED · streaming" : "IDLE · monitoring"}</span></header><div className="process-terminal h-[30rem] overflow-y-auto p-4 font-mono text-xs leading-6 sm:p-6">{logs.length ? logs.map((entry) => <div key={entry.id} className="process-log-line"><span className="text-slate-500">[{entry.at}]</span> <span className={entry.level === "network" ? "text-cyan-300" : entry.level === "success" ? "text-emerald-300" : "text-slate-300"}>{entry.message}</span></div>) : <div className="text-slate-500">[--:--:--] Waiting for worker telemetry…</div>}<span className="mt-1 inline-block h-4 w-2 animate-pulse bg-cyan-300 align-middle" /></div><footer className="border-t border-white/10 bg-black/20 px-5 py-3 text-[11px] text-slate-500">Live telemetry is polled from the local worker. New entries appear when the phase or persisted counters change.</footer></section> : <>
    <div className="flex items-center justify-between gap-3"><div><h3 className="text-lg font-bold text-slate-900">All processes</h3><p className="text-sm text-slate-500">Automatically refreshes while work is active.</p></div><button type="button" onClick={load} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm disabled:opacity-50"><RefreshCw className={loading ? "animate-spin" : ""} size={16} />Refresh</button></div>
    {loading ? <div className="grid min-h-48 place-items-center rounded-2xl border border-slate-200 bg-white"><LoaderCircle className="animate-spin text-brand-600" size={28} /></div> : items.length ? <div className="grid gap-4 lg:grid-cols-2">{items.map((item) => <JobCard key={`${item.type}-${item.job.id}`} item={item} onControl={control} busy={busy} />)}</div> : <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center"><Clock3 className="mx-auto text-slate-400" size={32} /><h3 className="mt-3 font-bold text-slate-800">No processes have run yet</h3><p className="mt-1 text-sm text-slate-500">Start work from Local data, Enrichment, or Intelligence and it will appear here.</p></div>}</>}
  </div>;
}
