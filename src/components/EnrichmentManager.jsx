import {
  AlertTriangle,
  BadgeCheck,
  Check,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Database,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Globe2,
  LoaderCircle,
  ListChecks,
  Pause,
  Play,
  RefreshCw,
  SearchCheck,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { localDataApi } from "../utils/localDataApi.js";
import { candidateReviewValues } from "../utils/reviewUtils.js";
import LocalWorkspaceUnavailable from "./LocalWorkspaceUnavailable.jsx";

const REVIEW_STATUSES = ["needs_review", "conflict", "not_found", "failed", "enriched", "rejected"];

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** index)).toFixed(index > 1 ? 2 : 1)} ${units[index]}`;
}

function ControlHint({ children, dark = false }) {
  return <span className={`mt-1.5 flex items-start gap-1.5 text-[11px] font-medium normal-case leading-4 tracking-normal ${dark ? "text-slate-300" : "text-slate-500"}`}><CircleHelp className="mt-0.5 shrink-0" size={12} aria-hidden="true" />{children}</span>;
}

function CoverageBar({ label, value, detail, tone }) {
  const percent = Math.max(0, Math.min(100, Number(value || 0)));
  return <div><div className="flex items-end justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div><span className="text-xl font-black text-slate-900">{percent.toFixed(1)}%</span></div><div className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${tone}`} style={{ width: `${percent}%` }} /></div></div>;
}

function CoverageMetric({ label, value, detail, tone = "text-slate-900" }) {
  return <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</p><p className={`mt-1 text-xl font-black ${tone}`}>{Number(value || 0).toLocaleString()}</p><p className="mt-1 text-[11px] leading-4 text-slate-500">{detail}</p></div>;
}

function SourceCoverageTable({ sources, busy, active, onContinue }) {
  if (!sources.length) return null;
  return <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200"><header className="bg-slate-50 px-4 py-3"><h4 className="text-sm font-bold">Completion by raw source CSV</h4><p className="mt-0.5 text-xs text-slate-500">A file can be fully consolidated into master while still needing product facts or online evidence. Unimported files are visible immediately, but their row and part counts become known after import.</p></header><div className="overflow-x-auto"><table className="min-w-full text-xs"><thead className="border-y border-slate-200 bg-white text-left uppercase tracking-wide text-slate-500"><tr>{["Source", "Status", "Raw rows", "Usable", "Unique raw", "In master", "Missing", "With facts", "Pages left", ""].map((heading) => <th key={heading} className="whitespace-nowrap px-3 py-2">{heading}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{sources.map((source) => {
    const imported = Boolean(source.dataset_id);
    const indexed = source.import_status === "indexed";
    const statusLabel = source.import_status === "indexed" ? "In master" : source.import_status === "imported_not_indexed" ? "Needs indexing" : "Not imported";
    const statusClass = source.import_status === "indexed" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700";
    return <tr key={source.source_file} className={!indexed ? "bg-amber-50/30" : ""}><td className="max-w-72 px-3 py-2 font-bold"><span className="break-all">{source.source_file}</span></td><td className="whitespace-nowrap px-3 py-2"><span className={`rounded-full px-2 py-1 font-bold ${statusClass}`}>{statusLabel}</span></td><td className="px-3 py-2">{imported ? Number(source.raw_rows).toLocaleString() : "—"}</td><td className="px-3 py-2">{indexed ? Number(source.usable_rows).toLocaleString() : "—"}</td><td className="px-3 py-2 font-bold">{indexed ? Number(source.unique_parts).toLocaleString() : "—"}</td><td className="px-3 py-2 font-bold text-blue-700">{indexed ? Number(source.master_parts).toLocaleString() : "—"}</td><td className="px-3 py-2 font-bold text-red-700">{indexed ? Number(source.remaining_master_parts).toLocaleString() : "Unknown"}</td><td className="px-3 py-2 text-emerald-700">{indexed ? Number(source.parts_with_facts).toLocaleString() : "—"}</td><td className="px-3 py-2">{indexed ? Number(source.pending_source_pages).toLocaleString() : "—"}</td><td className="px-3 py-2">{indexed && Number(source.pending_source_pages) ? <button type="button" title="Check this source’s remaining linked supplier pages using the current online page budget." disabled={busy || Boolean(active)} onClick={() => onContinue(source.dataset_id)} className="whitespace-nowrap rounded-lg border border-cyan-300 bg-cyan-50 px-3 py-1.5 font-bold text-cyan-800 disabled:opacity-40">Continue source</button> : !indexed ? <span className="whitespace-nowrap text-[11px] font-semibold text-amber-700">Run full pipeline</span> : <span className="text-emerald-600">Complete</span>}</td></tr>;
  })}</tbody></table></div></div>;
}

function normalizeCandidateNumber(candidate) {
  return String(candidate.enriched_part_number || candidate.part_number_raw || "").trim();
}

function isBulkApprovable(candidate) {
  return ["needs_review", "conflict"].includes(candidate.status) && Boolean(normalizeCandidateNumber(candidate));
}

function statusTone(status) {
  if (["completed", "enriched"].includes(status)) return "bg-emerald-50 text-emerald-700";
  if (["running", "queued", "processing"].includes(status)) return "bg-blue-50 text-blue-700";
  if (["conflict", "failed"].includes(status)) return "bg-red-50 text-red-700";
  if (["needs_review", "paused", "not_found"].includes(status)) return "bg-amber-50 text-amber-700";
  return "bg-slate-100 text-slate-600";
}

const JOURNEY_STAGES = [
  { id: "input", label: "Raw catalog", detail: "Read CSV rows", icon: FileSpreadsheet, tone: "cyan" },
  { id: "normalize", label: "Clean & organize", detail: "Normalize and deduplicate", icon: WandSparkles, tone: "violet" },
  { id: "verify", label: "Check online", detail: "Open the supplied source URL", icon: Globe2, tone: "blue" },
  { id: "confidence", label: "Trust check", detail: "Score, accept, or review", icon: BadgeCheck, tone: "amber" },
  { id: "master", label: "Master data", detail: "Save parts and applications", icon: Database, tone: "emerald" },
];

function EnrichmentJourney({ job, stats }) {
  const total = Number(job?.queued_count || 0);
  const processed = Number(job?.processed_count || 0);
  const accepted = Number(job?.enriched_count || 0);
  const review = Number(job?.review_count || 0) + Number(job?.conflict_count || 0);
  const unresolved = Number(job?.not_found_count || 0) + Number(job?.failed_count || 0);
  const percent = total ? Math.round((processed / total) * 100) : 0;
  const running = ["queued", "running"].includes(job?.status);
  const completed = job?.status === "completed";
  const stageState = (id) => {
    if (!job) return "waiting";
    if (id === "input" || id === "normalize") return "complete";
    if (id === "verify") return running ? "active" : "complete";
    if (id === "confidence") return running ? "active" : completed ? "complete" : "waiting";
    if (id === "master") return accepted || completed ? "complete" : "waiting";
    return "waiting";
  };

  return <section className="enrichment-journey relative overflow-hidden rounded-3xl bg-slate-950 px-5 py-7 text-white shadow-2xl sm:px-8 sm:py-9">
    <div className="enrichment-orb enrichment-orb-one" /><div className="enrichment-orb enrichment-orb-two" />
    <div className="relative z-10 flex flex-wrap items-start justify-between gap-5">
      <div className="max-w-3xl"><div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-cyan-300"><Sparkles size={15} />Live enrichment journey</div><h3 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">From messy catalog rows to trusted part intelligence</h3><p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">Watch each record get cleaned, checked against its supplied online catalog page, scored for confidence, and saved into your master parts database.</p></div>
      <div className="flex min-w-44 items-center gap-4 rounded-2xl border border-white/10 bg-white/10 px-4 py-3 backdrop-blur"><div className={`enrichment-live-dot h-3 w-3 rounded-full ${running ? "bg-emerald-400" : completed ? "bg-cyan-300" : "bg-slate-400"}`} /><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Worker status</p><p className="mt-0.5 font-bold capitalize">{job?.status?.replaceAll("_", " ") || "Waiting for a batch"}</p></div></div>
    </div>

    <div className="relative z-10 mt-8 grid gap-3 lg:grid-cols-5">
      {JOURNEY_STAGES.map((stage, index) => {
        const Icon = stage.icon; const state = stageState(stage.id);
        return <div key={stage.id} className="relative flex lg:block">
          <article className={`enrichment-stage enrichment-stage-${stage.tone} enrichment-stage-${state} relative z-10 flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.07] p-4 backdrop-blur lg:block lg:min-h-40`}><span className="enrichment-stage-icon grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/10"><Icon size={21} /></span><div className="lg:mt-6"><p className="text-xs font-bold uppercase tracking-widest text-slate-400">Step {index + 1}</p><h4 className="mt-1 font-bold text-white">{stage.label}</h4><p className="mt-1 text-xs leading-5 text-slate-400">{stage.detail}</p></div>{state === "complete" && <Check className="absolute right-3 top-3 text-emerald-300" size={16} />}{state === "active" && <span className="enrichment-scanner absolute inset-x-3 bottom-2 h-0.5 overflow-hidden rounded-full bg-white/10"><span className="block h-full w-1/3 rounded-full bg-cyan-300" /></span>}</article>
          {index < JOURNEY_STAGES.length - 1 && <div className="enrichment-flow-line absolute -bottom-3 left-8 top-auto h-3 w-0.5 overflow-hidden bg-white/15 lg:-right-3 lg:bottom-auto lg:left-auto lg:top-1/2 lg:h-0.5 lg:w-3"><span /></div>}
        </div>;
      })}
    </div>

    <div className="relative z-10 mt-6 grid gap-4 rounded-2xl border border-white/10 bg-black/20 p-4 md:grid-cols-[auto_1fr_auto] md:items-center">
      <div className="relative grid h-20 w-20 place-items-center rounded-full" style={{ background: `conic-gradient(#22d3ee ${percent * 3.6}deg, rgba(255,255,255,.1) 0deg)` }}><div className="grid h-16 w-16 place-items-center rounded-full bg-slate-950"><span className="text-lg font-black">{percent}%</span></div></div>
      <div><p className="font-bold">{running ? `Actively checking record ${Math.min(processed + 1, total).toLocaleString()}` : completed ? "This batch has completed its journey" : "Ready when you are"}</p><p className="mt-1 text-sm text-slate-400">{job ? `${processed.toLocaleString()} of ${total.toLocaleString()} candidates processed. Online checks use the source URL already stored in each CSV row.` : "Start a small batch below to see records move through every stage."}</p><div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-blue-400 to-violet-400 transition-all duration-700" style={{ width: `${percent}%` }} /></div></div>
      <div className="grid grid-cols-3 gap-2 text-center"><div className="rounded-xl bg-emerald-400/10 px-3 py-2"><p className="text-lg font-black text-emerald-300">{accepted.toLocaleString()}</p><p className="text-[10px] font-bold uppercase tracking-wide text-emerald-200/70">Accepted</p></div><div className="rounded-xl bg-amber-400/10 px-3 py-2"><p className="text-lg font-black text-amber-300">{review.toLocaleString()}</p><p className="text-[10px] font-bold uppercase tracking-wide text-amber-200/70">Review</p></div><div className="rounded-xl bg-rose-400/10 px-3 py-2"><p className="text-lg font-black text-rose-300">{unresolved.toLocaleString()}</p><p className="text-[10px] font-bold uppercase tracking-wide text-rose-200/70">Unresolved</p></div></div>
    </div>
    <p className="relative z-10 mt-4 text-center text-xs text-slate-500">Master database now contains {Number(stats.parts || 0).toLocaleString()} unique parts across {Number(stats.families || 0).toLocaleString()} variant families, with {Number(stats.applications || 0).toLocaleString()} source applications, {Number(stats.compatibility_fitments || 0).toLocaleString()} compatibility fitments, and {Number(stats.cached_pages || 0).toLocaleString()} reusable source pages.</p>
  </section>;
}

const RAW_FIELD_LABELS = {
  diagram_title: "Diagram / assembly",
  make: "Make",
  source_url: "Source page",
  pos: "Diagram position",
  reference_number: "Reference",
  part_number: "Part number",
  description: "Description",
  weight: "Weight",
  quatity: "Quantity",
  quantity: "Quantity",
  price: "Price",
  year: "Year",
  model: "Model",
};

function displayValue(value) {
  if (value == null || String(value).trim() === "") return "Missing";
  return String(value);
}

function candidateAttributes(candidate) {
  try { return Object.entries(JSON.parse(candidate?.extracted_attributes_json || "{}")); }
  catch { return []; }
}

function attributeLabel(key) {
  const units = { mm: "mm", in: "in", ml: "ml", v: "V", a: "A", w: "W", ohm: "Ω", bar: "bar", c: "°C" };
  const pieces = String(key).split("_");
  const last = pieces.at(-1);
  const suffix = units[last] ? ` (${units[last]})` : "";
  if (units[last]) pieces.pop();
  return `${pieces.join(" ").replace(/^./, (letter) => letter.toUpperCase())}${suffix}`;
}

function TransformationShowcase({ data, jobs, selectedJobId, loading, onSelectJob, onSelectExample }) {
  if (loading) return <section className="grid min-h-64 place-items-center rounded-3xl border border-slate-200 bg-white shadow-panel"><div className="flex items-center gap-3 text-sm font-semibold text-slate-500"><LoaderCircle className="animate-spin text-brand-600" size={20} />Building a real before-and-after example…</div></section>;
  if (!data?.candidate) return null;
  const { candidate, raw, examples, job } = data;
  const extractedAttributes = candidateAttributes(candidate);
  const preferredRawKeys = Object.keys(RAW_FIELD_LABELS).filter((key) => raw && key in raw);
  const fallbackRawKeys = Object.keys(raw || {}).filter((key) => key !== "_row_id" && !preferredRawKeys.includes(key)).slice(0, 5);
  const rawKeys = [...preferredRawKeys, ...fallbackRawKeys].filter((key) => displayValue(raw?.[key]) !== "Missing").slice(0, 11);
  const equipment = [
    ["Heated", candidate.heated_state], ["Auto dimming", candidate.auto_dimming_state],
    ["Power folding", candidate.power_folding_state], ["Memory", candidate.memory_state],
    ["Blind spot", candidate.blind_spot_state], ["Camera", candidate.camera_state],
    ["Turn signal", candidate.turn_signal_state], ["Connector pins", candidate.connector_pins],
  ].filter(([, value]) => value && !["unknown", "none_known"].includes(String(value).toLowerCase()));
  const statusLabel = candidate.status === "enriched" ? "Verified & saved" : candidate.status === "needs_review" ? "Enriched proposal · human review" : candidate.status.replaceAll("_", " ");
  const afterFields = [
    ["Normalized identity", candidate.part_number_norm || "Missing"],
    ["OEM display number", candidate.enriched_part_number || candidate.part_number_raw || "Missing"],
    ["Description", candidate.enriched_description || candidate.description_raw || "Missing"],
    ["Part family", candidate.family_name || "Not determined"],
    ["Component scope", candidate.component_scope || "Not determined"],
    ["Side / position", [candidate.side, candidate.position].filter(Boolean).join(" · ") || "Not confirmed"],
    ["Vehicle / assembly", [candidate.vehicle_year || candidate.year, candidate.vehicle_make || candidate.manufacturer_raw, candidate.vehicle_model || candidate.model, candidate.assembly].filter(Boolean).join(" · ") || "Not mapped"],
  ];
  return <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-panel">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 bg-gradient-to-r from-blue-50 via-white to-emerald-50 px-5 py-5 sm:px-7">
      <div><p className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-brand-700"><Sparkles size={15} />Show what Partmaster does</p><h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">One scraped row becomes usable part intelligence</h3><p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">This is a real row from <strong>{job.dataset_name}</strong>—not sample marketing data. Missing facts stay missing until evidence supports them.</p></div>
      <div className="grid min-w-72 gap-2"><label className="text-xs font-bold uppercase tracking-wide text-slate-500">Dataset example<select value={selectedJobId} onChange={(event) => onSelectJob(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold normal-case tracking-normal text-slate-800">{jobs.map((availableJob) => <option key={availableJob.id} value={availableJob.id}>{availableJob.dataset_name} · {availableJob.status.replaceAll("_", " ")}</option>)}</select></label><label className="text-xs font-bold uppercase tracking-wide text-slate-500">Choose another real row<select value={candidate.id} onChange={(event) => onSelectExample(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 font-mono text-sm font-semibold normal-case tracking-normal text-slate-800">{examples.map((example) => <option key={example.id} value={example.id}>Row {example.source_row_id} · {example.part_number_raw || "missing OEM"}</option>)}</select></label></div>
    </header>
    <div className="grid lg:grid-cols-[1fr_0.72fr_1fr]">
      <article className="p-5 sm:p-7"><span className="rounded-full bg-slate-900 px-3 py-1 text-xs font-bold uppercase tracking-wide text-white">Before · raw scrape</span><h4 className="mt-4 text-lg font-bold">What the CSV supplied</h4><p className="mt-1 text-sm text-slate-500">Useful catalog text, but still just an isolated row.</p><dl className="mt-5 space-y-3">{rawKeys.map((key) => <div key={key} className="grid grid-cols-[8rem_1fr] gap-3 border-b border-slate-100 pb-3 text-sm"><dt className="font-semibold text-slate-500">{RAW_FIELD_LABELS[key] || key.replaceAll("_", " ")}</dt><dd className={`min-w-0 break-words font-medium text-slate-800 ${key.includes("part_number") ? "font-mono" : ""}`}>{displayValue(raw?.[key])}</dd></div>)}</dl></article>
      <article className="border-y border-slate-200 bg-slate-950 p-5 text-white sm:p-7 lg:border-x lg:border-y-0"><span className="rounded-full bg-violet-500/20 px-3 py-1 text-xs font-bold uppercase tracking-wide text-violet-200">Partmaster enrichment</span><h4 className="mt-4 text-lg font-bold">What the worker adds</h4><div className="mt-5 space-y-3">{[
        ["1", "Normalize identity", "Removes spacing and punctuation for safe matching."],
        ["2", "Understand the part", "Classifies family, scope, side, position, and variant clues."],
        ["3", "Check evidence", "Uses the saved supplier URL and vehicle mappings when available."],
        ["4", "Protect quality", "Deduplicates, scores confidence, and flags uncertainty for a person."],
        ["5", "Build the master", "Only approved or high-confidence records become trusted master data."],
      ].map(([number, title, detail]) => <div key={number} className="flex gap-3 rounded-xl border border-white/10 bg-white/[0.06] p-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-violet-500 text-xs font-black">{number}</span><div><p className="text-sm font-bold">{title}</p><p className="mt-0.5 text-xs leading-5 text-slate-400">{detail}</p></div></div>)}</div></article>
      <article className="bg-emerald-50/50 p-5 sm:p-7"><div className="flex flex-wrap items-center justify-between gap-2"><span className="rounded-full bg-emerald-600 px-3 py-1 text-xs font-bold uppercase tracking-wide text-white">After · structured record</span><span className={`rounded-full px-3 py-1 text-xs font-bold ${candidate.status === "enriched" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{statusLabel}</span></div><h4 className="mt-4 text-lg font-bold">What Partout Pro can use</h4><p className="mt-1 text-sm text-slate-500">Searchable identity, classification, fitment context, evidence, and a clear trust decision.</p><dl className="mt-5 space-y-3">{afterFields.map(([label, value]) => <div key={label} className="border-b border-emerald-100 pb-3 text-sm"><dt className="text-xs font-bold uppercase tracking-wide text-emerald-700">{label}</dt><dd className="mt-1 break-words font-semibold text-slate-900">{value}</dd></div>)}</dl>{extractedAttributes.length > 0 && <div className="mt-4 rounded-xl border border-emerald-200 bg-white p-4"><div className="flex items-center justify-between gap-3"><p className="text-xs font-bold uppercase tracking-wide text-emerald-700">New product attributes</p><span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-black text-emerald-800">{extractedAttributes.length} found</span></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{extractedAttributes.map(([key, value]) => <div key={key} className="rounded-lg bg-emerald-50 px-3 py-2"><p className="text-[10px] font-bold uppercase tracking-wide text-emerald-600">{attributeLabel(key)}</p><p className="mt-0.5 text-sm font-bold text-slate-900">{value}</p></div>)}</div></div>}{equipment.length > 0 && <div className="mt-4"><p className="text-xs font-bold uppercase tracking-wide text-emerald-700">Confirmed equipment</p><div className="mt-2 flex flex-wrap gap-2">{equipment.map(([label, value]) => <span key={label} className="rounded-full border border-emerald-200 bg-white px-2.5 py-1 text-xs font-semibold text-emerald-800">{label}: {value}</span>)}</div></div>}<div className="mt-5 rounded-xl border border-emerald-200 bg-white p-4"><div className="flex items-center justify-between gap-3"><span className="text-sm font-bold text-slate-800">Evidence confidence</span><span className="text-lg font-black text-emerald-700">{Math.round(Number(candidate.confidence || 0) * 100)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.round(Number(candidate.confidence || 0) * 100)}%` }} /></div><p className="mt-2 text-xs leading-5 text-slate-500">{candidate.decision_notes || candidate.fitment_explanation || "The record is ready for a transparent quality decision."}</p></div></article>
    </div>
  </section>;
}

function FullDatasetPipeline() {
  const [jobs, setJobs] = useState([]);
  const [catalog, setCatalog] = useState({ stats: {}, rows: [] });
  const [pipelineSources, setPipelineSources] = useState([]);
  const [sourceCoverage, setSourceCoverage] = useState({});
  const [rawDataPath, setRawDataPath] = useState("");
  const [onlineBudget, setOnlineBudget] = useState(250);
  const [busy, setBusy] = useState(false);
  const [pipelineError, setPipelineError] = useState("");
  const [pipelineExports, setPipelineExports] = useState([]);
  const load = useCallback(async () => {
    try {
      const jobResult = await localDataApi.pipelineJobs();
      const nextJobs = jobResult.jobs || [];
      setJobs(nextJobs);
      if (nextJobs.some((pipelineJob) => ["queued", "running"].includes(pipelineJob.status))) {
        setPipelineError("");
        return;
      }
      const catalogResult = await localDataApi.pipelineCatalog();
      const sourceResult = await localDataApi.pipelineSources();
      setCatalog(catalogResult); setPipelineSources(sourceResult.sources || []); setSourceCoverage(sourceResult.summary || {}); setRawDataPath(sourceResult.rawDataPath || ""); setPipelineError("");
    } catch (error) { setPipelineError(error.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const active = jobs.find((job) => ["queued", "running"].includes(job.status));
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [active, load]);
  const job = active || jobs[0];
  const scanPercent = Number(job?.total_rows) ? Math.min(100, (Number(job.scanned_rows || 0) / Number(job.total_rows)) * 100) : 0;
  const attributePercent = Number(job?.unique_parts) ? Math.min(100, (Number(job.attribute_processed || 0) / Number(job.unique_parts)) * 100) : 0;
  const onlinePercent = Number(job?.online_budget) ? Math.min(100, (Number(job.online_checked || 0) / Number(job.online_budget)) * 100) : 100;
  const percent = job?.phase === "completed" ? 100 : job?.phase === "checking_shared_sources" ? 90 + onlinePercent * 0.1
    : job?.phase === "extracting_attributes" ? 60 + attributePercent * 0.3
      : job?.phase === "normalizing_and_deduplicating" ? 5 + scanPercent * 0.55 : job?.phase === "importing_sources" ? 3 : 0;
  const phaseLabel = {
    queued: "Waiting to start", importing_sources: "Importing missing source files", normalizing_and_deduplicating: "Normalizing and globally deduplicating",
    extracting_attributes: "Extracting category-specific product facts", checking_shared_sources: "Checking high-value shared source pages", completed: "Full pipeline complete", failed: "Pipeline needs attention",
  }[job?.phase] || String(job?.phase || "Ready").replaceAll("_", " ");

  async function start(continueOnline = false, datasetId = "") {
    setBusy(true); setPipelineError("");
    try { await localDataApi.startPipeline({ importMissing: !continueOnline, continueOnline, onlineBudget, datasetIds: datasetId ? [datasetId] : [] }); await load(); }
    catch (error) { setPipelineError(error.message); }
    finally { setBusy(false); }
  }
  async function control(action) {
    if (!job) return;
    setBusy(true);
    try { if (action === "pause") await localDataApi.pausePipeline(job.id); else await localDataApi.resumePipeline(job.id); await load(); }
    catch (error) { setPipelineError(error.message); }
    finally { setBusy(false); }
  }
  async function exportCatalog() {
    setBusy(true); setPipelineError("");
    try { const result = await localDataApi.exportPipelineCatalog(); setPipelineExports(result.exports || []); }
    catch (error) { setPipelineError(error.message); }
    finally { setBusy(false); }
  }
  const masterCoveragePercent = Number(sourceCoverage.master_coverage_percent || 0);
  const factCoveragePercent = Number(sourceCoverage.master_parts) ? Math.round((Number(sourceCoverage.parts_with_facts || 0) / Number(sourceCoverage.master_parts)) * 1000) / 10 : 0;
  const pageCoveragePercent = Number(sourceCoverage.source_pages) ? Math.round((Number(sourceCoverage.processed_source_pages || 0) / Number(sourceCoverage.source_pages)) * 1000) / 10 : 0;

  return <section className="overflow-hidden rounded-3xl border border-indigo-200 bg-white shadow-panel">
    <header className="flex flex-wrap items-start justify-between gap-4 bg-gradient-to-r from-indigo-950 via-slate-950 to-cyan-950 px-5 py-6 text-white sm:px-7"><div className="max-w-3xl"><p className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-cyan-300"><Database size={15} />Full-dataset intelligence pipeline</p><h3 className="mt-2 text-2xl font-bold">Process every source locally before spending bandwidth online</h3><p className="mt-2 text-sm leading-6 text-slate-300">Imports missing Honda and Harley files, ignores duplicate imports, repairs the usable rows, creates one global OEM identity, extracts attributes locally, then checks shared catalog pages in priority order.</p></div><div className="grid min-w-56 gap-2"><label className="text-xs font-bold uppercase tracking-wide text-slate-300">Online page budget<input type="number" min="0" max="5000" value={onlineBudget} onChange={(event) => setOnlineBudget(Number(event.target.value))} className="mt-1.5 w-full rounded-xl border border-white/20 bg-white/10 px-3 py-2.5 text-sm font-bold text-white" /><ControlHint dark>Maximum unique supplier pages checked in this run. Set 0 for offline processing only; 250 is a safe starting point.</ControlHint></label>{active ? <button type="button" title="Stop after the current safe checkpoint. Progress is saved and can be resumed." disabled={busy} onClick={() => control("pause")} className="inline-flex items-center justify-center gap-2 rounded-xl bg-amber-400 px-4 py-2.5 text-sm font-black text-slate-950 disabled:opacity-50"><Pause size={16} />Pause safely</button> : job?.status === "paused" || job?.status === "failed" ? <button type="button" title="Continue the saved pipeline from its last checkpoint." disabled={busy} onClick={() => control("resume")} className="inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-black text-slate-950 disabled:opacity-50"><Play size={16} />Resume pipeline</button> : Number(catalog.stats?.unique_parts) ? <><button type="button" title="Use the page budget to verify the next highest-priority source pages. Offline data is not rebuilt." disabled={busy || !Number(catalog.stats?.pending_source_pages)} onClick={() => start(true)} className="inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-black text-slate-950 disabled:opacity-50">{busy ? <LoaderCircle className="animate-spin" size={16} /> : <Globe2 size={16} />}Continue online checks</button><button type="button" title="Rescan all source CSVs, refresh deduplication, and re-extract local attributes before online checks." disabled={busy} onClick={() => start(false)} className="text-xs font-bold text-slate-300 underline decoration-white/30 underline-offset-4 hover:text-white">Rebuild from all source files</button></> : <button type="button" title="Import and consolidate every available source CSV, then use the online page budget for evidence checks." disabled={busy} onClick={() => start(false)} className="inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-black text-slate-950 disabled:opacity-50">{busy ? <LoaderCircle className="animate-spin" size={16} /> : <Play size={16} />}Process all source files</button>}</div></header>
    {pipelineError && <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-sm font-semibold text-red-800">{pipelineError}</div>}
    <div className="p-5 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wide text-indigo-600">Current phase</p><p className="mt-1 text-lg font-bold text-slate-900">{phaseLabel}</p>{job?.current_dataset && <p className="mt-1 text-sm text-slate-500">Working on {job.current_dataset}</p>}</div>{job && <span className={`rounded-full px-3 py-1.5 text-xs font-black ${statusTone(job.status)}`}>{job.status.replaceAll("_", " ")}</span>}</div>
      {job && <><div className="mt-5 h-3 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 transition-all" style={{ width: `${percent}%` }} /></div><p className="mt-2 text-xs text-slate-500">Overall pipeline {Math.round(percent)}% · {Number(job.scanned_rows || 0).toLocaleString()} of {Number(job.total_rows || 0).toLocaleString()} rows scanned{job.phase === "extracting_attributes" ? ` · ${Number(job.attribute_processed || 0).toLocaleString()} of ${Number(job.unique_parts || 0).toLocaleString()} unique parts analyzed` : ""}{job.phase === "checking_shared_sources" ? ` · ${Number(job.online_checked || 0).toLocaleString()} of ${Number(job.online_budget || 0).toLocaleString()} online pages checked` : ""}</p></>}
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">{[
        ["Raw rows", job?.total_rows], ["Invalid held out", job?.invalid_rows], ["Unique parts", job?.unique_parts || catalog.stats?.unique_parts],
        ["Duplicates removed", job?.duplicates_removed], ["Parts with facts", job?.attributed_parts || catalog.stats?.attributed_parts],
        ["Product facts", job?.attribute_facts || catalog.stats?.attribute_facts], ["Pages remaining", catalog.stats?.pending_source_pages], ["Online verified", catalog.stats?.online_verified_parts || job?.online_verified_parts],
      ].map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 text-xl font-black text-slate-900">{Number(value || 0).toLocaleString()}</p></div>)}</div>
      <section className="mt-6 rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50 via-white to-emerald-50 p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-[0.16em] text-blue-700">Raw CSV → master completion audit</p><h4 className="mt-1 text-lg font-black text-slate-950">What is finished, and what remains?</h4><p className="mt-1 max-w-3xl text-xs leading-5 text-slate-600">Every parts CSV in the inbox and its <span className="font-mono">rawdata</span> subfolder is compared with the consolidated master. Duplicate raw occurrences do not inflate the master count.</p></div><span className={`rounded-full px-3 py-1.5 text-xs font-black ${Number(sourceCoverage.unindexed_files) ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>{Number(sourceCoverage.unindexed_files || 0) ? `${Number(sourceCoverage.unindexed_files).toLocaleString()} file(s) need processing` : "All discovered files scanned"}</span></div>
        <div className="mt-5 grid gap-3 lg:grid-cols-2"><article className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"><p className="text-xs font-black uppercase tracking-wide text-emerald-700">Raw consolidation</p><p className="mt-1 text-2xl font-black text-emerald-950">{Number(sourceCoverage.pending_scan_rows || 0).toLocaleString()} rows remaining</p><p className="mt-2 text-xs leading-5 text-emerald-800">{Number(sourceCoverage.known_raw_rows || 0).toLocaleString()} raw rows were scanned and resolved into {Number(sourceCoverage.master_parts || 0).toLocaleString()} unique master parts. {Number(sourceCoverage.remaining_master_parts || 0).toLocaleString()} known part identities are missing from master.</p></article><article className="rounded-2xl border border-violet-200 bg-violet-50 p-4"><p className="text-xs font-black uppercase tracking-wide text-violet-700">Enrichment work still open</p><p className="mt-1 text-2xl font-black text-violet-950">{Number(sourceCoverage.remaining_fact_parts || 0).toLocaleString()} parts need facts</p><p className="mt-2 text-xs leading-5 text-violet-800">The parts are already in master; they are not missing. In addition, {Number(sourceCoverage.pending_source_pages || 0).toLocaleString()} linked supplier pages remain available for online evidence checks.</p></article></div>
        <div className="mt-5 grid gap-5 lg:grid-cols-3"><CoverageBar label="Master identity coverage" value={masterCoveragePercent} detail={`${Number(sourceCoverage.master_parts || 0).toLocaleString()} of ${Number(sourceCoverage.raw_unique_parts || 0).toLocaleString()} known unique raw parts are in master`} tone="bg-blue-600" /><CoverageBar label="Product-fact coverage" value={factCoveragePercent} detail={`${Number(sourceCoverage.parts_with_facts || 0).toLocaleString()} master parts have category-specific facts`} tone="bg-emerald-500" /><CoverageBar label="Source-page progress" value={pageCoveragePercent} detail={`${Number(sourceCoverage.processed_source_pages || 0).toLocaleString()} of ${Number(sourceCoverage.source_pages || 0).toLocaleString()} linked pages checked`} tone="bg-cyan-500" /></div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5 xl:grid-cols-9"><CoverageMetric label="Raw files found" value={sourceCoverage.discovered_files} detail={`${Number(sourceCoverage.indexed_files || 0).toLocaleString()} fully scanned`} /><CoverageMetric label="Known raw rows" value={sourceCoverage.known_raw_rows} detail="Rows in imported scrape files" /><CoverageMetric label="Rows await scan" value={sourceCoverage.pending_scan_rows} detail="Imported but not yet inventoried" tone="text-amber-700" /><CoverageMetric label="Usable rows" value={sourceCoverage.usable_rows} detail="Rows with a usable OEM identity" /><CoverageMetric label="Invalid held out" value={sourceCoverage.invalid_rows} detail="Scanned rows with invalid identities" tone="text-amber-700" /><CoverageMetric label="Unique raw parts" value={sourceCoverage.raw_unique_parts} detail="Deduplicated across scanned sources" /><CoverageMetric label="In master" value={sourceCoverage.master_parts} detail="Destination identities completed" tone="text-blue-700" /><CoverageMetric label="Missing from master" value={sourceCoverage.remaining_master_parts} detail="Known identities still to consolidate" tone="text-red-700" /><CoverageMetric label="Still need facts" value={sourceCoverage.remaining_fact_parts} detail="In master but without extracted facts" tone="text-violet-700" /></div>
        {rawDataPath && <p className="mt-4 break-all rounded-xl border border-blue-100 bg-white/80 px-3 py-2 text-[11px] leading-5 text-slate-600"><strong>Scrape source folder:</strong> <span className="font-mono">{rawDataPath}</span>. New CSV/TSV/TXT files placed there appear as “not imported” until the next full pipeline run.</p>}
      </section>
      {job?.status === "completed" && <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-bold text-emerald-950">Your deduplicated enriched catalog is ready</p><p className="mt-1 text-xs text-emerald-800">Export the flattened part catalog plus full source traceability and online-check quality results.</p></div><button type="button" disabled={busy} onClick={exportCatalog} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-black text-white disabled:opacity-50">{busy ? <LoaderCircle className="animate-spin" size={16} /> : <Download size={16} />}Create CSV downloads</button></div>{pipelineExports.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{pipelineExports.map((item) => <a key={item.filename} href={item.downloadUrl} download className="inline-flex items-center gap-2 rounded-lg border border-emerald-300 bg-white px-3 py-2 text-xs font-bold text-emerald-800 hover:bg-emerald-100"><Download size={14} />{item.filename} · {formatBytes(item.bytes)}</a>)}</div>}</div>}
      <SourceCoverageTable sources={pipelineSources} busy={busy} active={active} onContinue={(datasetId) => start(true, datasetId)} />
      {catalog.rows?.length > 0 && <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200"><header className="bg-slate-50 px-4 py-3"><h4 className="text-sm font-bold">Highest-impact deduplicated parts</h4><p className="mt-0.5 text-xs text-slate-500">One identity per manufacturer + normalized OEM number, ordered by how often it appears.</p></header><div className="overflow-x-auto"><table className="min-w-full text-xs"><thead className="border-y border-slate-200 bg-white text-left uppercase tracking-wide text-slate-500"><tr>{["Make", "OEM number", "Family", "Description", "Occurrences", "Datasets", "Facts", "Online"].map((heading) => <th key={heading} className="whitespace-nowrap px-3 py-2">{heading}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{catalog.rows.slice(0, 10).map((part) => <tr key={part.part_key}><td className="px-3 py-2 font-bold">{part.manufacturer}</td><td className="whitespace-nowrap px-3 py-2 font-mono font-bold text-brand-700">{part.part_number}</td><td className="whitespace-nowrap px-3 py-2">{part.family_name || "Pending"}</td><td className="max-w-72 truncate px-3 py-2" title={part.description || ""}>{part.description || "—"}</td><td className="px-3 py-2 font-bold">{Number(part.occurrence_count).toLocaleString()}</td><td className="px-3 py-2">{Number(part.dataset_count).toLocaleString()}</td><td className="px-3 py-2 font-bold text-emerald-700">{Number(part.extracted_attribute_count).toLocaleString()}</td><td className="px-3 py-2 capitalize">{part.online_status.replaceAll("_", " ")}</td></tr>)}</tbody></table></div></div>}
    </div>
  </section>;
}

function FeedbackDialog({ type, message, onClose }) {
  if (!message) return null;
  const isError = type === "error";
  return <div className="fixed inset-0 z-[70] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm" role={isError ? "alertdialog" : "dialog"} aria-modal="true">
    <div className={`w-full max-w-lg overflow-hidden rounded-3xl border bg-white shadow-2xl ${isError ? "border-red-200" : "border-emerald-200"}`}>
      <div className={`grid place-items-center px-6 pb-5 pt-8 text-center ${isError ? "bg-red-50" : "bg-emerald-50"}`}><span className={`grid h-16 w-16 place-items-center rounded-2xl text-white shadow-lg ${isError ? "bg-red-600" : "bg-emerald-600"}`}>{isError ? <AlertTriangle size={30} /> : <Check size={30} />}</span><h3 className={`mt-4 text-xl font-bold ${isError ? "text-red-950" : "text-emerald-950"}`}>{isError ? "Action needs attention" : "Success"}</h3><p className={`mt-2 max-w-md text-sm leading-6 ${isError ? "text-red-800" : "text-emerald-800"}`}>{message}</p></div>
      <div className="flex justify-center bg-white px-6 py-5"><button type="button" onClick={onClose} autoFocus className={`min-w-32 rounded-xl px-5 py-2.5 text-sm font-bold text-white ${isError ? "bg-red-600 hover:bg-red-700" : "bg-emerald-600 hover:bg-emerald-700"}`}>{isError ? "Return to review" : "Continue"}</button></div>
    </div>
  </div>;
}

function ConfirmDialog({ count, busy, onCancel, onConfirm }) {
  if (!count) return null;
  return <div className="fixed inset-0 z-[75] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm" role="alertdialog" aria-modal="true">
    <div className="w-full max-w-lg overflow-hidden rounded-3xl border border-emerald-200 bg-white shadow-2xl"><div className="grid place-items-center bg-emerald-50 px-6 pb-5 pt-8 text-center"><span className="grid h-16 w-16 place-items-center rounded-2xl bg-emerald-600 text-white shadow-lg"><ListChecks size={30} /></span><h3 className="mt-4 text-xl font-bold text-emerald-950">Approve {count.toLocaleString()} selected records?</h3><p className="mt-2 max-w-md text-sm leading-6 text-emerald-800">Each record will be promoted using its current evidence and variant fields. Compatibility discovery will continue in the background where the source supports it.</p></div><div className="flex justify-center gap-3 px-6 py-5"><button type="button" disabled={busy} onClick={onCancel} className="rounded-xl border border-slate-300 px-5 py-2.5 text-sm font-bold text-slate-700 disabled:opacity-50">Cancel</button><button type="button" disabled={busy} onClick={onConfirm} autoFocus className="inline-flex min-w-40 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50">{busy ? <LoaderCircle className="animate-spin" size={17} /> : <Check size={17} />}Approve selected</button></div></div>
  </div>;
}

function FeatureSelect({ label, value, onChange }) {
  const tone = value === "yes" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : value === "no" ? "border-red-200 bg-red-50 text-red-800" : "border-slate-300 bg-white text-slate-700";
  return <label className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}<select value={value || "unknown"} onChange={(event) => onChange(event.target.value)} className={`mt-1.5 w-full rounded-xl border px-3 py-2.5 text-sm font-semibold normal-case tracking-normal ${tone}`}><option value="unknown">Unknown</option><option value="yes">Yes</option><option value="no">No</option></select></label>;
}

export function ReviewModal({ candidate, onClose, onDecision }) {
  const [values, setValues] = useState(() => candidateReviewValues(candidate));
  const [saving, setSaving] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [comparison, setComparison] = useState({ familyName: "", variants: [], compatibility: [], compatibilitySourceUrl: "" });
  const [comparisonLoading, setComparisonLoading] = useState(true);
  const [compatibilityLoading, setCompatibilityLoading] = useState(false);
  const [compatibilityUrl, setCompatibilityUrl] = useState("");
  const [compatibilityText, setCompatibilityText] = useState("");
  const [checkingPartId, setCheckingPartId] = useState("");
  const [partCheckResult, setPartCheckResult] = useState(null);

  useEffect(() => {
    let active = true;
    setComparisonLoading(true);
    localDataApi.candidateVariants(candidate.id).then((result) => {
      if (active) {
        setComparison(result);
        setCompatibilityUrl(result.compatibilitySourceUrl || "");
      }
    }).catch(() => {
      if (active) setComparison({ familyName: candidate.family_name || "", variants: [], compatibility: [], compatibilitySourceUrl: "" });
    }).finally(() => { if (active) setComparisonLoading(false); });
    return () => { active = false; };
  }, [candidate.family_name, candidate.id]);

  async function decide(decision) {
    setSaving(true);
    setReviewError("");
    try {
      await onDecision(decision, values);
    } catch (requestError) {
      setReviewError(requestError.message || "The review decision could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function fetchCompatibility() {
    setCompatibilityLoading(true);
    setReviewError("");
    try {
      const result = await localDataApi.fetchCandidateCompatibility(candidate.id, { force: true, sourceUrl: compatibilityUrl, compatibilityText });
      setComparison((current) => ({ ...current, compatibility: result.compatibility || [], compatibilitySourceUrl: result.sourceUrl || current.compatibilitySourceUrl }));
      setCompatibilityText("");
    } catch (requestError) {
      setReviewError(requestError.message || "Compatibility could not be retrieved.");
    } finally {
      setCompatibilityLoading(false);
    }
  }

  async function checkPart(variant) {
    setCheckingPartId(variant.id);
    setPartCheckResult(null);
    setReviewError("");
    try {
      const result = await localDataApi.checkMasterPart(variant.id);
      setPartCheckResult({ ...result, partNumber: variant.part_number });
      const refreshed = await localDataApi.candidateVariants(candidate.id);
      setComparison(refreshed);
    } catch (requestError) {
      setReviewError(requestError.message || "This part could not be checked.");
    } finally {
      setCheckingPartId("");
    }
  }

  const equipmentAttributeKeys = ["heated", "auto_dimming", "power_folding", "memory", "blind_spot", "camera", "connector_pins"];
  const showEquipmentColumns = /mirror|rearview/i.test(comparison.familyName || values.familyName || "") || comparison.variants?.some((variant) => equipmentAttributeKeys.some((key) => variant[key] && !["unknown", "none_known"].includes(String(variant[key]).toLowerCase())));
  const extractedAttributes = candidateAttributes(candidate);

  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-4">
    <div className="max-h-[92vh] w-full max-w-6xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
      <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4">
        <div><h3 className="font-semibold">Review enrichment evidence</h3><p className="mt-1 text-xs text-slate-500">Source row {candidate.source_row_id} · Confidence {Math.round(Number(candidate.confidence || 0) * 100)}%</p><div className="mt-3 flex flex-wrap gap-2">{(candidate.vehicle_year || candidate.year) && <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700"><span className="mr-1 font-medium text-blue-500">Year</span>{candidate.vehicle_year || candidate.year}</span>}{(candidate.vehicle_make || candidate.manufacturer_raw) && <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700"><span className="mr-1 font-medium text-emerald-500">Make</span>{candidate.vehicle_make || candidate.manufacturer_raw}</span>}{(candidate.family_name || candidate.assembly) && <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-bold text-violet-700"><span className="mr-1 font-medium text-violet-500">Category</span>{candidate.family_name || candidate.assembly}</span>}</div></div>
        <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><X size={18} /></button>
      </header>
      {reviewError && <div className="mx-5 mt-5 flex items-start gap-3 rounded-2xl border-2 border-red-300 bg-red-50 p-4 text-red-900" role="alert"><AlertTriangle className="mt-0.5 shrink-0 text-red-600" size={22} /><div><p className="font-bold">Could not save this review</p><p className="mt-1 text-sm leading-5">{reviewError}</p><p className="mt-2 text-xs font-semibold text-red-700">Your edits are still here. Correct the issue and try again.</p></div></div>}
      <div className="grid gap-4 p-5 sm:grid-cols-2">
        <label className="text-sm font-medium text-slate-700">OEM Part Number<input value={values.partNumber} onChange={(event) => setValues((current) => ({ ...current, partNumber: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5 font-mono font-normal" /></label>
        <label className="text-sm font-medium text-slate-700">Side<select value={values.side} onChange={(event) => setValues((current) => ({ ...current, side: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 font-normal">{["Unknown", "Left", "Right", "Center", "Universal"].map((side) => <option key={side}>{side}</option>)}</select></label>
        <label className="text-sm font-medium text-slate-700 sm:col-span-2">Description<input value={values.description} onChange={(event) => setValues((current) => ({ ...current, description: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5 font-normal" /></label>
        <label className="text-sm font-medium text-slate-700">Position<input value={values.position} onChange={(event) => setValues((current) => ({ ...current, position: event.target.value }))} placeholder="Position 1, Front Upper…" className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5 font-normal" /></label>
        <label className="text-sm font-medium text-slate-700">Location notes<input value={values.locationNotes} onChange={(event) => setValues((current) => ({ ...current, locationNotes: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5 font-normal" /></label>
        {(candidate.epid || candidate.vehicle_mapping_method) && <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 sm:col-span-2"><div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="font-bold text-emerald-950">Vehicle identity mapping</h4><p className="mt-1 text-sm text-emerald-800">{[candidate.vehicle_year || candidate.year, candidate.vehicle_make || candidate.manufacturer_raw, candidate.vehicle_model || candidate.model, candidate.vehicle_trim, candidate.vehicle_motorcycle_type || candidate.vehicle_type].filter(Boolean).join(" · ")}</p><p className="mt-1 text-xs text-emerald-700">ePID {candidate.epid} · {(candidate.vehicle_mapping_method || "source").replaceAll("_", " ")}</p></div>{candidate.vehicle_mapping_confidence != null && <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-emerald-700">{Math.round(Number(candidate.vehicle_mapping_confidence) * 100)}% mapping confidence</span>}</div></section>}
        <section className="rounded-2xl border border-violet-200 bg-violet-50/60 p-4 sm:col-span-2">
          <div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-600 text-white"><Sparkles size={19} /></span><div><h4 className="font-bold text-violet-950">Variant configuration</h4><p className="mt-1 text-xs leading-5 text-violet-700">These attributes prevent similar-looking part numbers from being treated as interchangeable when their equipment differs.</p></div></div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500">Part family<input value={values.familyName} onChange={(event) => setValues((current) => ({ ...current, familyName: event.target.value }))} placeholder="Exterior Mirror" className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal" /></label>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500">Component scope<select value={values.componentScope} onChange={(event) => setValues((current) => ({ ...current, componentScope: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal"><option value="assembly">Complete assembly</option><option value="component">Component</option><option value="kit">Kit</option><option value="unknown">Unknown</option></select></label>
          </div>
          {showEquipmentColumns ? <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FeatureSelect label="Heated" value={values.heatedState} onChange={(value) => setValues((current) => ({ ...current, heatedState: value }))} />
            <FeatureSelect label="Auto dimming" value={values.autoDimmingState} onChange={(value) => setValues((current) => ({ ...current, autoDimmingState: value }))} />
            <FeatureSelect label="Power folding" value={values.powerFoldingState} onChange={(value) => setValues((current) => ({ ...current, powerFoldingState: value }))} />
            <FeatureSelect label="Memory" value={values.memoryState} onChange={(value) => setValues((current) => ({ ...current, memoryState: value }))} />
            <FeatureSelect label="Blind spot" value={values.blindSpotState} onChange={(value) => setValues((current) => ({ ...current, blindSpotState: value }))} />
            <FeatureSelect label="Camera" value={values.cameraState} onChange={(value) => setValues((current) => ({ ...current, cameraState: value }))} />
            <FeatureSelect label="Turn signal" value={values.turnSignalState} onChange={(value) => setValues((current) => ({ ...current, turnSignalState: value }))} />
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500">Connector pins<input value={values.connectorPins} onChange={(event) => setValues((current) => ({ ...current, connectorPins: event.target.value }))} placeholder="e.g. 5" className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal" /></label>
          </div> : <p className="mt-4 rounded-xl border border-violet-100 bg-white px-3 py-2.5 text-xs leading-5 text-violet-700">Mirror equipment fields are hidden because they do not apply to this {values.familyName || "part"} family. The part checker below focuses on description, scope, source evidence, and confidence.</p>}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500">Required vehicle options<input value={values.requiredOptions} onChange={(event) => setValues((current) => ({ ...current, requiredOptions: event.target.value }))} placeholder="BMW S430A, S5DFA…" className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal" /></label>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500">Excluded vehicle options<input value={values.excludedOptions} onChange={(event) => setValues((current) => ({ ...current, excludedOptions: event.target.value }))} placeholder="Not with S5DLA…" className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal" /></label>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500 sm:col-span-2">Variant summary<input value={values.variantSummary} onChange={(event) => setValues((current) => ({ ...current, variantSummary: event.target.value }))} placeholder="Heated · Power-fold · 5-pin" className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal" /></label>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500 sm:col-span-2">Why it fits<textarea value={values.fitmentExplanation} onChange={(event) => setValues((current) => ({ ...current, fitmentExplanation: event.target.value }))} rows="2" placeholder="Explain the fitment evidence and any uncertainty." className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal" /></label>
          </div>
        </section>
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 sm:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="font-bold text-emerald-950">Category-specific product attributes</h4><p className="mt-1 text-xs leading-5 text-emerald-700">Facts parsed from the part description and checked source content. Only explicit values are shown—unknown values are not invented.</p></div><span className="rounded-full bg-white px-3 py-1 text-xs font-black text-emerald-700">{extractedAttributes.length} facts found</span></div>
          {extractedAttributes.length ? <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{extractedAttributes.map(([key, value]) => <div key={key} className="rounded-xl border border-emerald-100 bg-white px-3 py-2.5"><p className="text-[10px] font-bold uppercase tracking-wide text-emerald-600">{attributeLabel(key)}</p><p className="mt-1 text-sm font-bold text-slate-900">{value}</p></div>)}</div> : <p className="mt-4 rounded-xl border border-dashed border-emerald-200 bg-white/70 px-3 py-4 text-sm text-emerald-800">No explicit technical measurements or product properties were found in this row yet. A background source check may add them if the supplier exposes those facts.</p>}
        </section>
        <section className="overflow-hidden rounded-2xl border border-slate-200 sm:col-span-2">
          <header className="flex items-center justify-between bg-slate-50 px-4 py-3"><div><h4 className="text-sm font-bold text-slate-800">Part checker</h4><p className="mt-0.5 text-xs text-slate-500">Existing {comparison.familyName || values.familyName || "part family"} records · columns adapt to the category</p></div>{comparisonLoading && <LoaderCircle className="animate-spin text-brand-600" size={17} />}</header>
          {partCheckResult && <div className={`border-t px-4 py-3 text-sm ${partCheckResult.status === "verified" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : partCheckResult.status === "not_found" || partCheckResult.status === "no_source" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-blue-200 bg-blue-50 text-blue-900"}`}><div className="flex flex-wrap items-center justify-between gap-2"><p><span className="font-mono font-bold">{partCheckResult.partNumber}</span> — {partCheckResult.message}</p><span className="flex items-center gap-3">{partCheckResult.confidence != null && <strong>{Math.round(Number(partCheckResult.confidence) * 100)}% confidence</strong>}{partCheckResult.evidenceUrl && <a href={partCheckResult.evidenceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-bold underline">Open evidence <ExternalLink size={13} /></a>}</span></div></div>}
          {!comparisonLoading && comparison.variants?.length ? <div className="overflow-x-auto"><table className="min-w-full text-xs"><thead className="border-y border-slate-200 bg-white text-left uppercase tracking-wide text-slate-500"><tr><th className="whitespace-nowrap px-3 py-2">Part number</th><th className="px-3 py-2">Description</th><th className="whitespace-nowrap px-3 py-2">Scope</th><th className="whitespace-nowrap px-3 py-2">Evidence</th><th className="whitespace-nowrap px-3 py-2">Confidence</th>{showEquipmentColumns && ["Side", "Heated", "Auto dim", "Folding", "Memory", "Blind spot", "Camera", "Pins"].map((heading) => <th key={heading} className="whitespace-nowrap px-3 py-2">{heading}</th>)}<th className="px-3 py-2"><span className="sr-only">Action</span></th></tr></thead><tbody className="divide-y divide-slate-100">{comparison.variants.map((variant) => {
            const confidence = Number(variant.confidence || 0);
            const evidenceLabel = variant.evidence_url ? (confidence >= 0.94 ? "Verified" : "Needs review") : "No evidence";
            const evidenceTone = variant.evidence_url ? (confidence >= 0.94 ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700") : "bg-slate-100 text-slate-600";
            return <tr key={variant.id} className="text-slate-700"><td className="whitespace-nowrap px-3 py-2 font-mono font-bold text-brand-700">{variant.part_number}</td><td className="min-w-56 max-w-80 px-3 py-2"><p className="line-clamp-2">{variant.description || "No description saved"}</p>{variant.variant_summary && <p className="mt-1 text-[11px] font-semibold text-violet-700">{variant.variant_summary}</p>}</td><td className="whitespace-nowrap px-3 py-2 capitalize">{variant.component_scope || "Unknown"}</td><td className="whitespace-nowrap px-3 py-2"><span className={`rounded-full px-2 py-1 font-bold ${evidenceTone}`}>{evidenceLabel}</span>{variant.evidence_url && <a href={variant.evidence_url} target="_blank" rel="noreferrer" className="ml-2 font-bold text-brand-700">Open</a>}</td><td className="px-3 py-2 font-bold">{confidence ? `${Math.round(confidence * 100)}%` : "—"}</td>{showEquipmentColumns && <><td className="whitespace-nowrap px-3 py-2">{variant.side || "—"}</td>{["heated", "auto_dimming", "power_folding", "memory", "blind_spot", "camera"].map((key) => <td key={key} className="px-3 py-2 capitalize">{variant[key] || "—"}</td>)}<td className="px-3 py-2">{variant.connector_pins || "—"}</td></>}<td className="whitespace-nowrap px-3 py-2"><button type="button" disabled={Boolean(checkingPartId)} onClick={() => checkPart(variant)} className="inline-flex items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 font-bold text-brand-700 disabled:opacity-50">{checkingPartId === variant.id ? <LoaderCircle className="animate-spin" size={13} /> : <SearchCheck size={13} />}Check part</button></td></tr>;
          })}</tbody></table></div> : !comparisonLoading && <p className="px-4 py-5 text-sm text-slate-500">No related master variants yet. Approving this record will begin the family.</p>}
        </section>
        <section className="overflow-hidden rounded-2xl border border-cyan-200 bg-cyan-50/40 sm:col-span-2">
          <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><div><h4 className="text-sm font-bold text-cyan-950">Vehicle and assembly compatibility</h4><p className="mt-0.5 text-xs text-cyan-700">{Number(comparison.compatibility?.length || 0).toLocaleString()} verified “where used” fitments for this exact OEM number</p></div><button type="button" disabled={compatibilityLoading || (!compatibilityUrl && !compatibilityText.trim())} onClick={fetchCompatibility} className="inline-flex items-center gap-2 rounded-xl bg-cyan-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-40">{compatibilityLoading ? <LoaderCircle className="animate-spin" size={15} /> : <Globe2 size={15} />}{compatibilityText.trim() ? "Import pasted list" : comparison.compatibility?.length ? "Refresh compatibility" : "Fetch compatibility"}</button></header>
          <div className="grid gap-3 border-t border-cyan-200 px-4 py-4"><label className="text-xs font-bold uppercase tracking-wide text-cyan-900">Compatibility-list URL<input value={compatibilityUrl} onChange={(event) => setCompatibilityUrl(event.target.value)} className="mt-1.5 w-full rounded-xl border border-cyan-200 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal" /></label><label className="text-xs font-bold uppercase tracking-wide text-cyan-900">Or paste the “Assemblies where used” list<textarea value={compatibilityText} onChange={(event) => setCompatibilityText(event.target.value)} rows="3" placeholder="Paste the linked compatibility list here when the supplier blocks automatic access." className="mt-1.5 w-full rounded-xl border border-cyan-200 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal" /></label></div>
          {comparison.compatibility?.length ? <div className="max-h-56 overflow-auto border-t border-cyan-200"><table className="min-w-full bg-white text-xs"><thead className="sticky top-0 bg-cyan-50 text-left uppercase tracking-wide text-cyan-800"><tr>{["Year", "Model", "Model code", "Assembly", "Evidence"].map((heading) => <th key={heading} className="whitespace-nowrap px-3 py-2">{heading}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{comparison.compatibility.map((fitment) => <tr key={fitment.id}><td className="px-3 py-2 font-bold">{fitment.year || "—"}</td><td className="whitespace-nowrap px-3 py-2">{fitment.model || "—"}</td><td className="whitespace-nowrap px-3 py-2 font-mono">{fitment.model_code || "—"}</td><td className="whitespace-nowrap px-3 py-2">{fitment.assembly || "—"}</td><td className="px-3 py-2">{fitment.evidence_url && <a href={fitment.evidence_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-brand-700">Open <ExternalLink size={12} /></a>}</td></tr>)}</tbody></table></div> : <p className="border-t border-cyan-200 px-4 py-4 text-sm text-cyan-800">No compatibility rows saved yet. Fetching uses the OEM catalog’s part-specific “where used” list and stores each fitment separately.</p>}
        </section>
        <label className="text-sm font-medium text-slate-700 sm:col-span-2">Review notes<textarea value={values.notes} onChange={(event) => setValues((current) => ({ ...current, notes: event.target.value }))} rows="3" className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5 font-normal" /></label>
        <div className="rounded-xl bg-slate-50 p-4 text-sm sm:col-span-2"><p className="font-semibold text-slate-700">Raw source</p><p className="mt-1 text-slate-600">{candidate.description_raw || "No description"}</p><p className="mt-2 text-xs text-slate-500">{[candidate.year, candidate.manufacturer_raw, candidate.model, candidate.assembly].filter(Boolean).join(" · ")}</p>{candidate.evidence_url && <a href={candidate.evidence_url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-brand-700">Open evidence <ExternalLink size={14} /></a>}</div>
      </div>
      <footer className="sticky bottom-0 flex flex-wrap justify-end gap-3 border-t border-slate-200 bg-white px-5 py-4">
        <button type="button" disabled={saving} onClick={() => decide("reject")} className="rounded-xl border border-red-200 px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-50">Reject</button>
        <button type="button" disabled={saving || !values.partNumber.trim()} onClick={() => decide("approve")} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? <LoaderCircle className="animate-spin" size={16} /> : <Check size={16} />}Approve and promote</button>
      </footer>
    </div>
  </div>;
}

export default function EnrichmentManager() {
  const [connected, setConnected] = useState(null);
  const [datasets, setDatasets] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [stats, setStats] = useState({ parts: 0, families: 0, applications: 0, attributed_variants: 0, compatibility_fitments: 0, compatibility_parts: 0, cached_pages: 0, candidate_attribute_facts: 0, awaiting_review: 0, enriched_candidates: 0 });
  const [quality, setQuality] = useState({ total_parts: 0, incomplete_parts: 0, duplicate_part_keys: 0, low_confidence_parts: 0, total_applications: 0, mapped_applications: 0, applications_with_side: 0, applications_with_position: 0, compatibility_fitments: 0, meaningful_variant_attributes: 0, awaiting_review: 0 });
  const [selectedJobId, setSelectedJobId] = useState("");
  const [statusFilter, setStatusFilter] = useState("needs_review");
  const [reviewFilters, setReviewFilters] = useState({ q: "", make: "", year: "", category: "" });
  const [appliedReviewFilters, setAppliedReviewFilters] = useState({ q: "", make: "", year: "", category: "" });
  const [candidates, setCandidates] = useState([]);
  const [candidateTotal, setCandidateTotal] = useState(0);
  const [reviewing, setReviewing] = useState(null);
  const [jobsExpanded, setJobsExpanded] = useState(false);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState([]);
  const [bulkConfirmCount, setBulkConfirmCount] = useState(0);
  const [bulkApproving, setBulkApproving] = useState(false);
  const [form, setForm] = useState({ datasetId: "", name: "", requestedCandidates: 1000, startRowId: 0, batchSize: 10, autoAcceptThreshold: 0.94 });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [transformation, setTransformation] = useState(null);
  const [transformationLoading, setTransformationLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [datasetResult, jobResult, statsResult, qualityResult] = await Promise.all([localDataApi.datasets(), localDataApi.enrichmentJobs(), localDataApi.masterStats(), localDataApi.masterQuality()]);
      setConnected(true);
      setDatasets(datasetResult.datasets);
      setJobs(jobResult.jobs);
      setStats(statsResult.stats);
      setQuality(qualityResult.quality);
      setForm((current) => ({ ...current, datasetId: current.datasetId || datasetResult.datasets[0]?.id || "" }));
      setSelectedJobId((current) => current || jobResult.jobs[0]?.id || "");
      setError("");
    } catch {
      setConnected(false);
    }
  }, []);

  const loadCandidates = useCallback(async () => {
    if (!connected) return;
    try {
      const searchingAllJobs = Object.values(appliedReviewFilters).some((value) => String(value || "").trim());
      const result = await localDataApi.enrichmentCandidates({ jobId: searchingAllJobs ? "" : selectedJobId, status: statusFilter, ...appliedReviewFilters, limit: 200 });
      setCandidates(result.candidates);
      setCandidateTotal(result.total);
    } catch (requestError) {
      setError(requestError.message);
    }
  }, [appliedReviewFilters, connected, selectedJobId, statusFilter]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { loadCandidates(); }, [loadCandidates]);
  const loadTransformation = useCallback(async (candidateId = "") => {
    if (!connected || !selectedJobId) return;
    setTransformationLoading(true);
    try {
      setTransformation(await localDataApi.enrichmentTransformation(selectedJobId, candidateId));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setTransformationLoading(false);
    }
  }, [connected, selectedJobId]);
  useEffect(() => { loadTransformation(); }, [loadTransformation]);
  useEffect(() => {
    setSelectedCandidateIds((current) => current.filter((id) => candidates.some((candidate) => candidate.id === id)));
  }, [candidates]);

  const hasActiveJob = useMemo(() => jobs.some((job) => ["queued", "running"].includes(job.status)), [jobs]);
  useEffect(() => {
    if (!hasActiveJob) return undefined;
    const timer = window.setInterval(async () => { await refresh(); await loadCandidates(); }, 2500);
    return () => window.clearInterval(timer);
  }, [hasActiveJob, loadCandidates, refresh]);

  async function startJob(event) {
    event.preventDefault();
    if (!form.datasetId) return setError("Import and select a local dataset first.");
    setStarting(true); setError(""); setMessage("");
    try {
      const result = await localDataApi.startEnrichment(form);
      setMessage(`Queued ${Number(result.candidateCount).toLocaleString()} unique candidates for local background enrichment.`);
      setSelectedJobId(result.jobId);
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setStarting(false);
    }
  }

  function searchReview(event) {
    event.preventDefault();
    setSelectedCandidateIds([]);
    setAppliedReviewFilters({ ...reviewFilters });
  }

  function clearReviewSearch() {
    const empty = { q: "", make: "", year: "", category: "" };
    setReviewFilters(empty);
    setAppliedReviewFilters(empty);
    setSelectedCandidateIds([]);
  }

  function loadMirrorDemo() {
    const demo = { q: "7012", make: "Kawasaki", year: "1996", category: "Mirror" };
    setStatusFilter("needs_review");
    setReviewFilters(demo);
    setAppliedReviewFilters(demo);
    setSelectedCandidateIds([]);
  }

  async function controlJob(job, action) {
    try {
      if (action === "pause") await localDataApi.pauseEnrichment(job.id);
      else await localDataApi.resumeEnrichment(job.id);
      await refresh();
    } catch (requestError) { setError(requestError.message); }
  }

  async function reprocessReview(job) {
    try {
      await localDataApi.reprocessEnrichmentReview(job.id);
      setMessage("Rechecking unresolved evidence with the updated enrichment rules.");
      await refresh();
    } catch (requestError) { setError(requestError.message); }
  }

  async function fetchSelectedEvidence() {
    const selected = candidates.filter((candidate) => selectedCandidateIds.includes(candidate.id));
    if (!selected.length) return;
    const byJob = selected.reduce((groups, candidate) => { (groups[candidate.job_id] ||= []).push(candidate.id); return groups; }, {});
    try {
      for (const [jobId, ids] of Object.entries(byJob)) await localDataApi.reprocessEnrichmentReview(jobId, ids);
      setSelectedCandidateIds([]);
      setMessage(`Queued source-page fetch for ${selected.length.toLocaleString()} review records. Existing enriched records were not changed.`);
      await refresh(); await loadCandidates();
    } catch (requestError) { setError(requestError.message); }
  }

  function prepareNextBatch(job) {
    setForm((current) => ({
      ...current,
      datasetId: job.dataset_id,
      startRowId: Number(job.last_source_row_id || job.start_row_id || 0),
    }));
    setMessage(`Next batch prepared after source row ${Number(job.last_source_row_id || 0).toLocaleString()}. Review the size, then click Start batch.`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function decideCandidate(decision, values) {
    try {
      await localDataApi.reviewEnrichmentCandidate(reviewing.id, { decision, ...values });
      setReviewing(null);
      setMessage(decision === "approve" ? "Candidate promoted to the canonical master database." : "Candidate rejected; raw source data was preserved.");
      await refresh(); await loadCandidates();
    } catch (requestError) {
      throw new Error(requestError.message || "The review decision could not be saved.");
    }
  }

  function toggleCandidate(candidateId) {
    setSelectedCandidateIds((current) => current.includes(candidateId) ? current.filter((id) => id !== candidateId) : [...current, candidateId]);
  }

  function toggleAllCandidates() {
    const eligibleIds = candidates.filter((candidate) => ["needs_review", "conflict", "not_found", "failed"].includes(candidate.status) && candidate.decision == null && candidate.source_url).map((candidate) => candidate.id);
    const allSelected = eligibleIds.length && eligibleIds.every((id) => selectedCandidateIds.includes(id));
    setSelectedCandidateIds(allSelected ? [] : eligibleIds);
  }

  async function approveSelected() {
    const selected = candidates.filter((candidate) => selectedCandidateIds.includes(candidate.id) && isBulkApprovable(candidate));
    setBulkApproving(true);
    let approved = 0;
    try {
      for (const candidate of selected) {
        await localDataApi.reviewEnrichmentCandidate(candidate.id, { decision: "approve", ...candidateReviewValues(candidate) });
        approved += 1;
      }
      setSelectedCandidateIds([]);
      setBulkConfirmCount(0);
      setMessage(`${approved.toLocaleString()} selected candidates were approved and promoted. Compatibility discovery is continuing in the background.`);
      await refresh(); await loadCandidates();
    } catch (requestError) {
      setBulkConfirmCount(0);
      setError(`${approved.toLocaleString()} records were approved before the process stopped. ${requestError.message}`);
      await refresh(); await loadCandidates();
    } finally {
      setBulkApproving(false);
    }
  }

  async function exportMaster() {
    try {
      const result = await localDataApi.exportMaster();
      setMessage(`Master exports saved locally: ${result.exports.map((item) => `${item.filename} (${formatBytes(item.bytes)})`).join(" and ")}`);
    } catch (requestError) { setError(requestError.message); }
  }

  const featuredJob = jobs.find((job) => ["queued", "running"].includes(job.status)) || jobs[0];
  const canonicalCompleteness = Number(quality.total_parts) ? Math.round(((Number(quality.total_parts) - Number(quality.incomplete_parts)) / Number(quality.total_parts)) * 100) : 0;
  const vehicleMappingCoverage = Number(quality.total_applications) ? Math.round((Number(quality.mapped_applications) / Number(quality.total_applications)) * 100) : 0;
  const eligibleCandidateIds = candidates.filter((candidate) => ["needs_review", "conflict", "not_found", "failed"].includes(candidate.status) && candidate.decision == null && candidate.source_url).map((candidate) => candidate.id);
  const allVisibleSelected = Boolean(eligibleCandidateIds.length) && eligibleCandidateIds.every((id) => selectedCandidateIds.includes(id));

  if (connected === null) return <div className="grid min-h-64 place-items-center rounded-2xl border border-slate-200 bg-white"><LoaderCircle className="animate-spin text-brand-600" size={28} /></div>;
  if (!connected) return <LocalWorkspaceUnavailable onRetry={refresh} />;

  return <div className="space-y-6">
    <EnrichmentJourney job={featuredJob} stats={stats} />

    <TransformationShowcase data={transformation} jobs={jobs} selectedJobId={selectedJobId} loading={transformationLoading} onSelectJob={setSelectedJobId} onSelectExample={loadTransformation} />

    <FullDatasetPipeline />

    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      {[{ label: "Canonical parts", value: stats.parts }, { label: "New product facts", value: stats.candidate_attribute_facts }, { label: "Variant families", value: stats.families }, { label: "Compatibility fitments", value: stats.compatibility_fitments }, { label: "Part applications", value: stats.applications }].map((metric) => <article key={metric.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-panel"><p className="text-sm font-medium text-slate-500">{metric.label}</p><p className="mt-2 text-3xl font-bold">{Number(metric.value || 0).toLocaleString()}</p></article>)}
    </section>

    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-panel sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="flex items-center gap-2 text-lg font-semibold"><BadgeCheck className="text-emerald-600" size={21} />Master data quality</h3><p className="mt-1 text-sm text-slate-500">Integrity checks separate true data problems from optional fitment details that may not apply to every part.</p></div><span className={`rounded-full px-3 py-1.5 text-xs font-bold ${Number(quality.duplicate_part_keys) || Number(quality.incomplete_parts) ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>{Number(quality.duplicate_part_keys) || Number(quality.incomplete_parts) ? "Needs attention" : "Core master is clean"}</span></div><div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><div className="rounded-xl bg-emerald-50 p-4"><p className="text-xs font-bold uppercase tracking-wide text-emerald-700">Core completeness</p><p className="mt-1 text-2xl font-bold text-emerald-950">{canonicalCompleteness}%</p><p className="mt-1 text-xs text-emerald-700">{Number(quality.incomplete_parts).toLocaleString()} incomplete canonical parts</p></div><div className="rounded-xl bg-blue-50 p-4"><p className="text-xs font-bold uppercase tracking-wide text-blue-700">Duplicate part keys</p><p className="mt-1 text-2xl font-bold text-blue-950">{Number(quality.duplicate_part_keys).toLocaleString()}</p><p className="mt-1 text-xs text-blue-700">Manufacturer + normalized OEM number</p></div><div className="rounded-xl bg-violet-50 p-4"><p className="text-xs font-bold uppercase tracking-wide text-violet-700">Vehicle mapping</p><p className="mt-1 text-2xl font-bold text-violet-950">{vehicleMappingCoverage}%</p><p className="mt-1 text-xs text-violet-700">{Number(quality.mapped_applications).toLocaleString()} of {Number(quality.total_applications).toLocaleString()} applications</p></div><div className="rounded-xl bg-amber-50 p-4"><p className="text-xs font-bold uppercase tracking-wide text-amber-700">Awaiting review</p><p className="mt-1 text-2xl font-bold text-amber-950">{Number(quality.awaiting_review).toLocaleString()}</p><p className="mt-1 text-xs text-amber-700">Held outside the canonical master</p></div></div><p className="mt-4 text-xs leading-5 text-slate-500">Optional evidence coverage: {Number(quality.applications_with_side).toLocaleString()} applications have a confirmed side, {Number(quality.applications_with_position).toLocaleString()} have a position, {Number(quality.compatibility_fitments).toLocaleString()} compatibility fitments are verified, and {Number(quality.meaningful_variant_attributes).toLocaleString()} meaningful variant attributes are stored. Missing optional fields are not treated as duplicates or invented.</p></section>

    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-panel sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h3 className="flex items-center gap-2 text-lg font-semibold"><SearchCheck className="text-brand-600" size={21} />Start a safe test batch</h3><p className="mt-1 max-w-3xl text-sm text-slate-500">The worker deduplicates candidates, checks their source pages, and auto-promotes only high-confidence evidence. Begin with 1,000 unique parts.</p></div><button type="button" onClick={exportMaster} disabled={!Number(stats.parts)} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"><Download size={17} />Export master CSVs</button></div>
      <form onSubmit={startJob} className="mt-5 grid gap-3 lg:grid-cols-6">
        <label className="text-sm font-medium text-slate-700 lg:col-span-2">Dataset<select value={form.datasetId} onChange={(event) => setForm((current) => ({ ...current, datasetId: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"><option value="">Select imported data…</option>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name} · {Number(dataset.row_count).toLocaleString()} rows</option>)}</select><ControlHint>The imported CSV whose rows will be prepared for evidence review.</ControlHint></label>
        <label className="text-sm font-medium text-slate-700">Candidates<input type="number" min="1" max="10000" value={form.requestedCandidates} onChange={(event) => setForm((current) => ({ ...current, requestedCandidates: Number(event.target.value) }))} className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5" /><ControlHint>Maximum unique parts to prepare from the selected source.</ControlHint></label>
        <label className="text-sm font-medium text-slate-700">Start after row<input type="number" min="0" value={form.startRowId} onChange={(event) => setForm((current) => ({ ...current, startRowId: Number(event.target.value) }))} className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5" /><ControlHint>Skip earlier source rows when continuing a large CSV. Use 0 for the beginning.</ControlHint></label>
        <label className="text-sm font-medium text-slate-700">Batch size<input type="number" min="1" max="50" value={form.batchSize} onChange={(event) => setForm((current) => ({ ...current, batchSize: Number(event.target.value) }))} className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5" /><ControlHint>Rows processed per worker cycle. Smaller batches are gentler on a limited Mac.</ControlHint></label>
        <button title="Start a resumable background job with the limits above." disabled={starting || !form.datasetId || hasActiveJob} className="mt-auto inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{starting ? <LoaderCircle className="animate-spin" size={17} /> : <Play size={17} />}Start batch</button>
      </form>
      {hasActiveJob && <p className="mt-3 text-xs font-medium text-amber-700">Finish or pause the active job before starting another batch.</p>}
    </section>

    <section className="rounded-2xl border border-slate-200 bg-white shadow-panel">
      <header className={`flex items-center justify-between px-5 py-4 ${jobsExpanded ? "border-b border-slate-200" : ""}`}><button type="button" onClick={() => setJobsExpanded((current) => !current)} className="flex min-w-0 flex-1 items-center gap-3 text-left"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600">{jobsExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</span><div><h3 className="font-semibold">Background jobs <span className="ml-1 text-sm font-medium text-slate-400">({jobs.length})</span></h3><p className="mt-1 text-sm text-slate-500">{jobsExpanded ? "Jobs persist in DuckDB and resume safely after restarting the local service." : featuredJob ? `${featuredJob.name} · ${featuredJob.status.replaceAll("_", " ")}` : "No enrichment jobs yet."}</p></div></button><button type="button" onClick={refresh} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Refresh background jobs"><RefreshCw size={17} /></button></header>
      {jobsExpanded && (jobs.length ? <div className="divide-y divide-slate-100">{jobs.map((job) => {
        const processed = Number(job.processed_count || 0); const total = Number(job.queued_count || 0); const percent = total ? Math.round((processed / total) * 100) : 100;
        return <div key={job.id} onClick={() => setSelectedJobId(job.id)} className={`grid w-full cursor-pointer gap-4 px-5 py-4 text-left lg:grid-cols-[1fr_1fr_auto] lg:items-center ${selectedJobId === job.id ? "bg-brand-50/50" : "hover:bg-slate-50"}`}><div><div className="flex flex-wrap items-center gap-2"><p className="font-semibold text-slate-800">{job.name}</p><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone(job.status)}`}>{job.status.replaceAll("_", " ")}</span></div><p className="mt-1 text-xs text-slate-500">{job.dataset_name || "Removed dataset"} · Rows {Number(job.start_row_id || 0).toLocaleString()}–{Number(job.last_source_row_id || 0).toLocaleString()}</p>{Number(job.attribute_fact_count || 0) > 0 && <p className="mt-1 text-xs font-bold text-emerald-700">{Number(job.attribute_fact_count).toLocaleString()} product facts found across {Number(job.attributed_candidate_count).toLocaleString()} rows</p>}</div><div><div className="flex justify-between text-xs text-slate-500"><span>{processed.toLocaleString()} / {total.toLocaleString()}</span><span>{percent}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-brand-500" style={{ width: `${percent}%` }} /></div><p className="mt-2 text-xs text-slate-500">{Number(job.enriched_count).toLocaleString()} accepted · {Number(job.review_count).toLocaleString()} review · {Number(job.conflict_count).toLocaleString()} conflicts</p></div><span onClick={(event) => event.stopPropagation()}>{["running", "queued"].includes(job.status) ? <button type="button" onClick={() => controlJob(job, "pause")} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold"><Pause size={15} />Pause</button> : ["paused", "failed"].includes(job.status) ? <button type="button" onClick={() => controlJob(job, "resume")} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold"><Play size={15} />Resume</button> : <span className="flex flex-wrap justify-end gap-2"><button type="button" onClick={() => reprocessReview(job)} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold"><RefreshCw size={15} />Recheck review</button><button type="button" onClick={() => prepareNextBatch(job)} className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-3 py-2 text-sm font-semibold text-white"><Play size={15} />Next rows</button></span>}</span></div>;
      })}</div> : <div className="px-6 py-12 text-center text-sm text-slate-500">No enrichment jobs yet.</div>)}
    </section>

    <section className="rounded-2xl border border-slate-200 bg-white shadow-panel">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 px-5 py-4"><div><h3 className="font-semibold">Evidence review</h3><p className="mt-1 text-sm text-slate-500">{Number(candidateTotal).toLocaleString()} matching candidates; showing up to 200.{Object.values(appliedReviewFilters).some(Boolean) ? " Searching across all background jobs." : ""}</p></div><div className="flex flex-wrap items-center gap-2">{selectedCandidateIds.length > 0 && <><button type="button" onClick={fetchSelectedEvidence} className="inline-flex items-center gap-2 rounded-xl border border-cyan-300 bg-cyan-50 px-3 py-2 text-sm font-bold text-cyan-800"><Globe2 size={16} />Fetch source data ({selectedCandidateIds.length})</button><button type="button" onClick={() => setBulkConfirmCount(selectedCandidateIds.length)} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-3 py-2 text-sm font-bold text-white"><ListChecks size={16} />Approve selected ({selectedCandidateIds.length})</button></>}<select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setSelectedCandidateIds([]); }} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"><option value="">All statuses</option>{REVIEW_STATUSES.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}</select></div></header>
      <form onSubmit={searchReview} className="grid gap-3 border-b border-slate-200 bg-slate-50/70 px-5 py-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_0.7fr_1fr_auto]"><label className="text-xs font-bold uppercase tracking-wide text-slate-500">Search<input value={reviewFilters.q} onChange={(event) => setReviewFilters((current) => ({ ...current, q: event.target.value }))} placeholder="OEM number, description, model, or source row" className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal placeholder:text-slate-400" /></label><label className="text-xs font-bold uppercase tracking-wide text-slate-500">Make<input value={reviewFilters.make} onChange={(event) => setReviewFilters((current) => ({ ...current, make: event.target.value }))} placeholder="e.g. Kawasaki" className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal placeholder:text-slate-400" /></label><label className="text-xs font-bold uppercase tracking-wide text-slate-500">Year<input value={reviewFilters.year} onChange={(event) => setReviewFilters((current) => ({ ...current, year: event.target.value }))} placeholder="e.g. 1996" className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal placeholder:text-slate-400" /></label><label className="text-xs font-bold uppercase tracking-wide text-slate-500">Category<input value={reviewFilters.category} onChange={(event) => setReviewFilters((current) => ({ ...current, category: event.target.value }))} placeholder="e.g. Mirror" className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal placeholder:text-slate-400" /></label><div className="flex items-end gap-2"><button className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white"><SearchCheck size={16} />Search</button>{Object.values(appliedReviewFilters).some(Boolean) && <button type="button" onClick={clearReviewSearch} className="rounded-xl border border-slate-300 bg-white p-2.5 text-slate-500" aria-label="Clear evidence filters"><X size={16} /></button>}</div><div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-5"><button type="button" onClick={loadMirrorDemo} className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-bold text-violet-700">Load mirror demo</button><span className="text-xs text-slate-500">Automatically searches source row 7012 · Kawasaki · 1996 · Mirror.</span></div>{Object.values(appliedReviewFilters).some(Boolean) && <div className="flex flex-wrap items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 sm:col-span-2 lg:col-span-5"><span className="text-xs font-bold uppercase tracking-wide text-blue-700">Active filters</span>{statusFilter && <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-blue-800">Status: {statusFilter.replaceAll("_", " ")}</span>}{Object.entries(appliedReviewFilters).filter(([, value]) => value).map(([key, value]) => <span key={key} className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-blue-800">{key === "q" ? "Search" : key[0].toUpperCase() + key.slice(1)}: {value}</span>)}<span className="ml-auto text-xs font-medium text-blue-700">Searching all jobs</span></div>}</form>
      <div className="overflow-x-auto"><table className="min-w-full divide-y divide-slate-200 text-sm"><thead className="bg-slate-50"><tr><th className="px-4 py-3 text-left"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllCandidates} disabled={!eligibleCandidateIds.length} aria-label="Select all visible candidates" className="h-4 w-4 rounded border-slate-300 text-emerald-600" /></th>{["Status", "OEM Part Number", "Description / Variant", "Side / Position", "Make", "Year", "Vehicle / Assembly", "Confidence", ""].map((heading) => <th key={heading} className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{heading}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{candidates.map((candidate) => <tr key={candidate.id} className={selectedCandidateIds.includes(candidate.id) ? "bg-emerald-50/70" : "hover:bg-slate-50"}><td className="px-4 py-3"><input type="checkbox" checked={selectedCandidateIds.includes(candidate.id)} onChange={() => toggleCandidate(candidate.id)} disabled={!eligibleCandidateIds.includes(candidate.id)} aria-label={`Select ${normalizeCandidateNumber(candidate) || "candidate"}`} className="h-4 w-4 rounded border-slate-300 text-emerald-600" /></td><td className="px-4 py-3"><span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone(candidate.status)}`}>{candidate.status.replaceAll("_", " ")}</span></td><td className="whitespace-nowrap px-4 py-3 font-mono font-semibold text-brand-700">{candidate.enriched_part_number || candidate.part_number_raw || "Missing"}</td><td className="max-w-96 px-4 py-3 text-slate-600"><p className="truncate" title={candidate.enriched_description || candidate.description_raw || ""}>{candidate.enriched_description || candidate.description_raw || "—"}</p>{(candidate.family_name || candidate.variant_summary) && <p className="mt-1 truncate text-xs font-semibold text-violet-700" title={[candidate.family_name, candidate.variant_summary].filter(Boolean).join(" · ")}>{[candidate.family_name, candidate.variant_summary].filter(Boolean).join(" · ")}</p>}{Number(candidate.extracted_attribute_count || 0) > 0 && <span className="mt-1 inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-black text-emerald-700">{Number(candidate.extracted_attribute_count)} product facts</span>}</td><td className="whitespace-nowrap px-4 py-3 text-slate-600">{[candidate.side, candidate.position].filter(Boolean).join(" · ") || "—"}</td><td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-700">{candidate.vehicle_make || candidate.manufacturer_raw || "—"}</td><td className="whitespace-nowrap px-4 py-3 text-slate-600">{candidate.vehicle_year || candidate.year || "—"}</td><td className="max-w-72 px-4 py-3 text-slate-500"><p className="truncate" title={candidate.vehicle_model || candidate.model || ""}>{candidate.vehicle_model || candidate.model || "—"}</p>{candidate.assembly && <p className="mt-1 truncate text-xs" title={candidate.assembly}>{candidate.assembly}</p>}</td><td className="px-4 py-3 font-semibold">{Math.round(Number(candidate.confidence || 0) * 100)}%</td><td className="px-4 py-3"><button type="button" onClick={() => setReviewing(candidate)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold">Review</button></td></tr>)}</tbody></table>{!candidates.length && <div className="px-6 py-12 text-center text-sm text-slate-500">No candidates match this job and status.</div>}</div>
    </section>
    {reviewing && <ReviewModal candidate={reviewing} onClose={() => setReviewing(null)} onDecision={decideCandidate} />}
    <ConfirmDialog count={bulkConfirmCount} busy={bulkApproving} onCancel={() => setBulkConfirmCount(0)} onConfirm={approveSelected} />
    <FeedbackDialog type="error" message={error} onClose={() => setError("")} />
    {!error && <FeedbackDialog type="success" message={message} onClose={() => setMessage("")} />}
  </div>;
}
