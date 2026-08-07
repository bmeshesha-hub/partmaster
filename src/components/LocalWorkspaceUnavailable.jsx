import { AlertTriangle, ExternalLink, HardDrive, RefreshCw } from "lucide-react";

const LOCAL_WORKSPACE_URL = "http://127.0.0.1:5173/partmaster/";

export default function LocalWorkspaceUnavailable({ onRetry }) {
  const published = typeof window !== "undefined" && window.location.hostname.endsWith("github.io");

  if (published) {
    return <section className="overflow-hidden rounded-3xl border border-blue-200 bg-white shadow-panel">
      <div className="bg-gradient-to-br from-blue-950 via-brand-900 to-cyan-800 px-6 py-7 text-white sm:px-8"><span className="grid h-14 w-14 place-items-center rounded-2xl bg-white/15"><HardDrive size={28} /></span><h3 className="mt-5 text-2xl font-bold">Open your private Mac workspace</h3><p className="mt-2 max-w-2xl text-sm leading-6 text-blue-100">GitHub Pages hosts the public interface. Your 53-million-row database and background worker stay safely on this Mac and open in a separate local tab.</p></div>
      <div className="grid gap-5 px-6 py-6 sm:px-8 lg:grid-cols-[1fr_auto] lg:items-end"><div><p className="text-sm font-bold text-slate-900">First, start Partmaster from Terminal:</p><pre className="mt-3 overflow-x-auto rounded-xl bg-slate-950 p-4 text-sm text-slate-100">npm run dev:local</pre><p className="mt-3 text-xs leading-5 text-slate-500">Keep Terminal running. Then use the button to enter the full Local data and Enrichment workspace.</p></div><a href={LOCAL_WORKSPACE_URL} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-brand-600/20 hover:bg-brand-700"><ExternalLink size={17} />Open local workspace</a></div>
    </section>;
  }

  return <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6 sm:p-8"><AlertTriangle className="text-amber-600" size={34} /><h3 className="mt-4 text-lg font-semibold text-amber-950">Local data service is not running</h3><p className="mt-2 max-w-2xl text-sm leading-6 text-amber-800">Start the local worker and web interface together from the Partmaster directory:</p><pre className="mt-4 overflow-x-auto rounded-xl bg-slate-950 p-4 text-sm text-slate-100">npm run dev:local</pre><button type="button" onClick={onRetry} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-amber-700 px-4 py-2 text-sm font-semibold text-white"><RefreshCw size={16} />Check again</button></section>;
}
