import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Database,
  Download,
  ExternalLink,
  FileInput,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { localDataApi } from "../utils/localDataApi.js";

const PAGE_SIZE = 100;

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** index)).toFixed(index > 2 ? 2 : 1)} ${units[index]}`;
}

function EditRowModal({ row, columns, onClose, onSave }) {
  const [values, setValues] = useState(() => Object.fromEntries(columns.filter((column) => column !== "_row_id").map((column) => [column, row[column] ?? ""])));
  const [saving, setSaving] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave(values);
    } finally {
      setSaving(false);
    }
  }

  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-4"><form onSubmit={submit} className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-2xl"><header className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4"><div><h3 className="font-semibold">Edit local part</h3><p className="mt-1 text-xs text-slate-500">Row {row._row_id}</p></div><button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><X size={18} /></button></header><div className="grid gap-4 p-5 sm:grid-cols-2">{Object.keys(values).map((column) => <label key={column} className="text-sm font-medium capitalize text-slate-700">{column.replaceAll("_", " ")}<input value={values[column]} onChange={(event) => setValues((current) => ({ ...current, [column]: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5 font-normal" /></label>)}</div><footer className="sticky bottom-0 flex justify-end gap-3 border-t border-slate-200 bg-white px-5 py-4"><button type="button" onClick={onClose} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold">Cancel</button><button disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving && <LoaderCircle className="animate-spin" size={16} />}Save changes</button></footer></form></div>;
}

export default function LocalDataManager() {
  const [connected, setConnected] = useState(null);
  const [health, setHealth] = useState(null);
  const [files, setFiles] = useState([]);
  const [datasets, setDatasets] = useState([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [datasetName, setDatasetName] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [job, setJob] = useState(null);
  const [rowData, setRowData] = useState({ rows: [], columns: [], total: 0, page: 1, pageSize: PAGE_SIZE });
  const [filterOptions, setFilterOptions] = useState({});
  const [draftQuery, setDraftQuery] = useState("");
  const [filters, setFilters] = useState({ q: "", year: "", brand: "", category: "" });
  const [page, setPage] = useState(1);
  const [loadingRows, setLoadingRows] = useState(false);
  const [editingRow, setEditingRow] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const selectedDataset = datasets.find((dataset) => dataset.id === selectedId);

  const refreshLocal = useCallback(async () => {
    try {
      const [healthResult, filesResult, datasetsResult] = await Promise.all([localDataApi.health(), localDataApi.files(), localDataApi.datasets()]);
      setConnected(true);
      setHealth(healthResult);
      setFiles(filesResult.files);
      setDatasets(datasetsResult.datasets);
      setSelectedFile((current) => current || filesResult.files[0]?.name || "");
      setSelectedId((current) => current || datasetsResult.datasets[0]?.id || "");
      setError("");
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => { refreshLocal(); }, [refreshLocal]);

  const loadRows = useCallback(async () => {
    if (!selectedId || !connected) return;
    setLoadingRows(true);
    try {
      setRowData(await localDataApi.rows(selectedId, { ...filters, page, pageSize: PAGE_SIZE }));
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoadingRows(false);
    }
  }, [connected, filters, page, selectedId]);

  useEffect(() => {
    if (!selectedId || !connected) return;
    localDataApi.filters(selectedId).then((result) => setFilterOptions(result.filters)).catch((requestError) => setError(requestError.message));
    loadRows();
  }, [connected, loadRows, selectedId]);

  useEffect(() => {
    if (!job || !["queued", "importing"].includes(job.status)) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const result = await localDataApi.importJob(job.id);
        setJob(result.job);
        if (result.job.status === "complete") {
          window.clearInterval(timer);
          setMessage(`Import complete: ${Number(result.job.rowCount).toLocaleString()} rows stored locally.`);
          await refreshLocal();
          setSelectedId(result.job.datasetId);
        } else if (result.job.status === "failed") {
          window.clearInterval(timer);
          setError(result.job.error);
        }
      } catch (requestError) {
        window.clearInterval(timer);
        setError(requestError.message);
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [job, refreshLocal]);

  async function startImport() {
    if (!selectedFile) return setError("Put a CSV in the inbox and select it first.");
    setError(""); setMessage("");
    try {
      const result = await localDataApi.startImport(selectedFile, datasetName);
      setJob(result.job);
    } catch (requestError) { setError(requestError.message); }
  }

  function applySearch(event) {
    event.preventDefault();
    setPage(1);
    setFilters((current) => ({ ...current, q: draftQuery }));
  }

  async function saveRow(changes) {
    try {
      await localDataApi.updateRow(selectedId, editingRow._row_id, changes);
      setEditingRow(null);
      setMessage("Local row updated.");
      await loadRows();
    } catch (requestError) { setError(requestError.message); }
  }

  async function deleteRow(row) {
    if (!window.confirm(`Delete row ${row._row_id} from the local database?`)) return;
    try { await localDataApi.deleteRow(selectedId, row._row_id); setMessage("Local row deleted. The original CSV was not changed."); await loadRows(); await refreshLocal(); } catch (requestError) { setError(requestError.message); }
  }

  async function exportRows() {
    try { const result = await localDataApi.exportRows(selectedId, filters); setMessage(`Export saved locally: ${result.export.path} (${formatBytes(result.export.bytes)})`); } catch (requestError) { setError(requestError.message); }
  }

  async function deleteDataset() {
    if (!window.confirm(`Remove “${selectedDataset.name}” from the local database? The original inbox CSV will be preserved.`)) return;
    try { await localDataApi.deleteDataset(selectedId); setSelectedId(""); setRowData({ rows: [], columns: [], total: 0, page: 1, pageSize: PAGE_SIZE }); setMessage("Dataset removed. Its raw inbox file was preserved."); await refreshLocal(); } catch (requestError) { setError(requestError.message); }
  }

  const visibleColumns = useMemo(() => {
    const preferred = ["year", "brand", "model", "part_number", "category", "part_name", "msrp", "quantity", "source"];
    const available = preferred.filter((column) => rowData.columns.includes(column));
    return available.length ? available : rowData.columns.filter((column) => column !== "_row_id").slice(0, 9);
  }, [rowData.columns]);
  const pageCount = Math.max(1, Math.ceil(Number(rowData.total) / PAGE_SIZE));

  if (connected === null) return <div className="grid min-h-64 place-items-center rounded-2xl border border-slate-200 bg-white"><LoaderCircle className="animate-spin text-brand-600" size={28} /></div>;
  if (!connected) return <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6 sm:p-8"><AlertTriangle className="text-amber-600" size={34} /><h3 className="mt-4 text-lg font-semibold text-amber-950">Local data service is not running</h3><p className="mt-2 max-w-2xl text-sm leading-6 text-amber-800">This feature runs only on your Mac because GitHub Pages cannot access local files. Stop the current development server, then start both services from the Partmaster directory:</p><pre className="mt-4 overflow-x-auto rounded-xl bg-slate-950 p-4 text-sm text-slate-100">npm run dev:local</pre><button type="button" onClick={refreshLocal} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-amber-700 px-4 py-2 text-sm font-semibold text-white"><RefreshCw size={16} />Check again</button></section>;

  return <div className="space-y-6">
    {error && <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><span>{error}</span><button onClick={() => setError("")}><X size={16} /></button></div>}
    {message && <div className="flex items-start justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"><span className="break-all">{message}</span><button onClick={() => setMessage("")}><X size={16} /></button></div>}

    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-panel sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h3 className="flex items-center gap-2 text-lg font-semibold"><HardDrive className="text-brand-600" size={21} />Import into local storage</h3><p className="mt-1 text-sm text-slate-500">Files and database contents stay on this Mac and are excluded from Git.</p></div><span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700">Local service connected</span></div>
      <div className="mt-5 rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Inbox directory</p><p className="mt-1 break-all font-mono text-xs text-slate-700">{health?.dataRoot}/inbox</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => localDataApi.openFolder()} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"><FolderOpen size={16} />Open in Finder</button><button type="button" onClick={refreshLocal} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"><RefreshCw size={16} />Refresh files</button></div></div>
      <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_1fr_auto]"><label className="text-sm font-medium text-slate-700">Inbox CSV/TSV<select value={selectedFile} onChange={(event) => setSelectedFile(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"><option value="">Select a file…</option>{files.map((file) => <option key={file.name} value={file.name}>{file.name} · {formatBytes(file.bytes)}</option>)}</select></label><label className="text-sm font-medium text-slate-700">Dataset name<input value={datasetName} onChange={(event) => setDatasetName(event.target.value)} placeholder="Optional friendly name" className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2.5" /></label><button type="button" onClick={startImport} disabled={!selectedFile || ["queued", "importing"].includes(job?.status)} className="mt-auto inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{["queued", "importing"].includes(job?.status) ? <LoaderCircle className="animate-spin" size={17} /> : <FileInput size={17} />}{job?.status === "importing" ? "Importing…" : "Import file"}</button></div>
      {["queued", "importing"].includes(job?.status) && <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800"><p className="font-semibold">DuckDB is importing {job.filename}</p><p className="mt-1">A 10 GB file can take several minutes. Keep this window and the local service open.</p><div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100"><div className="h-full w-1/3 animate-pulse rounded-full bg-brand-500" /></div></div>}
    </section>

    <section className="rounded-2xl border border-slate-200 bg-white shadow-panel">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 p-5 sm:p-6"><label className="min-w-64 flex-1 text-sm font-medium text-slate-700">Stored dataset<select value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setPage(1); }} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"><option value="">Select a dataset…</option>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name} · {Number(dataset.row_count).toLocaleString()} rows</option>)}</select></label>{selectedDataset && <div className="flex gap-2"><button type="button" onClick={exportRows} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white"><Download size={17} />Export filtered CSV</button><button type="button" onClick={deleteDataset} className="rounded-xl border border-red-200 p-2.5 text-red-600 hover:bg-red-50" aria-label="Delete dataset"><Trash2 size={17} /></button></div>}</div>
      {selectedDataset ? <>
        <div className="grid gap-3 border-b border-slate-200 bg-slate-50/70 px-5 py-4 sm:grid-cols-3 sm:px-6"><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Rows stored</p><p className="mt-1 text-xl font-bold">{Number(selectedDataset.row_count).toLocaleString()}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Source size</p><p className="mt-1 text-xl font-bold">{formatBytes(selectedDataset.source_bytes)}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Imported</p><p className="mt-1 text-sm font-semibold">{new Date(selectedDataset.imported_at).toLocaleString()}</p></div></div>
        <form onSubmit={applySearch} className="grid gap-3 border-b border-slate-200 p-5 lg:grid-cols-[1fr_repeat(3,auto)_auto]"><label className="relative"><span className="sr-only">Search dataset</span><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={17} /><input value={draftQuery} onChange={(event) => setDraftQuery(event.target.value)} placeholder="Search part number, name, model…" className="w-full rounded-xl border border-slate-300 py-2.5 pl-10 pr-3 text-sm" /></label>{["year", "brand", "category"].map((name) => <select key={name} aria-label={`Filter by ${name}`} value={filters[name]} onChange={(event) => { setPage(1); setFilters((current) => ({ ...current, [name]: event.target.value })); }} className="max-w-52 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"><option value="">All {name}s</option>{(filterOptions[name] || []).map((value) => <option key={value} value={value}>{value}</option>)}</select>)}<button className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white">Apply</button></form>
        <div className="overflow-x-auto"><table className="min-w-full divide-y divide-slate-200 text-sm"><thead className="bg-slate-50"><tr>{visibleColumns.map((column) => <th key={column} className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{column.replaceAll("_", " ")}</th>)}<th className="sticky right-0 bg-slate-50 px-4 py-3"><span className="sr-only">Actions</span></th></tr></thead><tbody className="divide-y divide-slate-100">{rowData.rows.map((row) => <tr key={row._row_id} className="hover:bg-slate-50">{visibleColumns.map((column) => <td key={column} className={`max-w-72 truncate whitespace-nowrap px-4 py-3 ${column === "part_number" ? "font-mono font-medium text-brand-700" : "text-slate-600"}`} title={row[column] || ""}>{row[column] || "—"}</td>)}<td className="sticky right-0 flex gap-1 bg-white px-3 py-2"><button type="button" onClick={() => setEditingRow(row)} className="rounded-lg p-2 text-brand-600 hover:bg-brand-50" aria-label="Edit row"><Pencil size={16} /></button><button type="button" onClick={() => deleteRow(row)} className="rounded-lg p-2 text-red-500 hover:bg-red-50" aria-label="Delete row"><Trash2 size={16} /></button>{row.url && <a href={row.url} target="_blank" rel="noreferrer" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Open source URL"><ExternalLink size={16} /></a>}</td></tr>)}</tbody></table>{loadingRows && <div className="grid min-h-40 place-items-center"><LoaderCircle className="animate-spin text-brand-600" size={25} /></div>}{!loadingRows && !rowData.rows.length && <div className="px-6 py-12 text-center text-sm text-slate-500">No rows match the current filters.</div>}</div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-4 text-sm text-slate-500"><span>{Number(rowData.total).toLocaleString()} matching rows · Page {page.toLocaleString()} of {pageCount.toLocaleString()}</span><div className="flex gap-2"><button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || loadingRows} className="rounded-lg border border-slate-300 p-2 disabled:opacity-40"><ChevronLeft size={17} /></button><button type="button" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page >= pageCount || loadingRows} className="rounded-lg border border-slate-300 p-2 disabled:opacity-40"><ChevronRight size={17} /></button></div></footer>
      </> : <div className="px-6 py-14 text-center"><Database className="mx-auto text-slate-300" size={36} /><p className="mt-3 text-sm font-medium text-slate-600">Import or select a local dataset</p><p className="mt-1 text-sm text-slate-400">Only paged query results are sent to the browser.</p></div>}
    </section>
    {editingRow && <EditRowModal row={editingRow} columns={rowData.columns} onClose={() => setEditingRow(null)} onSave={saveRow} />}
  </div>;
}
