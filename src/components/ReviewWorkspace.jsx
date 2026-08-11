import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Check,
  ChevronRight,
  CircleHelp,
  Filter,
  Layers3,
  ListChecks,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Tags,
  X,
} from "lucide-react";
import { createElement, useCallback, useEffect, useMemo, useState } from "react";
import { localDataApi } from "../utils/localDataApi.js";
import { candidateReviewValues } from "../utils/reviewUtils.js";
import { ReviewModal } from "./EnrichmentManager.jsx";
import LocalWorkspaceUnavailable from "./LocalWorkspaceUnavailable.jsx";

const STATUS_OPTIONS = [
  ["", "All attention types"],
  ["needs_review", "Ready for human review"],
  ["conflict", "Conflicting evidence"],
  ["not_found", "Part number not found"],
  ["failed", "Source check failed"],
];

function number(value) { return Number(value || 0).toLocaleString(); }
function partNumber(candidate) { return String(candidate.enriched_part_number || candidate.part_number_raw || "").trim(); }
function approvable(candidate) { return ["needs_review", "conflict"].includes(candidate.status) && Boolean(partNumber(candidate)); }
function statusLabel(status) { return ({ needs_review: "Review", conflict: "Conflict", not_found: "Not found", failed: "Failed" })[status] || String(status).replaceAll("_", " "); }
function statusClass(status) {
  if (status === "conflict" || status === "failed") return "border-red-200 bg-red-50 text-red-700";
  if (status === "not_found") return "border-orange-200 bg-orange-50 text-orange-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}
function attentionExplanation(candidate) {
  const reason = String(candidate.decision || candidate.decision_notes || "").trim();
  if (reason) return reason;
  if (!candidate.side || String(candidate.side).toLowerCase() === "unknown") return "Side is unknown; this is missing information, not necessarily a conflict.";
  return candidate.status === "conflict" ? "Sources or existing variant data disagree and need comparison." : "Human evidence review is required.";
}

function Metric({ label, value, detail, tone }) {
  const tones = { amber: "text-amber-300", red: "text-rose-300", cyan: "text-cyan-300", emerald: "text-emerald-300" };
  return <article className="rounded-2xl border border-white/10 bg-white/[0.07] p-4 backdrop-blur"><p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">{label}</p><p className={`mt-2 text-3xl font-black ${tones[tone]}`}>{number(value)}</p><p className="mt-1 text-xs leading-4 text-slate-400">{detail}</p></article>;
}

function BrandCard({ brand, selected, onSelect }) {
  const confidence = Math.round(Number(brand.average_confidence || 0));
  return <button type="button" onClick={onSelect} className={`group rounded-2xl border p-4 text-left transition hover:-translate-y-0.5 hover:shadow-lg ${selected ? "border-brand-500 bg-brand-50 ring-2 ring-brand-200" : "border-slate-200 bg-white hover:border-brand-200"}`}>
    <div className="flex items-start justify-between gap-3"><span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-slate-900 to-brand-700 text-sm font-black text-white shadow-sm">{String(brand.brand || "?").slice(0, 2).toUpperCase()}</span><span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-black text-amber-700">{number(brand.awaiting_review)} waiting</span></div>
    <h4 className="mt-4 truncate text-lg font-black text-slate-900">{brand.brand}</h4>
    <p className="mt-1 text-xs text-slate-500">{number(brand.categories)} categories · {confidence}% avg. confidence</p>
    <div className="mt-4 grid grid-cols-3 gap-2 text-center"><div className="rounded-lg bg-amber-50 px-2 py-2"><strong className="block text-sm text-amber-800">{number(brand.needs_review)}</strong><span className="text-[9px] font-bold uppercase text-amber-600">Review</span></div><div className="rounded-lg bg-red-50 px-2 py-2"><strong className="block text-sm text-red-800">{number(brand.conflicts)}</strong><span className="text-[9px] font-bold uppercase text-red-600">Conflict</span></div><div className="rounded-lg bg-violet-50 px-2 py-2"><strong className="block text-sm text-violet-800">{number(brand.with_product_facts)}</strong><span className="text-[9px] font-bold uppercase text-violet-600">With facts</span></div></div>
    <span className="mt-4 flex items-center justify-between text-xs font-black text-brand-700">Open brand queue <ChevronRight className="transition group-hover:translate-x-1" size={15} /></span>
  </button>;
}

export default function ReviewWorkspace() {
  const [connected, setConnected] = useState(null);
  const [overview, setOverview] = useState({ summary: {}, brands: [], categories: [], decisions: {} });
  const [candidates, setCandidates] = useState([]);
  const [candidateTotal, setCandidateTotal] = useState(0);
  const [brand, setBrand] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState([]);
  const [reviewing, setReviewing] = useState(null);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [notice, setNotice] = useState({ type: "", message: "" });

  const loadOverview = useCallback(async () => {
    try {
      const health = await localDataApi.health();
      if (!health?.ok) throw new Error("Local data service unavailable");
      setOverview(await localDataApi.reviewOverview());
      setConnected(true);
    } catch {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}data/master-metrics.json`);
        const snapshot = await response.json();
        if (snapshot.review) setOverview(snapshot.review);
      } catch { /* The page still explains how to open the local review workspace. */ }
      setConnected(false);
    }
  }, []);

  const loadQueue = useCallback(async () => {
    if (connected !== true) return;
    setLoadingQueue(true);
    try {
      const result = await localDataApi.enrichmentCandidates({ reviewOnly: true, status, make: brand, category, q: appliedQuery, limit: 200 });
      setCandidates(result.candidates || []);
      setCandidateTotal(result.total || 0);
    } catch (error) { setNotice({ type: "error", message: error.message }); }
    finally { setLoadingQueue(false); }
  }, [appliedQuery, brand, category, connected, status]);

  useEffect(() => { loadOverview(); }, [loadOverview]);
  useEffect(() => { loadQueue(); }, [loadQueue]);
  useEffect(() => { setSelectedIds((current) => current.filter((id) => candidates.some((candidate) => candidate.id === id))); }, [candidates]);

  const eligibleIds = useMemo(() => candidates.filter(approvable).map((candidate) => candidate.id), [candidates]);
  const allSelected = Boolean(eligibleIds.length) && eligibleIds.every((id) => selectedIds.includes(id));

  function selectBrand(nextBrand) {
    setBrand((current) => current === nextBrand ? "" : nextBrand);
    setSelectedIds([]);
    window.setTimeout(() => document.getElementById("brand-review-queue")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  function submitSearch(event) { event.preventDefault(); setAppliedQuery(query.trim()); setSelectedIds([]); }
  function resetFilters() { setBrand(""); setStatus(""); setCategory(""); setQuery(""); setAppliedQuery(""); setSelectedIds([]); }
  function toggle(candidateId) { setSelectedIds((current) => current.includes(candidateId) ? current.filter((id) => id !== candidateId) : [...current, candidateId]); }
  function toggleAll() { setSelectedIds(allSelected ? [] : eligibleIds); }

  async function decideCandidate(decision, values) {
    await localDataApi.reviewEnrichmentCandidate(reviewing.id, { decision, ...values });
    setReviewing(null);
    setNotice({ type: "success", message: decision === "approve" ? "Part approved and promoted into Master." : "Evidence rejected; the original raw row remains preserved." });
    await Promise.all([loadOverview(), loadQueue()]);
  }

  async function approveSelected() {
    const selected = candidates.filter((candidate) => selectedIds.includes(candidate.id));
    if (!selected.length || !window.confirm(`Approve and promote ${selected.length.toLocaleString()} selected records?`)) return;
    setBulkBusy(true); setNotice({ type: "", message: "" });
    let approved = 0;
    try {
      for (const candidate of selected) {
        await localDataApi.reviewEnrichmentCandidate(candidate.id, { decision: "approve", ...candidateReviewValues(candidate) });
        approved += 1;
      }
      setSelectedIds([]);
      setNotice({ type: "success", message: `${number(approved)} records approved and promoted into Master.` });
    } catch (error) {
      setNotice({ type: "error", message: `${number(approved)} records were approved before the process stopped. ${error.message}` });
    } finally {
      setBulkBusy(false);
      await Promise.all([loadOverview(), loadQueue()]);
    }
  }

  async function recheckSelected() {
    const selected = candidates.filter((candidate) => selectedIds.includes(candidate.id));
    if (!selected.length) return;
    const byJob = selected.reduce((groups, candidate) => { (groups[candidate.job_id] ||= []).push(candidate.id); return groups; }, {});
    setBulkBusy(true); setNotice({ type: "", message: "" });
    try {
      for (const [jobId, ids] of Object.entries(byJob)) await localDataApi.reprocessEnrichmentReview(jobId, ids);
      setSelectedIds([]);
      setNotice({ type: "success", message: `${number(selected.length)} selected records queued for source recheck. Existing master records were not changed.` });
    } catch (error) { setNotice({ type: "error", message: error.message }); }
    finally { setBulkBusy(false); await Promise.all([loadOverview(), loadQueue()]); }
  }

  async function rejectSelected() {
    const selected = candidates.filter((candidate) => selectedIds.includes(candidate.id));
    if (!selected.length || !window.confirm(`Reject ${selected.length.toLocaleString()} selected records? Their raw source rows will be preserved.`)) return;
    setBulkBusy(true); setNotice({ type: "", message: "" });
    let rejected = 0;
    try {
      for (const candidate of selected) {
        await localDataApi.reviewEnrichmentCandidate(candidate.id, { decision: "reject", ...candidateReviewValues(candidate) });
        rejected += 1;
      }
      setSelectedIds([]);
      setNotice({ type: "success", message: `${number(rejected)} selected records rejected. Raw source data was preserved.` });
    } catch (error) { setNotice({ type: "error", message: `${number(rejected)} records changed before the process stopped. ${error.message}` }); }
    finally { setBulkBusy(false); await Promise.all([loadOverview(), loadQueue()]); }
  }

  if (connected == null) return <div className="grid min-h-72 place-items-center rounded-3xl border border-slate-200 bg-white"><div className="text-center text-sm font-semibold text-slate-500"><LoaderCircle className="mx-auto mb-3 animate-spin text-brand-600" size={30} />Building the brand review workspace…</div></div>;
  const summary = overview.summary || {};
  const filtersActive = Boolean(brand || status || category || appliedQuery);

  return <div className="space-y-6">
    <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-slate-950 via-indigo-950 to-cyan-950 p-6 text-white shadow-2xl sm:p-8">
      <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-cyan-400/15 blur-3xl" /><div className="absolute -bottom-32 left-1/3 h-72 w-72 rounded-full bg-violet-500/15 blur-3xl" />
      <div className="relative"><div className="flex flex-wrap items-start justify-between gap-6"><div className="max-w-3xl"><p className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.2em] text-cyan-300"><ShieldCheck size={16} />Human + AI quality gate</p><h3 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Review every brand with confidence</h3><p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">AI prepares the evidence. Your team confirms identity, fitment, variants, and product facts before uncertain records enter the trusted Master database.</p></div><div className="text-right"><span className={`inline-flex rounded-full px-3 py-1.5 text-xs font-black ${connected ? "bg-emerald-400 text-emerald-950" : "bg-white/10 text-slate-200"}`}>{connected ? "Live local review data" : "Published review snapshot"}</span><button type="button" onClick={() => Promise.all([loadOverview(), loadQueue()])} className="mt-2 flex items-center gap-2 rounded-xl border border-white/15 bg-white/10 px-4 py-2.5 text-sm font-bold hover:bg-white/15"><RefreshCw size={17} />Refresh review data</button></div></div>
        <div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Awaiting decisions" value={summary.awaiting_review} detail={`Across ${number(summary.brands)} brands`} tone="amber" /><Metric label="Evidence conflicts" value={summary.conflicts} detail="Needs careful comparison" tone="red" /><Metric label="High-confidence ready" value={summary.high_confidence} detail="Fastest records to review" tone="cyan" /><Metric label="Team decisions · 7 days" value={overview.decisions?.decisions_last_7_days} detail={`${number(overview.decisions?.approved)} approved overall`} tone="emerald" /></div>
        <div className="mt-6 grid gap-2 rounded-2xl border border-white/10 bg-black/20 p-3 sm:grid-cols-4">{[[Sparkles, "AI prepares", "Extracts and scores evidence"], [Tags, "Choose a brand", "Focus the team’s expertise"], [CircleHelp, "Human decides", "Correct, approve, or reject"], [BadgeCheck, "Master updates", "Only reviewed facts are promoted"]].map(([Icon, title, detail], index) => <div key={title} className="relative flex items-center gap-3 rounded-xl px-3 py-2"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/10 text-cyan-300">{createElement(Icon, { size: 17 })}</span><div><p className="text-xs font-black">{index + 1}. {title}</p><p className="mt-0.5 text-[10px] text-slate-400">{detail}</p></div>{index < 3 && <ArrowRight className="absolute -right-2 hidden text-slate-600 sm:block" size={14} />}</div>)}</div>
      </div>
    </section>

    {notice.message && <div className={`flex items-start justify-between gap-4 rounded-2xl border-2 px-5 py-4 text-sm font-bold shadow-lg ${notice.type === "error" ? "border-red-300 bg-red-50 text-red-900" : "border-emerald-300 bg-emerald-50 text-emerald-900"}`} role={notice.type === "error" ? "alert" : "status"}><span className="flex items-start gap-2">{notice.type === "error" ? <AlertTriangle className="shrink-0" size={19} /> : <Check className="shrink-0" size={19} />}{notice.message}</span><button type="button" onClick={() => setNotice({ type: "", message: "" })}><X size={18} /></button></div>}

    <section><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-[0.16em] text-brand-700">Brand review rooms</p><h3 className="mt-1 text-2xl font-black text-slate-900">Choose where your expertise is needed</h3><p className="mt-1 text-sm text-slate-500">{connected ? "Each card is a live count from the local evidence queue." : "Published counts show where review work is concentrated; open the local app to decide individual records."}</p></div>{brand && <button type="button" onClick={() => setBrand("")} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700">Show every brand</button>}</div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{(overview.brands || []).map((item) => <BrandCard key={item.brand} brand={item} selected={brand === item.brand} onSelect={() => selectBrand(item.brand)} />)}</div>
    </section>

    {connected ? <section id="brand-review-queue" className="scroll-mt-24 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-panel">
      <header className="border-b border-slate-200 bg-slate-50 px-5 py-5 sm:px-6"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="flex items-center gap-2 text-xs font-black uppercase tracking-wide text-brand-700"><Layers3 size={16} />Evidence decision queue</p><h3 className="mt-1 text-xl font-black">{brand ? `${brand} parts awaiting review` : "All brands awaiting review"}</h3><p className="mt-1 text-sm text-slate-500">{number(candidateTotal)} matching records · showing up to 200 highest recent candidates</p></div>{selectedIds.length > 0 && <div className="flex flex-wrap gap-2"><button type="button" onClick={recheckSelected} disabled={bulkBusy} className="inline-flex items-center gap-2 rounded-xl border border-cyan-300 bg-cyan-50 px-4 py-2.5 text-sm font-black text-cyan-800 disabled:opacity-50"><RefreshCw size={17} />Mass recheck ({number(selectedIds.length)})</button><button type="button" onClick={approveSelected} disabled={bulkBusy} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-black text-white shadow-lg hover:bg-emerald-700 disabled:opacity-50">{bulkBusy ? <LoaderCircle className="animate-spin" size={17} /> : <ListChecks size={17} />}Approve selected ({number(selectedIds.length)})</button><button type="button" onClick={rejectSelected} disabled={bulkBusy} className="inline-flex items-center gap-2 rounded-xl border border-red-300 bg-red-50 px-4 py-2.5 text-sm font-black text-red-700 disabled:opacity-50">Reject selected</button></div>}</div></header>
      <form onSubmit={submitSearch} className="grid gap-3 border-b border-slate-200 px-5 py-4 sm:grid-cols-2 lg:grid-cols-[1.7fr_1fr_1fr_auto]">
        <label className="text-[10px] font-black uppercase tracking-wide text-slate-500">Search evidence<div className="relative mt-1.5"><Search className="absolute left-3 top-2.5 text-slate-400" size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="OEM number, description, model…" className="w-full rounded-xl border border-slate-300 py-2.5 pl-9 pr-3 text-sm font-normal normal-case tracking-normal" /></div></label>
        <label className="text-[10px] font-black uppercase tracking-wide text-slate-500">Attention type<select value={status} onChange={(event) => { setStatus(event.target.value); setSelectedIds([]); }} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal">{STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="text-[10px] font-black uppercase tracking-wide text-slate-500">Category<select value={category} onChange={(event) => { setCategory(event.target.value); setSelectedIds([]); }} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal"><option value="">All categories</option>{(overview.categories || []).map((item) => <option key={item.category} value={item.category}>{item.category} · {number(item.awaiting_review)}</option>)}</select></label>
        <div className="flex items-end gap-2"><button className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white"><Filter size={16} />Apply</button>{filtersActive && <button type="button" onClick={resetFilters} className="rounded-xl border border-slate-300 p-2.5 text-slate-500" aria-label="Clear review filters"><X size={16} /></button>}</div>
      </form>
      {filtersActive && <div className="flex flex-wrap items-center gap-2 border-b border-blue-100 bg-blue-50 px-5 py-3 text-xs font-bold text-blue-800"><span>Active:</span>{brand && <span className="rounded-full bg-white px-2.5 py-1">Brand · {brand}</span>}{status && <span className="rounded-full bg-white px-2.5 py-1">{statusLabel(status)}</span>}{category && <span className="rounded-full bg-white px-2.5 py-1">Category · {category}</span>}{appliedQuery && <span className="rounded-full bg-white px-2.5 py-1">Search · {appliedQuery}</span>}</div>}
      <div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="border-b border-slate-200 bg-white text-left"><tr><th className="px-4 py-3"><input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!eligibleIds.length} aria-label="Select all approvable records" /></th>{["Attention", "Brand", "OEM part number", "Description / category", "Vehicle / assembly", "Facts", "Confidence", "Action"].map((heading) => <th key={heading} className="whitespace-nowrap px-4 py-3 text-[10px] font-black uppercase tracking-wide text-slate-500">{heading}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{candidates.map((candidate) => <tr key={candidate.id} className={selectedIds.includes(candidate.id) ? "bg-emerald-50/70" : "hover:bg-slate-50"}><td className="px-4 py-3"><input type="checkbox" checked={selectedIds.includes(candidate.id)} onChange={() => toggle(candidate.id)} disabled={!approvable(candidate)} aria-label={`Select ${partNumber(candidate) || "candidate"}`} /></td><td className="px-4 py-3"><span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-bold ${statusClass(candidate.status)}`}>{statusLabel(candidate.status)}</span></td><td className="whitespace-nowrap px-4 py-3 font-bold text-slate-800">{candidate.vehicle_make || candidate.manufacturer_raw || "Unknown"}</td><td className="whitespace-nowrap px-4 py-3 font-mono font-black text-brand-700">{partNumber(candidate) || <span className="font-sans text-red-600">Missing</span>}</td><td className="max-w-80 px-4 py-3"><p className="truncate font-semibold text-slate-700" title={candidate.enriched_description || candidate.description_raw || ""}>{candidate.enriched_description || candidate.description_raw || "No description"}</p><p className="mt-1 truncate text-xs font-bold text-violet-700">{candidate.family_name || candidate.assembly || "Unclassified"}{candidate.variant_summary ? ` · ${candidate.variant_summary}` : ""}</p></td><td className="max-w-64 px-4 py-3 text-slate-600"><p className="truncate">{[candidate.vehicle_year || candidate.year, candidate.vehicle_model || candidate.model].filter(Boolean).join(" · ") || "Vehicle not mapped"}</p><p className="mt-1 truncate text-xs text-slate-400">{candidate.assembly || "Assembly unknown"}</p></td><td className="px-4 py-3"><span className={`rounded-full px-2 py-1 text-xs font-black ${Number(candidate.extracted_attribute_count) ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{number(candidate.extracted_attribute_count)} facts</span></td><td className="px-4 py-3"><strong>{Math.round(Number(candidate.confidence || 0) * 100)}%</strong><div className="mt-1 h-1.5 w-16 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${Number(candidate.confidence) >= .85 ? "bg-emerald-500" : Number(candidate.confidence) >= .6 ? "bg-amber-500" : "bg-red-500"}`} style={{ width: `${Math.round(Number(candidate.confidence || 0) * 100)}%` }} /></div></td><td className="px-4 py-3"><button type="button" onClick={() => setReviewing(candidate)} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white hover:bg-brand-700">Review evidence <ChevronRight size={14} /></button></td></tr>)}</tbody></table>
        {loadingQueue && <div className="grid min-h-40 place-items-center"><LoaderCircle className="animate-spin text-brand-600" size={25} /></div>}
        {!loadingQueue && !candidates.length && <div className="px-6 py-16 text-center"><ShieldCheck className="mx-auto text-emerald-600" size={42} /><h4 className="mt-3 text-lg font-black">This review room is clear</h4><p className="mt-1 text-sm text-slate-500">No unresolved evidence matches these filters.</p></div>}
      </div>
    </section> : <div id="brand-review-queue" className="scroll-mt-24"><LocalWorkspaceUnavailable onRetry={loadOverview} /></div>}
    {reviewing && <ReviewModal candidate={reviewing} onClose={() => setReviewing(null)} onDecision={decideCandidate} />}
  </div>;
}
