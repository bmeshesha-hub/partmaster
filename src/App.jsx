import {
  AlertCircle,
  Boxes,
  ClipboardCheck,
  LoaderCircle,
  PlusCircle,
  RefreshCw,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import GitHubAuth from "./components/GitHubAuth.jsx";
import PartIntake from "./components/PartIntake.jsx";
import ReviewTable from "./components/ReviewTable.jsx";
import {
  addInputPart,
  approveQueueItem,
  DEFAULT_REPOSITORY,
  fetchQueue,
} from "./utils/githubApi.js";

const TOKEN_STORAGE_KEY = "partmaster.githubToken";

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_STORAGE_KEY) || "");
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(false);
  const [approvingId, setApprovingId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState("review");
  const [settingsOpen, setSettingsOpen] = useState(() => !localStorage.getItem(TOKEN_STORAGE_KEY));

  const loadQueue = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");

    try {
      setQueue(await fetchQueue(token));
    } catch (requestError) {
      setError(requestError.message || "Could not load the review queue.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  function saveToken(nextToken) {
    if (nextToken) localStorage.setItem(TOKEN_STORAGE_KEY, nextToken);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);

    setToken(nextToken);
    setQueue([]);
    setError("");
    setSettingsOpen(false);
  }

  async function handleApprove(itemId, variantId) {
    setApprovingId(itemId);
    setError("");

    try {
      const result = await approveQueueItem({ token, itemId, variantId });
      setQueue(result.queue);
    } catch (requestError) {
      setError(requestError.message || "Approval failed. Please try again.");
    } finally {
      setApprovingId(null);
    }
  }

  async function handlePartSubmit(part) {
    setSubmitting(true);
    setError("");

    try {
      return await addInputPart({ token, part });
    } catch (requestError) {
      setError(requestError.message || "Could not submit this part. Please try again.");
      return null;
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200/80 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-600 text-white shadow-sm">
              <Boxes size={22} aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-ink">Partmaster</h1>
              <p className="text-xs text-slate-500">OEM variant review</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <nav className="hidden rounded-xl bg-slate-100 p-1 sm:flex" aria-label="Primary navigation">
              <button
                type="button"
                onClick={() => setView("review")}
                className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium ${view === "review" ? "bg-white text-brand-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
              >
                <ClipboardCheck size={16} aria-hidden="true" /> Review
              </button>
              <button
                type="button"
                onClick={() => setView("add")}
                className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium ${view === "add" ? "bg-white text-brand-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
              >
                <PlusCircle size={16} aria-hidden="true" /> Add part
              </button>
            </nav>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            >
              <Settings size={17} aria-hidden="true" />
              <span className="hidden sm:inline">Settings</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <nav className="mb-6 grid grid-cols-2 rounded-xl bg-slate-200/70 p-1 sm:hidden" aria-label="Primary navigation">
          <button type="button" onClick={() => setView("review")} className={`rounded-lg px-3 py-2 text-sm font-medium ${view === "review" ? "bg-white text-brand-700 shadow-sm" : "text-slate-600"}`}>Review</button>
          <button type="button" onClick={() => setView("add")} className={`rounded-lg px-3 py-2 text-sm font-medium ${view === "add" ? "bg-white text-brand-700 shadow-sm" : "text-slate-600"}`}>Add part</button>
        </nav>
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-brand-700">Human-in-the-loop dashboard</p>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink">
              {view === "review" ? "Parts awaiting review" : "Add a part"}
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              {DEFAULT_REPOSITORY.owner}/{DEFAULT_REPOSITORY.repo} · {DEFAULT_REPOSITORY.branch}
            </p>
          </div>
          {view === "review" && <div className="flex items-center gap-3">
            <span className="rounded-full bg-white px-3 py-1.5 text-sm font-medium text-slate-600 shadow-sm ring-1 ring-slate-200">
              {queue.length} pending
            </span>
            <button
              type="button"
              onClick={loadQueue}
              disabled={!token || loading || Boolean(approvingId)}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={loading ? "animate-spin" : ""} size={16} aria-hidden="true" />
              Refresh
            </button>
          </div>}
        </div>

        {error && (
          <div className="mb-5 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
            <AlertCircle className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {!token ? (
          <div className="rounded-2xl border border-slate-200 bg-white px-6 py-16 text-center shadow-panel">
            <Settings className="mx-auto text-brand-600" size={40} aria-hidden="true" />
            <h2 className="mt-4 text-lg font-semibold">Connect the data repository</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
              Add a GitHub personal access token to load and approve queued parts.
            </p>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="mt-5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Open settings
            </button>
          </div>
        ) : view === "add" ? (
          <PartIntake submitting={submitting} onSubmit={handlePartSubmit} />
        ) : loading && queue.length === 0 ? (
          <div className="grid min-h-64 place-items-center rounded-2xl border border-slate-200 bg-white shadow-panel">
            <div className="text-center text-sm text-slate-500">
              <LoaderCircle className="mx-auto mb-3 animate-spin text-brand-600" size={28} />
              Loading review queue…
            </div>
          </div>
        ) : (
          <ReviewTable items={queue} approvingId={approvingId} onApprove={handleApprove} />
        )}
      </main>

      <GitHubAuth
        open={settingsOpen}
        initialToken={token}
        onClose={() => setSettingsOpen(false)}
        onSave={saveToken}
      />
    </div>
  );
}
