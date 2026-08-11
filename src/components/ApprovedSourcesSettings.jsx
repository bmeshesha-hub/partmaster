import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { DEFAULT_APPROVED_SOURCES, loadApprovedSources, saveApprovedSources } from "../utils/sourcePolicy.js";

export default function ApprovedSourcesSettings() {
  const [sources, setSources] = useState(loadApprovedSources);
  const [brand, setBrand] = useState("Ford");
  useEffect(() => saveApprovedSources(sources), [sources]);
  const brands = Object.keys(sources);
  const entries = sources[brand] || [];
  function update(index, field, value) {
    setSources((current) => ({ ...current, [brand]: current[brand].map((item, i) => i === index ? { ...item, [field]: value } : item) }));
  }
  function add() {
    setSources((current) => ({ ...current, [brand]: [...(current[brand] || []), { name: "", url: "https://", priority: "Approved source" }] }));
  }
  function remove(index) {
    setSources((current) => ({ ...current, [brand]: current[brand].filter((_, i) => i !== index) }));
  }
  function addBrand() {
    const name = window.prompt("Brand or manufacturer name:");
    if (name?.trim() && !sources[name.trim()]) { setSources((current) => ({ ...current, [name.trim()]: [] })); setBrand(name.trim()); }
  }
  return <section className="mx-auto max-w-3xl">
    <h3 className="text-lg font-semibold text-ink">Approved research sources</h3>
    <p className="mt-1 text-sm leading-6 text-slate-500">These sources are included in the research instructions. Keep this list limited to sources your team approves. Settings are saved in this browser.</p>
    <div className="mt-5 flex flex-wrap gap-2"><select value={brand} onChange={(event) => setBrand(event.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm">{brands.map((name) => <option key={name}>{name}</option>)}</select><button type="button" onClick={addBrand} className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold">Add brand</button><button type="button" onClick={add} className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-3 py-2 text-sm font-semibold text-white"><Plus size={16} />Add source</button></div>
    <div className="mt-4 space-y-3">{entries.map((source, index) => <div key={`${brand}-${index}`} className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 md:grid-cols-[1fr_1.5fr_1fr_auto]"><input value={source.name} onChange={(event) => update(index, "name", event.target.value)} placeholder="Source name" className="rounded-lg border border-slate-300 px-2.5 py-2 text-sm" /><input value={source.url} onChange={(event) => update(index, "url", event.target.value)} placeholder="https://approved-domain.example/" className="rounded-lg border border-slate-300 px-2.5 py-2 text-sm" /><input value={source.priority} onChange={(event) => update(index, "priority", event.target.value)} placeholder="Official OEM / dealer" className="rounded-lg border border-slate-300 px-2.5 py-2 text-sm" /><button type="button" onClick={() => remove(index)} className="rounded-lg p-2 text-red-600 hover:bg-red-100" aria-label="Remove source"><Trash2 size={17} /></button></div>)}</div>
    {!entries.length && <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">No approved sources configured for {brand}. Research will remain evidence-limited.</p>}
    <button type="button" onClick={() => { setSources(DEFAULT_APPROVED_SOURCES); setBrand("Ford"); }} className="mt-5 text-xs font-semibold text-slate-500 underline">Restore default sources</button>
  </section>;
}
