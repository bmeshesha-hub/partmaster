import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { Fragment, useState } from "react";

function known(value) {
  return value != null && !["", "unknown", "null", "n/a"].includes(String(value).trim().toLowerCase());
}
function label(value) { return String(value || "").replaceAll("_", " "); }
function display(value) { return known(value) ? String(value) : "Unknown"; }
function vehicle(fitment) { return [fitment.year, fitment.make, fitment.model, fitment.trim].filter(known).join(" · ") || "Vehicle details incomplete"; }
function safeLink(value) {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}

function Attribute({ attribute }) {
  const values = attribute.values || [];
  return <div className="break-words"><dt className="text-[11px] font-bold capitalize text-slate-500">{label(attribute.name)}</dt><dd className="mt-0.5 font-semibold text-slate-900">{values.map((value) => value === "true" ? "Yes" : value === "false" ? "No" : display(value)).join(" / ") || "Unknown"}</dd>{values.length > 1 && <p className="mt-1 text-[11px] font-bold text-amber-800">Conflicting values · verify before use</p>}</div>;
}

function FitmentDetails({ fitments }) {
  if (!fitments.length) return <p className="text-sm text-slate-500">Vehicle fitment is unknown. Confirm compatibility before creating a listing or purchasing.</p>;
  return <div className="overflow-x-auto rounded-xl border border-slate-200"><table className="w-full min-w-[850px] text-left text-xs"><caption className="sr-only">Recorded vehicle fitments and restrictions</caption><thead className="bg-slate-100 text-slate-600"><tr>{["Vehicle / ePID", "Assembly / location", "Quantity / item", "Required / excluded options", "Fitment notes"].map((heading) => <th key={heading} scope="col" className="px-3 py-3">{heading}</th>)}</tr></thead><tbody className="divide-y divide-slate-200 bg-white">{fitments.map((fitment, index) => <tr key={index} className="align-top">
    <td className="px-3 py-3"><p className="font-bold">{vehicle(fitment)}</p><p className="mt-1 text-slate-500">{[fitment.vehicle_type, fitment.motorcycle_type].filter(known).join(" · ")}</p><p className="mt-1">ePID: {display(fitment.epid)}</p>{fitment.vehicle_reference === "unmapped" && <p className="mt-1 font-semibold text-amber-800">Vehicle reference not mapped</p>}</td>
    <td className="px-3 py-3"><p>{display(fitment.assembly)}</p><p className="mt-1">{[fitment.side, fitment.position].filter(known).join(" · ") || "Position unknown"}</p>{known(fitment.location_notes) && <p className="mt-1 text-slate-500">{fitment.location_notes}</p>}</td>
    <td className="px-3 py-3"><p>Quantity: {display(fitment.quantity)}</p><p className="mt-1">Diagram item: {display(fitment.item_number)}</p></td>
    <td className="px-3 py-3"><p>Required: {known(fitment.required_options) ? fitment.required_options : "Not recorded"}</p><p className="mt-1">Excluded: {known(fitment.excluded_options) ? fitment.excluded_options : "Not recorded"}</p></td>
    <td className="max-w-80 whitespace-pre-wrap break-words px-3 py-3">{known(fitment.notes) ? fitment.notes : "No additional notes recorded"}</td>
  </tr>)}</tbody></table></div>;
}

export default function CatalogPartRow({ part, density, audit = false }) {
  const [expanded, setExpanded] = useState(false);
  const attributes = part.attributes || [];
  const fitments = part.fitments || [];
  const additional = part.additional_fitments || [];
  const visibleCount = density === "compact" ? 1 : 3;
  const attributeLimit = density === "compact" ? 2 : density === "detailed" ? 8 : 4;
  const padding = density === "compact" ? "py-3" : "py-5";
  const detailId = `part-details-${encodeURIComponent(part.part_key)}`;
  const sourceLink = safeLink(part.audit?.best_source_url);
  return <Fragment>
    <tr className="align-top hover:bg-slate-50/70">
      <td className={`break-words px-4 ${padding}`}><p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{display(part.manufacturer)}</p><button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={detailId} className="mt-1 break-all text-left font-mono text-sm font-black text-brand-700 underline-offset-4 hover:underline">{part.part_number}</button><p className="mt-2 text-sm font-semibold leading-5 text-slate-800">{known(part.description) ? part.description : "Description not yet available"}</p></td>
      <td className={`break-words px-4 ${padding}`}><p className="font-semibold">{display(part.family_name)}</p><p className="mt-2 capitalize text-slate-500">{known(part.component_scope) ? label(part.component_scope) : "Scope unknown"}</p></td>
      <td className={`break-words px-4 ${padding}`}><div className="space-y-2">{fitments.slice(0, visibleCount).map((fitment, index) => <div key={index}><p className="font-semibold text-slate-800">{vehicle(fitment)}</p>{known(fitment.assembly) && <p className="mt-0.5 text-slate-500">{fitment.assembly}</p>}{(known(fitment.required_options) || known(fitment.excluded_options)) && <p className="mt-0.5 font-semibold text-amber-800">Option restrictions apply</p>}</div>)}</div>{!fitments.length && <p className="text-slate-500">{additional.length ? "Additional catalog fitments recorded" : "Fitment unknown"}</p>}{(fitments.length > visibleCount || additional.length > 0) && <button type="button" onClick={() => setExpanded(true)} aria-controls={detailId} className="mt-2 font-bold text-brand-700">View all {fitments.length + additional.length} fitments</button>}<p className="mt-2 text-[11px] text-slate-500">{fitments.length ? "Recorded compatibility · check restrictions" : "Confirm compatibility before use"}</p></td>
      <td className={`break-words px-4 ${padding}`}>{[part.side, part.position].filter(known).join(" · ") || "See fitment details"}</td>
      <td className={`px-4 ${padding}`}><dl className="grid gap-3 sm:grid-cols-2">{attributes.slice(0, attributeLimit).map((attribute) => <Attribute key={attribute.name} attribute={attribute} />)}</dl>{!attributes.length && <p className="text-slate-500">Specifications not yet available</p>}{attributes.length > attributeLimit && <button type="button" onClick={() => setExpanded(true)} aria-controls={detailId} className="mt-3 font-bold text-brand-700">View all {attributes.length} attributes</button>}{part.unresolved_details?.length > 0 && <p className="mt-3 font-bold text-amber-800">Some details need confirmation</p>}</td>
      <td className={`px-3 ${padding}`}><button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={detailId} aria-label={`${expanded ? "Hide" : "View"} details for ${part.manufacturer} ${part.part_number}`} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-2 font-bold text-brand-700">{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}Details</button></td>
    </tr>
    {expanded && <tr id={detailId}><td colSpan={6} className="bg-slate-50 p-5 sm:p-6"><div className="space-y-6">
      <div><h4 className="text-lg font-black">{part.manufacturer} {part.part_number} · Part details</h4><p className="mt-1 text-xs text-slate-500">Part key: {part.part_key}. Unknown fields have not been filled in.</p></div>
      <div className="grid gap-6 lg:grid-cols-2"><section><h5 className="mb-3 text-sm font-black">All attributes & specifications</h5>{attributes.length ? <dl className="grid gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2">{attributes.map((attribute) => <Attribute key={attribute.name} attribute={attribute} />)}</dl> : <p className="text-sm text-slate-500">No specifications recorded yet.</p>}</section>
        <section className="space-y-4"><div><h5 className="text-sm font-black">Alternate part numbers</h5>{part.alternate_numbers?.length ? <ul className="mt-2 space-y-2 text-sm">{part.alternate_numbers.map((alias, index) => <li key={index}><span className="font-mono font-bold">{alias.number}</span> <span className="capitalize text-slate-500">· {label(alias.type)}</span></li>)}</ul> : <p className="mt-2 text-sm text-slate-500">No confirmed alternate numbers recorded.</p>}</div><div><h5 className="text-sm font-black">Replacement & interchange relationships</h5>{part.relationships?.length ? <ul className="mt-2 space-y-3 text-sm">{part.relationships.map((relation, index) => <li key={index} className="rounded-xl border border-slate-200 bg-white p-3"><p className="font-bold capitalize">{label(relation.type)} → {relation.manufacturer} {relation.part_number}</p><p className="mt-1 text-slate-600">{known(relation.conditions) ? relation.conditions : "No conditions recorded; confirm interchangeability before use."}</p></li>)}</ul> : <p className="mt-2 text-sm text-slate-500">No replacement or interchange relationships recorded.</p>}</div></section></div>
      <section><h5 className="mb-2 text-sm font-black">Vehicle fitment & installation details</h5><p className="mb-3 text-xs text-slate-500">Each row keeps its vehicle, location, quantity, and restrictions together. A missing restriction is unknown.</p><FitmentDetails fitments={fitments} /></section>
      {additional.length > 0 && <section><h5 className="mb-3 text-sm font-black">Additional catalog fitments</h5><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{additional.map((fitment, index) => <div key={index} className="rounded-xl border border-slate-200 bg-white p-3 text-xs"><p className="font-bold">{vehicle(fitment)}</p><p className="mt-1">Model code: {display(fitment.model_code)}</p><p className="mt-1">Assembly: {display(fitment.assembly)}</p><p className="mt-1 text-slate-500">Options and installation restrictions not recorded here.</p></div>)}</div></section>}
      {part.unresolved_details?.length > 0 && <section className="rounded-xl border border-amber-200 bg-amber-50 p-4"><h5 className="text-sm font-black text-amber-900">Details to confirm before use</h5><ul className="mt-2 space-y-2 text-sm text-amber-900">{part.unresolved_details.map((conflict, index) => <li key={index}><span className="font-bold capitalize">{label(conflict.field)}:</span> {conflict.explanation} {conflict.values}</li>)}</ul></section>}
      {audit && part.audit && <details className="rounded-xl border border-slate-200 bg-white p-4"><summary className="cursor-pointer text-sm font-black text-slate-700">Internal provenance & data quality</summary><dl className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">{Object.entries(part.audit).filter(([key]) => key !== "best_source_url").map(([key, value]) => <div key={key}><dt className="text-[11px] font-bold capitalize text-slate-500">{label(key)}</dt><dd className="mt-1 break-words text-xs">{display(value)}</dd></div>)}</dl>{sourceLink && <a href={sourceLink} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1 text-xs font-bold text-brand-700">View source page<ExternalLink size={13} /></a>}</details>}
    </div></td></tr>}
  </Fragment>;
}
