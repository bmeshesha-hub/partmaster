import { CheckCircle2, LoaderCircle, PlusCircle } from "lucide-react";
import { useState } from "react";

const EMPTY_FORM = {
  year: "",
  make: "",
  model: "",
  partName: "",
  partNumber: "",
};

export default function PartIntake({ submitting, onSubmit }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [submittedPart, setSubmittedPart] = useState(null);

  function updateField(event) {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const result = await onSubmit(form);

    if (result) {
      setSubmittedPart(result);
      setForm(EMPTY_FORM);
    }
  }

  const fieldClass =
    "mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm shadow-sm placeholder:text-slate-400 focus:border-brand-500";

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-slate-200 bg-white p-6 shadow-panel sm:p-8"
      >
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
            <PlusCircle size={21} aria-hidden="true" />
          </span>
          <div>
            <h3 className="text-lg font-semibold text-ink">Part information</h3>
            <p className="mt-1 text-sm text-slate-500">
              Vehicle details are optional, but they make the enrichment request more precise.
            </p>
          </div>
        </div>

        <div className="mt-7 grid gap-5 sm:grid-cols-3">
          <label className="text-sm font-medium text-slate-700">
            Year
            <input
              className={fieldClass}
              type="text"
              inputMode="numeric"
              name="year"
              value={form.year}
              onChange={updateField}
              placeholder="2019"
              maxLength={4}
              pattern="[0-9]{4}"
              title="Enter a four-digit year"
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Make
            <input
              className={fieldClass}
              type="text"
              name="make"
              value={form.make}
              onChange={updateField}
              placeholder="Honda"
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Model
            <input
              className={fieldClass}
              type="text"
              name="model"
              value={form.model}
              onChange={updateField}
              placeholder="Accord"
            />
          </label>
        </div>

        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">
            Part name or description <span className="text-red-500">*</span>
            <input
              className={fieldClass}
              type="text"
              name="partName"
              value={form.partName}
              onChange={updateField}
              placeholder="Driver mirror"
              required
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Known part number
            <input
              className={fieldClass}
              type="text"
              name="partNumber"
              value={form.partNumber}
              onChange={updateField}
              placeholder="Optional supplier or OEM number"
              spellCheck="false"
            />
          </label>
        </div>

        <div className="mt-7 flex justify-end">
          <button
            type="submit"
            disabled={submitting || !form.partName.trim()}
            className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <LoaderCircle className="animate-spin" size={18} aria-hidden="true" />
            ) : (
              <PlusCircle size={18} aria-hidden="true" />
            )}
            {submitting ? "Submitting…" : "Submit for enrichment"}
          </button>
        </div>
      </form>

      <aside className="rounded-2xl border border-slate-200 bg-white p-6 shadow-panel">
        <h3 className="font-semibold text-ink">What happens next?</h3>
        <ol className="mt-4 space-y-4 text-sm text-slate-600">
          <li className="flex gap-3"><span className="font-semibold text-brand-700">1.</span> The part is committed to the input queue.</li>
          <li className="flex gap-3"><span className="font-semibold text-brand-700">2.</span> GitHub Actions fetches its variants.</li>
          <li className="flex gap-3"><span className="font-semibold text-brand-700">3.</span> The part appears under Review.</li>
        </ol>

        {submittedPart && (
          <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800" role="status">
            <div className="flex items-center gap-2 font-semibold">
              <CheckCircle2 size={18} aria-hidden="true" />
              Part submitted
            </div>
            <p className="mt-2 break-words">{submittedPart.base_part}</p>
            <p className="mt-2 text-xs text-emerald-700">
              Enrichment runs automatically. Check the Review tab shortly.
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}
