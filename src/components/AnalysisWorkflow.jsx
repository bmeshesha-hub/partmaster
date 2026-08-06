import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clipboard,
  Download,
  FileText,
  FileUp,
  LoaderCircle,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  buildAnalysisPrompt,
  extractVin,
  inspectSource,
  parseAnalysisResponse,
  resultsToCsv,
} from "../utils/analysisUtils.js";

const STAGES = ["Import", "Analyze", "Finalize"];

export default function AnalysisWorkflow({ saving, onSave }) {
  const [stage, setStage] = useState(1);
  const [rawText, setRawText] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [scopeKey, setScopeKey] = useState("");
  const [aiResponse, setAiResponse] = useState("");
  const [results, setResults] = useState([]);
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const fileInput = useRef(null);
  const source = useMemo(() => inspectSource(rawText), [rawText]);
  const prompt = useMemo(
    () => buildAnalysisPrompt({ rawText, sourceName, source, scopeKey }),
    [rawText, sourceName, source, scopeKey],
  );

  async function handleFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const inspected = inspectSource(text);
    setRawText(text);
    setSourceName(file.name);
    setScopeKey(inspected.scopes[0]?.key || "");
    setError("");
    setMessage("");
  }

  function handleRawTextChange(event) {
    const text = event.target.value;
    const inspected = inspectSource(text);
    setRawText(text);
    setSourceName("");
    setScopeKey(inspected.scopes[0]?.key || "");
    setError("");
    setMessage("");
  }

  function continueToAnalysis() {
    if (!rawText.trim()) {
      setError("Upload a CSV/text file or paste raw data first.");
      return;
    }
    if (source.structured && source.scopes.length && !scopeKey) {
      setError("Choose one catalog application set to analyze.");
      return;
    }
    setError("");
    setStage(2);
  }

  async function copyPrompt() {
    await navigator.clipboard.writeText(prompt);
    setMessage("Prompt copied. Paste it into GPT, then bring the response back here.");
  }

  function parseResponse() {
    try {
      setResults(parseAnalysisResponse(aiResponse));
      setNotes(aiResponse.replace(/```(?:csv)?[\s\S]*?```/gi, "").trim());
      setError("");
      setMessage("");
      setStage(3);
    } catch (parseError) {
      setError(parseError.message);
    }
  }

  function updateResult(id, field, value) {
    setResults((current) => current.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  }

  function addRow() {
    setResults((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        item_number: String(current.length + 1),
        oem_part_number: "",
        description: "",
        side_position: "",
      },
    ]);
  }

  function downloadCsv() {
    const blob = new Blob([resultsToCsv(results)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${sourceName.replace(/\.[^.]+$/, "") || "partmaster"}_parts.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function saveResults() {
    const saved = await onSave({
      sourceName: sourceName || "Pasted raw data",
      vin: extractVin(sourceName),
      scope: source.scopes.find((scope) => scope.key === scopeKey)?.label || "Pasted raw data",
      notes,
      results,
    });
    if (saved) setMessage("Analysis saved to partmaster_data/data/analyses.json.");
  }

  return (
    <div>
      <ol className="mb-6 grid grid-cols-3 gap-2" aria-label="Analysis progress">
        {STAGES.map((label, index) => {
          const number = index + 1;
          return (
            <li key={label} className={`rounded-xl border px-3 py-3 text-sm font-medium ${stage === number ? "border-brand-500 bg-brand-50 text-brand-700" : stage > number ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-white text-slate-400"}`}>
              <span className="mr-2">{stage > number ? <Check className="inline" size={15} /> : number}.</span>{label}
            </li>
          );
        })}
      </ol>

      {error && <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{error}</div>}
      {message && <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800" role="status">{message}</div>}

      {stage === 1 && (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-panel sm:p-8">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-700"><FileUp size={20} /></span>
            <div><h3 className="text-lg font-semibold">Import raw catalog data</h3><p className="mt-1 text-sm text-slate-500">Upload a CSV/text file or paste OCR-extracted data.</p></div>
          </div>
          <input ref={fileInput} className="hidden" type="file" accept=".csv,.txt,text/csv,text/plain" onChange={handleFile} />
          <button type="button" onClick={() => fileInput.current?.click()} className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 px-5 py-8 text-sm font-semibold text-slate-600 hover:border-brand-400 hover:bg-brand-50">
            <FileText size={20} /> {sourceName || "Choose CSV or text file"}
          </button>
          <div className="my-4 flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-slate-400"><span className="h-px flex-1 bg-slate-200" />or paste<span className="h-px flex-1 bg-slate-200" /></div>
          <textarea value={rawText} onChange={handleRawTextChange} rows={10} placeholder="Paste raw CSV or messy catalog text here…" className="w-full rounded-xl border border-slate-300 p-3 font-mono text-xs leading-5 focus:border-brand-500" />

          {rawText && (
            <div className="mt-5 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
              <p><strong>{source.structured ? `${source.rowCount.toLocaleString()} CSV records detected` : `${source.rowCount.toLocaleString()} text/CSV rows detected`}</strong>{extractVin(sourceName) && ` · VIN ${extractVin(sourceName)}`}</p>
              {source.structured && source.scopes.length > 0 && (
                <label className="mt-4 block font-medium text-slate-700">Catalog application set
                  <select value={scopeKey} onChange={(event) => setScopeKey(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm">
                    {source.scopes.map((scope) => <option key={scope.key} value={scope.key}>{scope.label} ({scope.count} parts)</option>)}
                  </select>
                </label>
              )}
            </div>
          )}
          <div className="mt-6 flex justify-end"><button type="button" onClick={continueToAnalysis} className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700">Continue to analysis <ArrowRight size={17} /></button></div>
        </section>
      )}

      {stage === 2 && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-panel">
            <h3 className="font-semibold">1. Copy the research prompt</h3>
            <p className="mt-1 text-sm text-slate-500">Use it with GPT or another research-capable AI.</p>
            <textarea readOnly value={prompt} rows={18} className="mt-4 w-full rounded-xl border border-slate-300 bg-slate-50 p-3 font-mono text-xs leading-5" />
            <button type="button" onClick={copyPrompt} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"><Clipboard size={17} /> Copy prompt</button>
          </section>
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-panel">
            <h3 className="font-semibold">2. Paste the AI response</h3>
            <p className="mt-1 text-sm text-slate-500">Partmaster will extract a CSV or Markdown results table.</p>
            <textarea value={aiResponse} onChange={(event) => setAiResponse(event.target.value)} rows={18} placeholder="Paste the complete AI response here…" className="mt-4 w-full rounded-xl border border-slate-300 p-3 text-xs leading-5 focus:border-brand-500" />
            <div className="mt-4 flex justify-between gap-3"><button type="button" onClick={() => setStage(1)} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium"><ArrowLeft size={17} /> Back</button><button type="button" onClick={parseResponse} disabled={!aiResponse.trim()} className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">Review results <ArrowRight size={17} /></button></div>
          </section>
        </div>
      )}

      {stage === 3 && (
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-panel">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-5"><div><h3 className="font-semibold">Final parts list</h3><p className="mt-1 text-sm text-slate-500">Edit any value before saving or exporting.</p></div><button type="button" onClick={addRow} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium"><Plus size={16} /> Add row</button></div>
          <div className="overflow-x-auto"><table className="min-w-full divide-y divide-slate-200 text-sm"><thead className="bg-slate-50"><tr>{["Item #", "OEM Part Number", "Description", "Side / Position", ""].map((header) => <th key={header} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{header}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{results.map((row) => <tr key={row.id}>{[["item_number", "w-20"], ["oem_part_number", "min-w-44 font-mono"], ["description", "min-w-64"], ["side_position", "min-w-48"]].map(([field, width]) => <td key={field} className="px-3 py-2"><input value={row[field]} onChange={(event) => updateResult(row.id, field, event.target.value)} className={`${width} w-full rounded-lg border border-slate-200 px-2.5 py-2`} /></td>)}<td className="px-3 py-2"><button type="button" onClick={() => setResults((current) => current.filter((candidate) => candidate.id !== row.id))} className="rounded-lg p-2 text-red-500 hover:bg-red-50" aria-label="Delete row"><Trash2 size={17} /></button></td></tr>)}</tbody></table></div>
          <div className="border-t border-slate-200 p-5"><label className="text-sm font-medium text-slate-700">Vehicle identification, research notes, and warnings<textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={5} className="mt-2 w-full rounded-xl border border-slate-300 p-3 text-sm" /></label><div className="mt-5 flex flex-wrap justify-between gap-3"><button type="button" onClick={() => setStage(2)} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium"><ArrowLeft size={17} /> Back</button><div className="flex gap-3"><button type="button" onClick={downloadCsv} disabled={!results.length} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold"><Download size={17} /> Export CSV</button><button type="button" onClick={saveResults} disabled={saving || !results.length} className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{saving ? <LoaderCircle className="animate-spin" size={17} /> : <Save size={17} />} {saving ? "Saving…" : "Save analysis"}</button></div></div></div>
        </section>
      )}
    </div>
  );
}
