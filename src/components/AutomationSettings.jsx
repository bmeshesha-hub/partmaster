import { AlarmClock, CalendarClock, CirclePause, CirclePlay, HardDrive, LoaderCircle, Play, RefreshCw, Timer, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { localDataApi } from "../utils/localDataApi.js";

const LOCAL_APP_URL = "http://127.0.0.1:5173/partmaster/";
const DEFAULT_FORM = {
  name: "Nightly enrichment",
  timing: "daily",
  timeOfDay: "22:00",
  runAt: "",
  onlineBudget: 10000,
  datasetId: "",
  runAllRemaining: false,
};

function number(value) { return Number(value || 0).toLocaleString(); }

function localDateTimeInput() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function displayDate(value) {
  if (!value) return "—";
  const parsed = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export default function AutomationSettings() {
  const [available, setAvailable] = useState(null);
  const [form, setForm] = useState(() => ({ ...DEFAULT_FORM, runAt: localDateTimeInput() }));
  const [sources, setSources] = useState([]);
  const [datasets, setDatasets] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [rowSchedules, setRowSchedules] = useState([]);
  const [rowForm, setRowForm] = useState({ name: "Resumable row enrichment", datasetId: "", batchSize: 1000, intervalMinutes: 20 });
  const [activeJob, setActiveJob] = useState(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState({ type: "", message: "" });

  const load = useCallback(async () => {
    try {
      const health = await localDataApi.health();
      if (!health?.ok) throw new Error("Local data service is unavailable.");
      const [scheduleResult, sourceResult, datasetResult, rowScheduleResult] = await Promise.all([localDataApi.pipelineSchedules(), localDataApi.pipelineSources(), localDataApi.datasets(), localDataApi.enrichmentSchedules()]);
      setSchedules(scheduleResult.schedules || []);
      setActiveJob(scheduleResult.activeJob || null);
      setSources((sourceResult.sources || []).filter((source) => source.dataset_id && Number(source.pending_source_pages || 0) > 0));
      setDatasets(datasetResult.datasets || []);
      setRowSchedules(rowScheduleResult.schedules || []);
      setAvailable(true);
    } catch {
      setAvailable(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!available || !activeJob) return undefined;
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [activeJob, available, load]);

  const selectedSource = useMemo(() => sources.find((source) => String(source.dataset_id) === form.datasetId), [form.datasetId, sources]);
  const scopeLabel = selectedSource?.source_file || "All raw CSV sources";

  function update(field, value) { setForm((current) => ({ ...current, [field]: value })); }
  function updateRow(field, value) { setRowForm((current) => ({ ...current, [field]: value })); }

  async function createRowSchedule(event) {
    event.preventDefault();
    if (!rowForm.datasetId) { setNotice({ type: "error", message: "Choose an imported dataset for the row schedule." }); return; }
    setBusy("row-create"); setNotice({ type: "", message: "" });
    try {
      await localDataApi.createEnrichmentSchedule({ ...rowForm, batchSize: Number(rowForm.batchSize), intervalMinutes: Number(rowForm.intervalMinutes) });
      setNotice({ type: "success", message: `Row schedule created: up to ${number(rowForm.batchSize)} rows every ${number(rowForm.intervalMinutes)} minutes. The first batch will start shortly.` });
      await load();
    } catch (error) { setNotice({ type: "error", message: error.message }); }
    finally { setBusy(""); }
  }

  async function toggleRowSchedule(schedule) {
    setBusy(schedule.id); setNotice({ type: "", message: "" });
    try { await localDataApi.updateEnrichmentSchedule(schedule.id, { enabled: !schedule.enabled }); await load(); }
    catch (error) { setNotice({ type: "error", message: error.message }); }
    finally { setBusy(""); }
  }

  async function runRowSchedule(schedule) {
    setBusy(schedule.id); setNotice({ type: "", message: "" });
    try { const result = await localDataApi.runEnrichmentSchedule(schedule.id); setNotice({ type: "success", message: result.jobId ? `${schedule.name} started the next row batch.` : "No remaining rows were found." }); await load(); }
    catch (error) { setNotice({ type: "error", message: error.message }); }
    finally { setBusy(""); }
  }

  async function removeRowSchedule(schedule) {
    if (!window.confirm(`Delete “${schedule.name}”? Completed row work will remain saved.`)) return;
    setBusy(schedule.id);
    try { await localDataApi.deleteEnrichmentSchedule(schedule.id); await load(); }
    catch (error) { setNotice({ type: "error", message: error.message }); }
    finally { setBusy(""); }
  }

  async function submit(event) {
    event.preventDefault();
    setBusy("create"); setNotice({ type: "", message: "" });
    const options = {
      name: form.name.trim() || (form.timing === "daily" ? "Nightly enrichment" : "Ad-hoc enrichment"),
      onlineBudget: Number(form.onlineBudget),
      datasetIds: form.datasetId ? [form.datasetId] : [],
      runAllRemaining: form.runAllRemaining,
    };
    try {
      if (form.timing === "now") {
        await localDataApi.startPipeline({ ...options, continueOnline: true, importMissing: false });
        setNotice({ type: "success", message: `${scopeLabel}: enrichment started now. You can close this window; the local worker will continue.` });
      } else {
        await localDataApi.createPipelineSchedule({
          ...options,
          scheduleType: form.timing,
          timeOfDay: form.timeOfDay,
          runAt: form.runAt,
        });
        setNotice({ type: "success", message: form.timing === "daily" ? `Daily enrichment scheduled for ${form.timeOfDay}.` : `One-time enrichment scheduled for ${displayDate(form.runAt)}.` });
      }
      await load();
    } catch (error) {
      setNotice({ type: "error", message: error.message });
    } finally { setBusy(""); }
  }

  async function toggle(schedule) {
    setBusy(schedule.id); setNotice({ type: "", message: "" });
    try { await localDataApi.updatePipelineSchedule(schedule.id, { enabled: !schedule.enabled }); await load(); }
    catch (error) { setNotice({ type: "error", message: error.message }); }
    finally { setBusy(""); }
  }

  async function runNow(schedule) {
    setBusy(schedule.id); setNotice({ type: "", message: "" });
    try {
      const result = await localDataApi.runPipelineSchedule(schedule.id);
      setNotice({ type: "success", message: result.jobId ? `${schedule.name} started now.` : "Nothing is pending for this schedule." });
      await load();
    } catch (error) { setNotice({ type: "error", message: error.message }); }
    finally { setBusy(""); }
  }

  async function remove(schedule) {
    if (!window.confirm(`Delete “${schedule.name}”? This does not delete completed enrichment data.`)) return;
    setBusy(schedule.id);
    try { await localDataApi.deletePipelineSchedule(schedule.id); await load(); }
    catch (error) { setNotice({ type: "error", message: error.message }); }
    finally { setBusy(""); }
  }

  if (available == null) return <div className="grid min-h-64 place-items-center"><LoaderCircle className="animate-spin text-brand-600" size={28} /></div>;
  if (!available) return <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-950"><HardDrive size={30} /><h3 className="mt-3 text-lg font-bold">Open the local Partmaster app</h3><p className="mt-2 text-sm leading-6">Scheduling runs on this Mac and needs the local data service. Start <code className="rounded bg-white px-1.5 py-0.5">npm run dev:local</code>, then open the local app.</p><a href={LOCAL_APP_URL} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-amber-700 px-4 py-2 text-sm font-bold text-white"><HardDrive size={16} />Open local Partmaster</a></div>;

  return <div className="space-y-6">
    <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><AlarmClock className="text-brand-600" size={21} /><h3 className="font-bold text-ink">Create an enrichment job</h3></div><p className="mt-1 text-sm text-slate-500">Run it now, once at a future time, or every day while this Mac and the local service are awake.</p></div>{activeJob && <span className="inline-flex items-center gap-2 rounded-full bg-blue-100 px-3 py-1.5 text-xs font-bold text-blue-800"><LoaderCircle className="animate-spin" size={14} />{activeJob.name} · {number(activeJob.online_checked)}/{number(activeJob.online_budget)}</span>}</div>
      <form onSubmit={submit} className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-xs font-bold uppercase tracking-wide text-slate-600">Job name<input value={form.name} onChange={(event) => update("name", event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium normal-case tracking-normal" /></label>
        <label className="text-xs font-bold uppercase tracking-wide text-slate-600">Raw CSV scope<select value={form.datasetId} onChange={(event) => update("datasetId", event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium normal-case tracking-normal"><option value="">All raw CSV sources</option>{sources.map((source) => <option key={source.dataset_id} value={source.dataset_id}>{source.source_file} · {number(source.pending_source_pages)} pages left</option>)}</select></label>
        <fieldset className="sm:col-span-2"><legend className="text-xs font-bold uppercase tracking-wide text-slate-600">When should it run?</legend><div className="mt-2 grid gap-2 sm:grid-cols-3">{[["now", "Run now", "Start an ad-hoc job"], ["once", "Schedule once", "One future run"], ["daily", "Every day", "Repeat automatically"]].map(([value, label, detail]) => <label key={value} className={`cursor-pointer rounded-xl border p-3 ${form.timing === value ? "border-brand-500 bg-brand-50 ring-1 ring-brand-300" : "border-slate-200 bg-white"}`}><input type="radio" name="timing" value={value} checked={form.timing === value} onChange={() => update("timing", value)} className="mr-2" /><span className="text-sm font-bold">{label}</span><span className="mt-1 block pl-5 text-xs text-slate-500">{detail}</span></label>)}</div></fieldset>
        {form.timing === "once" && <label className="text-xs font-bold uppercase tracking-wide text-slate-600">Date and time<input type="datetime-local" value={form.runAt} min={localDateTimeInput()} required onChange={(event) => update("runAt", event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium normal-case tracking-normal" /></label>}
        {form.timing === "daily" && <label className="text-xs font-bold uppercase tracking-wide text-slate-600">Daily start time<input type="time" value={form.timeOfDay} required onChange={(event) => update("timeOfDay", event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium normal-case tracking-normal" /></label>}
        <label className="text-xs font-bold uppercase tracking-wide text-slate-600">Pages per run<input type="number" min="1" max="500000" step="250" disabled={form.runAllRemaining} value={form.onlineBudget} onChange={(event) => update("onlineBudget", event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium normal-case tracking-normal disabled:bg-slate-100" /><span className="mt-1 block text-[11px] font-normal normal-case tracking-normal text-slate-500">10,000 is the recommended daily limit.</span></label>
        <label className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:col-span-2"><input type="checkbox" checked={form.runAllRemaining} onChange={(event) => update("runAllRemaining", event.target.checked)} className="mt-0.5" /><span><span className="block text-sm font-bold">Use all pages remaining at run time</span><span className="mt-0.5 block text-xs text-slate-500">The worker still respects the local safety maximum of {number(500000)} pages per run.</span></span></label>
        <div className="flex justify-end sm:col-span-2"><button type="submit" disabled={Boolean(busy) || Boolean(activeJob && form.timing === "now")} className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50">{busy === "create" ? <LoaderCircle className="animate-spin" size={17} /> : form.timing === "now" ? <Play size={17} /> : <CalendarClock size={17} />}{form.timing === "now" ? "Start ad-hoc job" : "Save schedule"}</button></div>
      </form>
    </section>

    {notice.message && <div role={notice.type === "error" ? "alert" : "status"} className={`rounded-xl border px-4 py-3 text-sm font-bold ${notice.type === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>{notice.message}</div>}

    <section className="overflow-hidden rounded-2xl border border-slate-200">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4"><div><h3 className="font-bold text-ink">Saved schedules</h3><p className="mt-1 text-xs text-slate-500">Stored in the local database on this Mac.</p></div><button type="button" onClick={load} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Refresh schedules"><RefreshCw size={17} /></button></header>
      {!schedules.length ? <p className="bg-slate-50 px-5 py-10 text-center text-sm text-slate-500">No scheduled jobs yet.</p> : <div className="divide-y divide-slate-200 bg-white">{schedules.map((schedule) => <article key={schedule.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h4 className="font-bold text-slate-900">{schedule.name}</h4><span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase ${schedule.enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-600"}`}>{schedule.enabled ? "Active" : schedule.schedule_type === "once" && schedule.last_run_at ? "Completed" : "Paused"}</span></div><p className="mt-1 text-xs text-slate-500">{schedule.schedule_type === "daily" ? `Daily at ${schedule.time_of_day}` : `Once · ${displayDate(schedule.run_at)}`} · {schedule.run_all_remaining ? "all remaining pages" : `${number(schedule.online_budget)} pages`} · {schedule.dataset_ids ? "selected CSV" : "all CSVs"}</p><p className="mt-1 text-[11px] text-slate-400">Next: {schedule.enabled ? displayDate(schedule.next_run_at) : "not scheduled"} · Last: {schedule.last_run_at ? `${displayDate(schedule.last_run_at)} (${schedule.job_status || schedule.last_status || "started"})` : "never"}</p>{schedule.job_error && <p className="mt-1 text-xs font-semibold text-red-600">{schedule.job_error}</p>}</div><div className="flex items-center gap-1.5"><button type="button" onClick={() => runNow(schedule)} disabled={Boolean(busy) || Boolean(activeJob)} title="Start this schedule immediately" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40"><CirclePlay size={15} />Run now</button>{schedule.schedule_type === "daily" && <button type="button" onClick={() => toggle(schedule)} disabled={Boolean(busy)} title={schedule.enabled ? "Pause this daily schedule" : "Enable this daily schedule"} className="rounded-lg border border-slate-300 p-2 text-slate-600 hover:bg-slate-50">{schedule.enabled ? <CirclePause size={16} /> : <CirclePlay size={16} />}</button>}<button type="button" onClick={() => remove(schedule)} disabled={Boolean(busy)} title="Delete schedule" className="rounded-lg border border-red-200 p-2 text-red-600 hover:bg-red-50"><Trash2 size={16} /></button></div></article>)}</div>}
    </section>
    <section className="overflow-hidden rounded-2xl border border-cyan-200 bg-cyan-50/40">
      <header className="border-b border-cyan-100 px-5 py-4"><div className="flex items-center gap-2"><Timer className="text-cyan-700" size={20} /><h3 className="font-bold text-ink">Resumable row batches</h3></div><p className="mt-1 text-xs leading-5 text-slate-600">Process a fixed number of source rows, wait between batches, and continue from the saved checkpoint. Completed and remaining counts are shown on the Dashboard and Enrichment pages.</p></header>
      <form onSubmit={createRowSchedule} className="grid gap-3 bg-white p-5 sm:grid-cols-2 lg:grid-cols-5">
        <label className="text-xs font-bold uppercase tracking-wide text-slate-600 lg:col-span-2">Dataset<select value={rowForm.datasetId} onChange={(event) => updateRow("datasetId", event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium normal-case tracking-normal"><option value="">Select imported data…</option>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name} · {number(dataset.row_count)} rows</option>)}</select></label>
        <label className="text-xs font-bold uppercase tracking-wide text-slate-600">Rows per batch<input type="number" min="1" max="10000" value={rowForm.batchSize} onChange={(event) => updateRow("batchSize", event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium normal-case tracking-normal" /></label>
        <label className="text-xs font-bold uppercase tracking-wide text-slate-600">Interval (minutes)<input type="number" min="1" max="1440" value={rowForm.intervalMinutes} onChange={(event) => updateRow("intervalMinutes", event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium normal-case tracking-normal" /></label>
        <button type="submit" disabled={Boolean(busy)} className="mt-auto inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-cyan-800 disabled:opacity-50">{busy === "row-create" ? <LoaderCircle className="animate-spin" size={17} /> : <Timer size={17} />}Create row schedule</button>
      </form>
      {rowSchedules.length ? <div className="divide-y divide-cyan-100 bg-white">{rowSchedules.map((schedule) => <article key={schedule.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h4 className="font-bold text-slate-900">{schedule.name}</h4><span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase ${schedule.enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-600"}`}>{schedule.enabled ? "Active" : "Paused"}</span></div><p className="mt-1 text-xs text-slate-500">{schedule.dataset_name} · {number(schedule.batch_size)} rows every {number(schedule.interval_minutes)} minutes</p><p className="mt-1 text-[11px] text-slate-500"><span className="font-bold text-emerald-700">{number(schedule.processed_rows)} done</span> · <span className="font-bold text-amber-700">{number(schedule.remaining_rows)} remaining</span> · Next: {schedule.enabled ? displayDate(schedule.next_run_at) : "not scheduled"}</p></div><div className="flex items-center gap-1.5"><button type="button" onClick={() => runRowSchedule(schedule)} disabled={Boolean(busy)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40"><CirclePlay size={15} />Run next</button><button type="button" onClick={() => toggleRowSchedule(schedule)} disabled={Boolean(busy)} title={schedule.enabled ? "Pause this row schedule" : "Resume this row schedule"} className="rounded-lg border border-slate-300 p-2 text-slate-600 hover:bg-slate-50 disabled:opacity-40">{schedule.enabled ? <CirclePause size={16} /> : <CirclePlay size={16} />}</button><button type="button" onClick={() => removeRowSchedule(schedule)} disabled={Boolean(busy)} className="rounded-lg border border-red-200 p-2 text-red-600 hover:bg-red-50 disabled:opacity-40"><Trash2 size={16} /></button></div></article>)}</div> : <p className="bg-white px-5 py-8 text-center text-sm text-slate-500">No row schedules yet.</p>}
    </section>
    <p className="rounded-xl bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-800"><strong>Mac requirement:</strong> leave the Mac awake and keep <code>npm run dev:local</code> running. If the service is closed at the scheduled time, an overdue job starts when the service is opened again.</p>
  </div>;
}
