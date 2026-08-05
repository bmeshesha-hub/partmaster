import { Check, LoaderCircle, PackageCheck } from "lucide-react";
import { useState } from "react";

export default function ReviewTable({ items, approvingId, onApprove }) {
  const [selections, setSelections] = useState({});

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center shadow-panel">
        <PackageCheck className="mx-auto text-brand-600" size={42} aria-hidden="true" />
        <h2 className="mt-4 text-lg font-semibold">Review queue is clear</h2>
        <p className="mt-1 text-sm text-slate-500">Newly enriched parts will appear here.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-panel">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                Base part
              </th>
              <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                OEM variants
              </th>
              <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider text-slate-500">
                Action
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {items.map((item) => {
              const selectedId = selections[item.id];
              const isApproving = approvingId === item.id;

              return (
                <tr key={item.id} className="align-top hover:bg-slate-50/60">
                  <td className="w-1/3 px-6 py-5">
                    <p className="font-semibold text-ink">{item.base_part}</p>
                    <p className="mt-1 text-xs text-slate-400">Record #{item.id}</p>
                  </td>
                  <td className="px-6 py-4">
                    <fieldset className="space-y-2" disabled={isApproving}>
                      <legend className="sr-only">Choose a variant for {item.base_part}</legend>
                      {(item.variants || []).map((variant) => (
                        <label
                          key={variant.id}
                          className={`flex cursor-pointer items-center justify-between gap-4 rounded-xl border px-3 py-2.5 transition ${
                            selectedId === variant.id
                              ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500"
                              : "border-slate-200 hover:border-slate-300"
                          }`}
                        >
                          <span className="flex items-center gap-3">
                            <input
                              type="radio"
                              name={`variant-${item.id}`}
                              value={variant.id}
                              checked={selectedId === variant.id}
                              onChange={() =>
                                setSelections((current) => ({ ...current, [item.id]: variant.id }))
                              }
                              className="h-4 w-4 accent-brand-600"
                            />
                            <span className="text-sm font-medium text-slate-700">{variant.name}</span>
                          </span>
                          <span className="whitespace-nowrap font-mono text-xs text-slate-500">
                            {variant.oem_part_number}
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  </td>
                  <td className="px-6 py-5 text-right">
                    <button
                      type="button"
                      disabled={!selectedId || Boolean(approvingId)}
                      onClick={() => onApprove(item.id, selectedId)}
                      className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isApproving ? (
                        <LoaderCircle className="animate-spin" size={17} aria-hidden="true" />
                      ) : (
                        <Check size={17} aria-hidden="true" />
                      )}
                      {isApproving ? "Approving…" : "Approve"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
