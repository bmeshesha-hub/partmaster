import {
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Database,
  FileSearch,
  Gauge,
} from "lucide-react";
import { createElement } from "react";
import { buildPartsLibrary } from "../utils/libraryUtils.js";

function MetricCard({ icon, label, value, detail, tone = "blue" }) {
  const tones = {
    blue: "bg-blue-50 text-blue-700",
    amber: "bg-amber-50 text-amber-700",
    emerald: "bg-emerald-50 text-emerald-700",
    violet: "bg-violet-50 text-violet-700",
  };

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-panel">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-ink">{value.toLocaleString()}</p>
          <p className="mt-1 text-xs text-slate-400">{detail}</p>
        </div>
        <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${tones[tone]}`}>
          {createElement(icon, { size: 21, "aria-hidden": true })}
        </span>
      </div>
    </article>
  );
}

export default function Dashboard({ data, onNavigate }) {
  const library = buildPartsLibrary(data);
  const pending = data.input.length + data.queue.length;
  const completed = library.length;
  const total = pending + completed;
  const progress = total ? Math.round((completed / total) * 100) : 0;
  const recent = library.slice(0, 5);

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl bg-gradient-to-br from-slate-950 via-slate-900 to-brand-900 p-6 text-white shadow-panel sm:p-8">
        <div className="grid gap-8 lg:grid-cols-[1.3fr_0.7fr] lg:items-center">
          <div>
            <p className="text-sm font-semibold text-sky-300">Processing overview</p>
            <h3 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">{progress}% of tracked parts completed</h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">Monitor imports, enrichment review, and finalized part records from one place.</p>
            <div className="mt-6 h-3 overflow-hidden rounded-full bg-white/15" aria-label={`${progress}% complete`}>
              <div className="h-full rounded-full bg-sky-400 transition-all" style={{ width: `${progress}%` }} />
            </div>
            <div className="mt-3 flex justify-between text-xs text-slate-300"><span>{completed.toLocaleString()} complete</span><span>{pending.toLocaleString()} remaining</span></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button type="button" onClick={() => onNavigate("analyze")} className="rounded-xl bg-white px-4 py-4 text-left text-sm font-semibold text-slate-900 hover:bg-sky-50"><FileSearch className="mb-3 text-brand-600" size={21} />Analyze parts<ArrowRight className="mt-3" size={17} /></button>
            <button type="button" onClick={() => onNavigate("library")} className="rounded-xl border border-white/20 bg-white/10 px-4 py-4 text-left text-sm font-semibold text-white hover:bg-white/15"><Database className="mb-3 text-sky-300" size={21} />Open library<ArrowRight className="mt-3" size={17} /></button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Part processing metrics">
        <MetricCard icon={CheckCircle2} label="Parts processed" value={completed} detail="Finalized library records" tone="emerald" />
        <MetricCard icon={ClipboardList} label="Awaiting review" value={data.queue.length} detail="Enriched parts requiring approval" tone="amber" />
        <MetricCard icon={Gauge} label="Waiting to process" value={data.input.length} detail="Raw enrichment requests" tone="violet" />
        <MetricCard icon={Database} label="Completed batches" value={data.analyses.length} detail={`${data.approved.length} individual approvals`} />
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white shadow-panel">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 sm:px-6">
          <div><h3 className="font-semibold text-ink">Recently completed</h3><p className="mt-1 text-sm text-slate-500">Latest parts added to your library</p></div>
          <button type="button" onClick={() => onNavigate("library")} className="inline-flex items-center gap-2 text-sm font-semibold text-brand-700 hover:text-brand-800">View full library <ArrowRight size={16} /></button>
        </div>
        {recent.length ? (
          <div className="divide-y divide-slate-100">{recent.map((part) => <div key={part.id} className="grid gap-2 px-5 py-4 sm:grid-cols-[1fr_0.8fr_auto] sm:items-center sm:px-6"><div><p className="font-medium text-ink">{part.description}</p><p className="mt-1 text-xs text-slate-500">{part.source_name}</p></div><p className="font-mono text-sm text-slate-700">{part.oem_part_number || "No OEM number"}</p><span className="text-xs text-slate-400">{part.completed_at ? new Date(part.completed_at).toLocaleDateString() : "—"}</span></div>)}</div>
        ) : (
          <div className="px-6 py-12 text-center"><Database className="mx-auto text-slate-300" size={34} /><p className="mt-3 text-sm font-medium text-slate-600">No completed parts yet</p><p className="mt-1 text-sm text-slate-400">Finish an analysis or approve a queued part to populate the library.</p></div>
        )}
      </section>
    </div>
  );
}
