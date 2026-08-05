import { Eye, EyeOff, KeyRound, X } from "lucide-react";
import { useEffect, useState } from "react";

export default function GitHubAuth({ open, initialToken, onClose, onSave }) {
  const [token, setToken] = useState(initialToken);
  const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    if (open) setToken(initialToken);
  }, [initialToken, open]);

  if (!open) return null;

  function handleSubmit(event) {
    event.preventDefault();
    onSave(token.trim());
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="github-settings-title"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
              <KeyRound size={20} aria-hidden="true" />
            </span>
            <div>
              <h2 id="github-settings-title" className="text-lg font-semibold text-ink">
                GitHub connection
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Use a fine-grained token with Contents read/write access to the data repository.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close settings"
          >
            <X size={20} />
          </button>
        </div>

        <label className="mt-6 block text-sm font-medium text-slate-700" htmlFor="github-token">
          Personal access token
        </label>
        <div className="relative mt-2">
          <input
            id="github-token"
            type={showToken ? "text" : "password"}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="github_pat_…"
            autoComplete="off"
            spellCheck="false"
            className="w-full rounded-xl border border-slate-300 px-3 py-2.5 pr-11 text-sm shadow-sm focus:border-brand-500"
          />
          <button
            type="button"
            onClick={() => setShowToken((visible) => !visible)}
            className="absolute inset-y-0 right-0 px-3 text-slate-400 hover:text-slate-700"
            aria-label={showToken ? "Hide token" : "Show token"}
          >
            {showToken ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          The token stays in this browser&apos;s localStorage. Clear it before using a shared computer.
        </p>

        <div className="mt-6 flex justify-end gap-3">
          {initialToken && (
            <button
              type="button"
              onClick={() => onSave("")}
              className="rounded-xl px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
            >
              Forget token
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!token.trim()}
            className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save connection
          </button>
        </div>
      </form>
    </div>
  );
}
