import {
  AlertCircle,
  BookOpen,
  BrainCircuit,
  Boxes,
  ClipboardCheck,
  FileSearch,
  HardDrive,
  LayoutDashboard,
  Library,
  LoaderCircle,
  RefreshCw,
  SearchCheck,
  Settings,
  TableProperties,
  Workflow,
} from "lucide-react";
import { createElement, useCallback, useEffect, useState } from "react";
import AnalysisWorkflow from "./components/AnalysisWorkflow.jsx";
import AboutPage from "./components/AboutPage.jsx";
import Dashboard from "./components/Dashboard.jsx";
import EnrichmentManager from "./components/EnrichmentManager.jsx";
import GitHubAuth from "./components/GitHubAuth.jsx";
import LocalDataManager from "./components/LocalDataManager.jsx";
import MasterDataPage from "./components/MasterDataPage.jsx";
import PartsLibrary from "./components/PartsLibrary.jsx";
import PartsIntelligence from "./components/PartsIntelligence.jsx";
import ReviewWorkspace from "./components/ReviewWorkspace.jsx";
import ProcessControl from "./components/ProcessControl.jsx";
import {
  DEFAULT_REPOSITORY,
  fetchWorkspaceData,
  saveAnalysisResults,
} from "./utils/githubApi.js";

const TOKEN_STORAGE_KEY = "partmaster.githubToken";
const EMPTY_DATA = { input: [], queue: [], approved: [], analyses: [], headSha: "" };
const NAVIGATION = [
  { id: "dashboard", label: "Dashboard", shortLabel: "Home", icon: LayoutDashboard },
  { id: "processes", label: "Processes", shortLabel: "Process", icon: Workflow },
  { id: "master", label: "Master data", shortLabel: "Master", icon: TableProperties },
  { id: "review", label: "Review", shortLabel: "Review", icon: ClipboardCheck },
  { id: "analyze", label: "Analyze parts", shortLabel: "Analyze", icon: FileSearch },
  { id: "library", label: "Library", shortLabel: "Library", icon: Library },
  { id: "local", label: "Local data", shortLabel: "Local", icon: HardDrive },
  { id: "enrichment", label: "Enrichment", shortLabel: "Enrich", icon: SearchCheck },
  { id: "intelligence", label: "Intelligence", shortLabel: "Smart", icon: BrainCircuit },
  { id: "about", label: "About", shortLabel: "About", icon: BookOpen },
];
const VIEW_COPY = {
  dashboard: ["Operations dashboard", "Part processing progress"],
  processes: ["Operations control", "Monitor and manage every process"],
  master: ["Master data", "Quality metrics and searchable consolidated catalog"],
  review: ["Human review", "Parts awaiting review"],
  analyze: ["Research workflow", "Import and analyze parts"],
  library: ["Completed records", "Parts library"],
  local: ["Mac data workspace", "Large local datasets"],
  enrichment: ["Local background worker", "Enrichment and evidence review"],
  intelligence: ["Parts intelligence", "Search, quality, fitment, relationships, and risk"],
  about: ["How Partmaster works", "Sources, enrichment, evidence, and human review"],
};

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_STORAGE_KEY) || "");
  const [data, setData] = useState(EMPTY_DATA);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState("dashboard");
  const [processMode, setProcessMode] = useState("monitor");
  const [settingsOpen, setSettingsOpen] = useState(() => !localStorage.getItem(TOKEN_STORAGE_KEY));

  const loadWorkspace = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      setData(await fetchWorkspaceData(token));
    } catch (requestError) {
      setError(requestError.message || "Could not load Partmaster data.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  function saveToken(nextToken) {
    if (nextToken) localStorage.setItem(TOKEN_STORAGE_KEY, nextToken);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken(nextToken);
    setData(EMPTY_DATA);
    setError("");
    setSettingsOpen(false);
  }

  async function handleAnalysisSave(analysis) {
    setSaving(true);
    setError("");
    try {
      const saved = await saveAnalysisResults({ token, analysis });
      await loadWorkspace();
      return saved;
    } catch (requestError) {
      setError(requestError.message || "Could not save this analysis. Please try again.");
      return null;
    } finally {
      setSaving(false);
    }
  }

  const [eyebrow, heading] = VIEW_COPY[view];

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-[90rem] items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <button type="button" onClick={() => setView("dashboard")} className="flex items-center gap-3 text-left">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-600 text-white shadow-sm"><Boxes size={22} aria-hidden="true" /></span>
            <span><span className="block text-lg font-bold tracking-tight text-ink">Partmaster</span><span className="block text-xs text-slate-500">Parts intelligence workspace</span></span>
          </button>
          <div className="flex items-center gap-2">
            <nav className="hidden rounded-xl bg-slate-100 p-1 2xl:flex" aria-label="Primary navigation">
              {NAVIGATION.map(({ id, label, icon }) => <button key={id} type="button" onClick={() => setView(id)} className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium ${view === id ? "bg-white text-brand-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>{createElement(icon, { size: 16, "aria-hidden": true })}{label}{id === "processes" && <span className="rounded-full bg-emerald-100 px-1.5 text-[10px] font-black text-emerald-700">LIVE</span>}</button>)}
            </nav>
            <button type="button" onClick={() => setSettingsOpen(true)} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"><Settings size={17} aria-hidden="true" /><span className="hidden sm:inline">Settings</span></button>
          </div>
        </div>
      </header>

      {view === "processes" && <nav className="border-b border-slate-200 bg-white px-4 py-2 shadow-sm" aria-label="Processes submenu"><div className="mx-auto flex max-w-7xl items-center gap-2 sm:px-2"><span className="mr-2 text-xs font-black uppercase tracking-widest text-slate-400">Processes</span><button type="button" onClick={() => setProcessMode("monitor")} className={`rounded-lg px-3 py-1.5 text-sm font-bold ${processMode === "monitor" ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50"}`}>Monitor</button><button type="button" onClick={() => setProcessMode("logs")} className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-bold ${processMode === "logs" ? "bg-slate-950 text-cyan-300" : "text-slate-600 hover:bg-slate-50"}`}><span className="h-2 w-2 rounded-full bg-emerald-400" />Live log</button></div></nav>}

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <nav className="mb-6 grid grid-cols-3 rounded-xl bg-slate-200/70 p-1 sm:grid-cols-5 lg:grid-cols-9 2xl:hidden" aria-label="Primary navigation">
          {NAVIGATION.map(({ id, shortLabel, icon }) => <button key={id} type="button" onClick={() => setView(id)} className={`flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] font-medium sm:flex-row sm:justify-center sm:text-sm ${view === id ? "bg-white text-brand-700 shadow-sm" : "text-slate-600"}`}>{createElement(icon, { size: 16, "aria-hidden": true })}{shortLabel}</button>)}
        </nav>

        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div><p className="text-sm font-semibold text-brand-700">{eyebrow}</p><h2 className="mt-1 text-2xl font-bold tracking-tight text-ink">{heading}</h2><p className="mt-2 text-sm text-slate-500">{view === "about" ? "A transparent guide for operators, reviewers, and partners" : view === "master" ? "Public aggregate metrics · detailed records stay on this Mac" : ["review", "local", "enrichment", "intelligence"].includes(view) ? "Stored only in partmaster/local_data on this Mac" : `${DEFAULT_REPOSITORY.owner}/${DEFAULT_REPOSITORY.repo} · ${DEFAULT_REPOSITORY.branch}`}</p></div>
          {!["review", "analyze", "master", "local", "enrichment", "about"].includes(view) && <div className="flex items-center gap-3"><span className="rounded-full bg-white px-3 py-1.5 text-sm font-medium text-slate-600 shadow-sm ring-1 ring-slate-200">{data.queue.length} pending</span><button type="button" onClick={loadWorkspace} disabled={!token || loading} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"><RefreshCw className={loading ? "animate-spin" : ""} size={16} />Refresh</button></div>}
        </div>

        {error && <div className="mb-5 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert"><AlertCircle className="mt-0.5 shrink-0" size={18} /><span>{error}</span></div>}

        {view === "processes" ? (
          <ProcessControl mode={processMode} onModeChange={setProcessMode} />
        ) : view === "master" ? (
          <MasterDataPage />
        ) : view === "review" ? (
          <ReviewWorkspace />
        ) : view === "local" ? (
          <LocalDataManager />
        ) : view === "enrichment" ? (
          <EnrichmentManager />
        ) : view === "intelligence" ? (
          <PartsIntelligence />
        ) : view === "about" ? (
          <AboutPage />
        ) : view === "dashboard" ? (
          <Dashboard data={data} onNavigate={setView} />
        ) : !token ? (
          <div className="rounded-2xl border border-slate-200 bg-white px-6 py-16 text-center shadow-panel"><Settings className="mx-auto text-brand-600" size={40} /><h2 className="mt-4 text-lg font-semibold">Connect the data repository</h2><p className="mx-auto mt-2 max-w-md text-sm text-slate-500">Add a GitHub personal access token to load your dashboard, analyses, and completed-parts library.</p><button type="button" onClick={() => setSettingsOpen(true)} className="mt-5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">Open settings</button></div>
        ) : loading && !data.headSha ? (
          <div className="grid min-h-64 place-items-center rounded-2xl border border-slate-200 bg-white shadow-panel"><div className="text-center text-sm text-slate-500"><LoaderCircle className="mx-auto mb-3 animate-spin text-brand-600" size={28} />Loading Partmaster workspace…</div></div>
        ) : view === "analyze" ? (
          <AnalysisWorkflow saving={saving} onSave={handleAnalysisSave} />
        ) : view === "library" ? (
          <PartsLibrary data={data} />
        ) : null}
      </main>

      <GitHubAuth open={settingsOpen} initialToken={token} onClose={() => setSettingsOpen(false)} onSave={saveToken} />
    </div>
  );
}
