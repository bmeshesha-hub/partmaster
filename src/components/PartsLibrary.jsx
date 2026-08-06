import { Download, Filter, Library, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { buildPartsLibrary, exportLibraryCsv } from "../utils/libraryUtils.js";

export default function PartsLibrary({ data }) {
  const [query, setQuery] = useState("");
  const [sourceType, setSourceType] = useState("all");
  const [sort, setSort] = useState("newest");
  const parts = useMemo(() => buildPartsLibrary(data), [data]);
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const matches = parts.filter((part) => {
      const matchesType = sourceType === "all" || part.source_type === sourceType;
      const haystack = [part.oem_part_number, part.description, part.side_position, part.source_name, part.scope, part.vin].join(" ").toLowerCase();
      return matchesType && (!normalizedQuery || haystack.includes(normalizedQuery));
    });
    return [...matches].sort((left, right) => {
      if (sort === "oldest") return String(left.completed_at).localeCompare(String(right.completed_at));
      if (sort === "oem") return String(left.oem_part_number).localeCompare(String(right.oem_part_number));
      return String(right.completed_at).localeCompare(String(left.completed_at));
    });
  }, [parts, query, sourceType, sort]);

  function downloadFiltered() {
    const blob = new Blob([exportLibraryCsv(filtered)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `partmaster-library-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-panel">
      <div className="border-b border-slate-200 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><h3 className="flex items-center gap-2 text-lg font-semibold"><Library className="text-brand-600" size={21} />Completed parts library</h3><p className="mt-1 text-sm text-slate-500">Search and export finalized analyses and approved variants.</p></div>
          <button type="button" onClick={downloadFiltered} disabled={!filtered.length} className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"><Download size={17} />Export {filtered.length.toLocaleString()} parts</button>
        </div>
        <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_auto_auto]">
          <label className="relative"><span className="sr-only">Search completed parts</span><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search OEM number, description, VIN, or source…" className="w-full rounded-xl border border-slate-300 py-2.5 pl-10 pr-10 text-sm" />{query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-slate-400 hover:bg-slate-100"><X size={16} /></button>}</label>
          <label className="relative"><span className="sr-only">Filter by source</span><Filter className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} /><select value={sourceType} onChange={(event) => setSourceType(event.target.value)} className="rounded-xl border border-slate-300 bg-white py-2.5 pl-9 pr-9 text-sm"><option value="all">All sources</option><option value="Analysis">Analyses</option><option value="Queue approval">Queue approvals</option></select></label>
          <label><span className="sr-only">Sort parts</span><select value={sort} onChange={(event) => setSort(event.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="oem">OEM number</option></select></label>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50"><tr>{["OEM Part Number", "Description", "Side / Position", "Source", "VIN", "Completed"].map((header) => <th key={header} className="whitespace-nowrap px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{header}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">{filtered.map((part) => <tr key={part.id} className="hover:bg-slate-50/70"><td className="whitespace-nowrap px-5 py-4 font-mono font-medium text-brand-700">{part.oem_part_number || "—"}</td><td className="min-w-64 px-5 py-4"><p className="font-medium text-ink">{part.description}</p>{part.scope && <p className="mt-1 text-xs text-slate-400">{part.scope}</p>}</td><td className="whitespace-nowrap px-5 py-4 text-slate-600">{part.side_position || "—"}</td><td className="min-w-48 px-5 py-4"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">{part.source_type}</span><p className="mt-2 text-xs text-slate-400">{part.source_name}</p></td><td className="whitespace-nowrap px-5 py-4 font-mono text-xs text-slate-500">{part.vin || "—"}</td><td className="whitespace-nowrap px-5 py-4 text-slate-500">{part.completed_at ? new Date(part.completed_at).toLocaleDateString() : "—"}</td></tr>)}</tbody>
        </table>
      </div>
      {!filtered.length && <div className="px-6 py-14 text-center"><Library className="mx-auto text-slate-300" size={34} /><p className="mt-3 text-sm font-medium text-slate-600">{parts.length ? "No parts match these filters" : "No completed parts yet"}</p><p className="mt-1 text-sm text-slate-400">{parts.length ? "Change or clear the search filters." : "Saved analyses and approved variants will appear here."}</p></div>}
      <footer className="border-t border-slate-200 px-5 py-3 text-xs text-slate-500">Showing {filtered.length.toLocaleString()} of {parts.length.toLocaleString()} completed parts</footer>
    </section>
  );
}
