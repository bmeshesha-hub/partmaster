import {
  AlertTriangle,
  BadgeCheck,
  Check,
  Database,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Globe2,
  LoaderCircle,
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

const REVIEW_STATUSES = ["needs_review", "conflict", "not_found", "failed", "enriched", "rejected"];

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** index)).toFixed(index > 1 ? 2 : 1)} ${units[index]}`;
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
    <p className="relative z-10 mt-4 text-center text-xs text-slate-500">Master database now contains {Number(stats.parts || 0).toLocaleString()} unique parts across {Number(stats.families || 0).toLocaleString()} variant families, with {Number(stats.applications || 0).toLocaleString()} verified applications and {Number(stats.cached_pages || 0).toLocaleString()} reusable source pages.</p>
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

function FeatureSelect({ label, value, onChange }) {
  const tone = value === "yes" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : value === "no" ? "border-red-200 bg-red-50 text-red-800" : "border-slate-300 bg-white text-slate-700";
  return <label className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}<select value={value || "unknown"} onChange={(event) => onChange(event.target.value)} className={`mt-1.5 w-full rounded-xl border px-3 py-2.5 text-sm font-semibold normal-case tracking-normal ${tone}`}><option value="unknown">Unknown</option><option value="yes">Yes</option><option value="no">No</option></select></label>;
}

function ReviewModal({ candidate, onClose, onDecision }) {
  const [values, setValues] = useState({
    partNumber: candidate.enriched_part_number || candidate.part_number_raw || "",
    description: candidate.enriched_description || candidate.description_raw || "",
    side: candidate.side || "Unknown",
    position: candidate.position || "",
    locationNotes: candidate.location_notes || "",
    familyName: candidate.family_name || "",
    componentScope: candidate.component_scope || "component",
    heatedState: candidate.heated_state || "unknown",
    autoDimmingState: candidate.auto_dimming_state || "unknown",
    powerFoldingState: candidate.power_folding_state || "unknown",
    memoryState: candidate.memory_state || "unknown",
    blindSpotState: candidate.blind_spot_state || "unknown",
    cameraState: candidate.camera_state || "unknown",
    turnSignalState: candidate.turn_signal_state || "unknown",
    connectorPins: candidate.connector_pins || "",
    requiredOptions: candidate.required_options || "",
    excludedOptions: candidate.excluded_options || "",
    variantSummary: candidate.variant_summary || "",
    fitmentExplanation: candidate.fitment_explanation || "",
    notes: candidate.decision_notes || "",
  });
  const [saving, setSaving] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [comparison, setComparison] = useState({ familyName: "", variants: [] });
  const [comparisonLoading, setComparisonLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setComparisonLoading(true);
    localDataApi.candidateVariants(candidate.id).then((result) => {
      if (active) setComparison(result);
    }).catch(() => {
      if (active) setComparison({ familyName: candidate.family_name || "", variants: [] });
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

  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-4">
    <div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
      <header className="sticky top-0 flex items-start justify-between border-b border-slate-200 bg-white px-5 py-4">
        <div><h3 className="font-semibold">Review enrichment evidence</h3><p className="mt-1 text-xs text-slate-500">Source row {candidate.source_row_id} · Confidence {Math.round(Number(candidate.confidence || 0) * 100)}%</p></div>
        <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><X size={18} /></button>
      </header>
      {reviewError && <div className="mx-5 mt-5 flex items-start gap-3 rounded-2xl border-2 border-red-300 bg-red-50 p-4 text-red-900" role="alert"><AlertTriangle className="mt-0.5 shrink-0 text-red-600" size={22} /><div><p className="font-bold">Could not save this review</p><p className="mt-1 text-sm leading-5">{reviewError}</p><p className="mt-2 text-xs font-semibold text-red-700">Your edits are still here. Correct the issue and try again.</p></div></div>}
      <div className="grid gap-4 p-5 sm:grid-cols-2">
        <label className="text-sm font-medium text-slate-700">OEM Part Number<input value={values.partNumber} onChange={(event) => setValues((current) => ({ ...current, partNumber: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5 font-mono font-normal" /></label>
        <label className="text-sm font-medium text-slate-700">Side<select value={values.side} onChange={(event) => setValues((current) => ({ ...current, side: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 font-normal">{["Unknown", "Left", "Right", "Center", "Universal"].map((side) => <option key={side}>{side}</option>)}</select></label>
        <label className="text-sm font-medium text-slate-700 sm:col-span-2">Description<input value={values.description} onChange={(event) => setValues((current) => ({ ...current, description: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5 font-normal" /></label>
        <label className="text-sm font-medium text-slate-700">Position<input value={values.position} onChange={(event) => setValues((current) => ({ ...current, position: event.target.value }))} placeholder="Position 1, Front Upper…" className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5 font-normal" /></label>
        <label className="text-sm font-medium text-slate-700">Location notes<input value={values.locationNotes} onChange={(event) => setValues((current) => ({ ...current, locationNotes: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5 font-normal" /></label>
        <section className="rounded-2xl border border-violet-200 bg-violet-50/60 p-4 sm:col-span-2">
          <div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-600 text-white"><Sparkles size={19} /></span><div><h4 className="font-bold text-violet-950">Variant configuration</h4><p className="mt-1 text-xs leading-5 text-violet-700">These attributes prevent similar-looking part numbers from being treated as interchangeable when their equipment differs.</p></div></div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500">Part family<input value={values.familyName} onChange={(event) => setValues((current) => ({ ...current, familyName: event.target.value }))} placeholder="Exterior Mirror" className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal" /></label>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500">Component scope<select value={values.componentScope} onChange={(event) => setValues((current) => ({ ...current, componentScope: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal"><option value="assembly">Complete assembly</option><option value="component">Component</option><option value="kit">Kit</option><option value="unknown">Unknown</option></select></label>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FeatureSelect label="Heated" value={values.heatedState} onChange={(value) => setValues((current) => ({ ...current, heatedState: value }))} />
            <FeatureSelect label="Auto dimming" value={values.autoDimmingState} onChange={(value) => setValues((current) => ({ ...current, autoDimmingState: value }))} />
            <FeatureSelect label="Power folding" value={values.powerFoldingState} onChange={(value) => setValues((current) => ({ ...current, powerFoldingState: value }))} />
            <FeatureSelect label="Memory" value={values.memoryState} onChange={(value) => setValues((current) => ({ ...current, memoryState: value }))} />
            <FeatureSelect label="Blind spot" value={values.blindSpotState} onChange={(value) => setValues((current) => ({ ...current, blindSpotState: value }))} />
            <FeatureSelect label="Camera" value={values.cameraState} onChange={(value) => setValues((current) => ({ ...current, cameraState: value }))} />
            <FeatureSelect label="Turn signal" value={values.turnSignalState} onChange={(value) => setValues((current) => ({ ...current, turnSignalState: value }))} />
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500">Connector pins<input value={values.connectorPins} onChange={(event) => setValues((current) => ({ ...current, connectorPins: event.target.value }))} placeholder="e.g. 5" className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal" /></label>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500">Required vehicle options<input value={values.requiredOptions} onChange={(event) => setValues((current) => ({ ...current, requiredOptions: event.target.value }))} placeholder="BMW S430A, S5DFA…" className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal" /></label>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500">Excluded vehicle options<input value={values.excludedOptions} onChange={(event) => setValues((current) => ({ ...current, excludedOptions: event.target.value }))} placeholder="Not with S5DLA…" className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal" /></label>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500 sm:col-span-2">Variant summary<input value={values.variantSummary} onChange={(event) => setValues((current) => ({ ...current, variantSummary: event.target.value }))} placeholder="Heated · Power-fold · 5-pin" className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal" /></label>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500 sm:col-span-2">Why it fits<textarea value={values.fitmentExplanation} onChange={(event) => setValues((current) => ({ ...current, fitmentExplanation: event.target.value }))} rows="2" placeholder="Explain the fitment evidence and any uncertainty." className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal" /></label>
          </div>
        </section>
        <section className="overflow-hidden rounded-2xl border border-slate-200 sm:col-span-2">
          <header className="flex items-center justify-between bg-slate-50 px-4 py-3"><div><h4 className="text-sm font-bold text-slate-800">Compare related variants</h4><p className="mt-0.5 text-xs text-slate-500">Existing {comparison.familyName || values.familyName || "part family"} records</p></div>{comparisonLoading && <LoaderCircle className="animate-spin text-brand-600" size={17} />}</header>
          {!comparisonLoading && comparison.variants?.length ? <div className="overflow-x-auto"><table className="min-w-full text-xs"><thead className="border-y border-slate-200 bg-white text-left uppercase tracking-wide text-slate-500"><tr>{["Part number", "Side", "Heated", "Auto dim", "Folding", "Memory", "Blind spot", "Camera", "Pins"].map((heading) => <th key={heading} className="whitespace-nowrap px-3 py-2">{heading}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{comparison.variants.map((variant) => <tr key={variant.id} className="text-slate-700"><td className="whitespace-nowrap px-3 py-2 font-mono font-bold text-brand-700">{variant.part_number}</td><td className="whitespace-nowrap px-3 py-2">{variant.side || "—"}</td>{["heated", "auto_dimming", "power_folding", "memory", "blind_spot", "camera"].map((key) => <td key={key} className="px-3 py-2 capitalize">{variant[key] || "—"}</td>)}<td className="px-3 py-2">{variant.connector_pins || "—"}</td></tr>)}</tbody></table></div> : !comparisonLoading && <p className="px-4 py-5 text-sm text-slate-500">No related master variants yet. Approving this record will begin the family.</p>}
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
  const [stats, setStats] = useState({ parts: 0, families: 0, applications: 0, attributed_variants: 0, cached_pages: 0, awaiting_review: 0, enriched_candidates: 0 });
  const [selectedJobId, setSelectedJobId] = useState("");
  const [statusFilter, setStatusFilter] = useState("needs_review");
  const [candidates, setCandidates] = useState([]);
  const [candidateTotal, setCandidateTotal] = useState(0);
  const [reviewing, setReviewing] = useState(null);
  const [form, setForm] = useState({ datasetId: "", name: "", requestedCandidates: 1000, startRowId: 0, batchSize: 10, autoAcceptThreshold: 0.94 });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [datasetResult, jobResult, statsResult] = await Promise.all([localDataApi.datasets(), localDataApi.enrichmentJobs(), localDataApi.masterStats()]);
      setConnected(true);
      setDatasets(datasetResult.datasets);
      setJobs(jobResult.jobs);
      setStats(statsResult.stats);
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
      const result = await localDataApi.enrichmentCandidates({ jobId: selectedJobId, status: statusFilter, limit: 200 });
      setCandidates(result.candidates);
      setCandidateTotal(result.total);
    } catch (requestError) {
      setError(requestError.message);
    }
  }, [connected, selectedJobId, statusFilter]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { loadCandidates(); }, [loadCandidates]);

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

  async function exportMaster() {
    try {
      const result = await localDataApi.exportMaster();
      setMessage(`Master exports saved locally: ${result.exports.map((item) => `${item.filename} (${formatBytes(item.bytes)})`).join(" and ")}`);
    } catch (requestError) { setError(requestError.message); }
  }

  const featuredJob = jobs.find((job) => ["queued", "running"].includes(job.status)) || jobs[0];

  if (connected === null) return <div className="grid min-h-64 place-items-center rounded-2xl border border-slate-200 bg-white"><LoaderCircle className="animate-spin text-brand-600" size={28} /></div>;
  if (!connected) return <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6"><AlertTriangle className="text-amber-600" size={32} /><h3 className="mt-4 font-semibold text-amber-950">Local data service is not running</h3><p className="mt-2 text-sm text-amber-800">Start the local worker and web UI together:</p><pre className="mt-4 rounded-xl bg-slate-950 p-4 text-sm text-slate-100">npm run dev:local</pre><button type="button" onClick={refresh} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-amber-700 px-4 py-2 text-sm font-semibold text-white"><RefreshCw size={16} />Check again</button></section>;

  return <div className="space-y-6">
    <EnrichmentJourney job={featuredJob} stats={stats} />

    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {[{ label: "Canonical parts", value: stats.parts }, { label: "Variant families", value: stats.families }, { label: "Attributed variants", value: stats.attributed_variants }, { label: "Part applications", value: stats.applications }].map((metric) => <article key={metric.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-panel"><p className="text-sm font-medium text-slate-500">{metric.label}</p><p className="mt-2 text-3xl font-bold">{Number(metric.value || 0).toLocaleString()}</p></article>)}
    </section>

    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-panel sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h3 className="flex items-center gap-2 text-lg font-semibold"><SearchCheck className="text-brand-600" size={21} />Start a safe test batch</h3><p className="mt-1 max-w-3xl text-sm text-slate-500">The worker deduplicates candidates, checks their source pages, and auto-promotes only high-confidence evidence. Begin with 1,000 unique parts.</p></div><button type="button" onClick={exportMaster} disabled={!Number(stats.parts)} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"><Download size={17} />Export master CSVs</button></div>
      <form onSubmit={startJob} className="mt-5 grid gap-3 lg:grid-cols-6">
        <label className="text-sm font-medium text-slate-700 lg:col-span-2">Dataset<select value={form.datasetId} onChange={(event) => setForm((current) => ({ ...current, datasetId: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"><option value="">Select imported data…</option>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name} · {Number(dataset.row_count).toLocaleString()} rows</option>)}</select></label>
        <label className="text-sm font-medium text-slate-700">Candidates<input type="number" min="1" max="10000" value={form.requestedCandidates} onChange={(event) => setForm((current) => ({ ...current, requestedCandidates: Number(event.target.value) }))} className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5" /></label>
        <label className="text-sm font-medium text-slate-700">Start after row<input type="number" min="0" value={form.startRowId} onChange={(event) => setForm((current) => ({ ...current, startRowId: Number(event.target.value) }))} className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5" /></label>
        <label className="text-sm font-medium text-slate-700">Batch size<input type="number" min="1" max="50" value={form.batchSize} onChange={(event) => setForm((current) => ({ ...current, batchSize: Number(event.target.value) }))} className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5" /></label>
        <button disabled={starting || !form.datasetId || hasActiveJob} className="mt-auto inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{starting ? <LoaderCircle className="animate-spin" size={17} /> : <Play size={17} />}Start batch</button>
      </form>
      {hasActiveJob && <p className="mt-3 text-xs font-medium text-amber-700">Finish or pause the active job before starting another batch.</p>}
    </section>

    <section className="rounded-2xl border border-slate-200 bg-white shadow-panel">
      <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div><h3 className="font-semibold">Background jobs</h3><p className="mt-1 text-sm text-slate-500">Jobs persist in DuckDB and resume safely after restarting the local service.</p></div><button type="button" onClick={refresh} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><RefreshCw size={17} /></button></header>
      {jobs.length ? <div className="divide-y divide-slate-100">{jobs.map((job) => {
        const processed = Number(job.processed_count || 0); const total = Number(job.queued_count || 0); const percent = total ? Math.round((processed / total) * 100) : 100;
        return <div key={job.id} onClick={() => setSelectedJobId(job.id)} className={`grid w-full cursor-pointer gap-4 px-5 py-4 text-left lg:grid-cols-[1fr_1fr_auto] lg:items-center ${selectedJobId === job.id ? "bg-brand-50/50" : "hover:bg-slate-50"}`}><div><div className="flex flex-wrap items-center gap-2"><p className="font-semibold text-slate-800">{job.name}</p><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone(job.status)}`}>{job.status.replaceAll("_", " ")}</span></div><p className="mt-1 text-xs text-slate-500">{job.dataset_name || "Removed dataset"} · Rows {Number(job.start_row_id || 0).toLocaleString()}–{Number(job.last_source_row_id || 0).toLocaleString()}</p></div><div><div className="flex justify-between text-xs text-slate-500"><span>{processed.toLocaleString()} / {total.toLocaleString()}</span><span>{percent}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-brand-500" style={{ width: `${percent}%` }} /></div><p className="mt-2 text-xs text-slate-500">{Number(job.enriched_count).toLocaleString()} accepted · {Number(job.review_count).toLocaleString()} review · {Number(job.conflict_count).toLocaleString()} conflicts</p></div><span onClick={(event) => event.stopPropagation()}>{["running", "queued"].includes(job.status) ? <button type="button" onClick={() => controlJob(job, "pause")} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold"><Pause size={15} />Pause</button> : ["paused", "failed"].includes(job.status) ? <button type="button" onClick={() => controlJob(job, "resume")} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold"><Play size={15} />Resume</button> : <span className="flex flex-wrap justify-end gap-2"><button type="button" onClick={() => reprocessReview(job)} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold"><RefreshCw size={15} />Recheck review</button><button type="button" onClick={() => prepareNextBatch(job)} className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-3 py-2 text-sm font-semibold text-white"><Play size={15} />Next rows</button></span>}</span></div>;
      })}</div> : <div className="px-6 py-12 text-center text-sm text-slate-500">No enrichment jobs yet.</div>}
    </section>

    <section className="rounded-2xl border border-slate-200 bg-white shadow-panel">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 px-5 py-4"><div><h3 className="font-semibold">Evidence review</h3><p className="mt-1 text-sm text-slate-500">{Number(candidateTotal).toLocaleString()} matching candidates; showing up to 200.</p></div><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"><option value="">All statuses</option>{REVIEW_STATUSES.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}</select></header>
      <div className="overflow-x-auto"><table className="min-w-full divide-y divide-slate-200 text-sm"><thead className="bg-slate-50"><tr>{["Status", "OEM Part Number", "Description / Variant", "Side / Position", "Vehicle / Assembly", "Confidence", ""].map((heading) => <th key={heading} className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{heading}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{candidates.map((candidate) => <tr key={candidate.id} className="hover:bg-slate-50"><td className="px-4 py-3"><span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone(candidate.status)}`}>{candidate.status.replaceAll("_", " ")}</span></td><td className="whitespace-nowrap px-4 py-3 font-mono font-semibold text-brand-700">{candidate.enriched_part_number || candidate.part_number_raw || "Missing"}</td><td className="max-w-96 px-4 py-3 text-slate-600"><p className="truncate" title={candidate.enriched_description || candidate.description_raw || ""}>{candidate.enriched_description || candidate.description_raw || "—"}</p>{(candidate.family_name || candidate.variant_summary) && <p className="mt-1 truncate text-xs font-semibold text-violet-700" title={[candidate.family_name, candidate.variant_summary].filter(Boolean).join(" · ")}>{[candidate.family_name, candidate.variant_summary].filter(Boolean).join(" · ")}</p>}</td><td className="whitespace-nowrap px-4 py-3 text-slate-600">{[candidate.side, candidate.position].filter(Boolean).join(" · ") || "—"}</td><td className="max-w-72 truncate px-4 py-3 text-slate-500" title={[candidate.year, candidate.model, candidate.assembly].filter(Boolean).join(" · ")}>{[candidate.year, candidate.model, candidate.assembly].filter(Boolean).join(" · ") || "—"}</td><td className="px-4 py-3 font-semibold">{Math.round(Number(candidate.confidence || 0) * 100)}%</td><td className="px-4 py-3"><button type="button" onClick={() => setReviewing(candidate)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold">Review</button></td></tr>)}</tbody></table>{!candidates.length && <div className="px-6 py-12 text-center text-sm text-slate-500">No candidates match this job and status.</div>}</div>
    </section>
    {reviewing && <ReviewModal candidate={reviewing} onClose={() => setReviewing(null)} onDecision={decideCandidate} />}
    <FeedbackDialog type="error" message={error} onClose={() => setError("")} />
    {!error && <FeedbackDialog type="success" message={message} onClose={() => setMessage("")} />}
  </div>;
}
