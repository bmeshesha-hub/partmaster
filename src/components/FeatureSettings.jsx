import { Eye, EyeOff, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { loadFeatureSettings, saveFeatureSettings } from "../utils/sourcePolicy.js";

const FEATURE_LABELS = {
  approvedSources: ["Approved source controls", "Restrict research instructions to your configured brand sources."],
  itemSpecificResearch: ["Item-specific research", "Use custom headers such as Heated, Camera, Finish, and Connector."],
  onlineEnrichment: ["Online enrichment", "Allow the local worker to inspect permitted source pages."],
  aiPromptAssistant: ["AI prompt assistant", "Enable the GPT copy/paste research workflow."],
  fieldEvidence: ["Field-level evidence", "Keep source URLs and evidence attached to individual facts."],
  conflictReview: ["Conflict review", "Send conflicting or uncertain facts to human review."],
};

export default function FeatureSettings() {
  const [features, setFeatures] = useState(loadFeatureSettings);
  const [key, setKey] = useState(() => localStorage.getItem("partmaster.openaiApiKey") || "");
  const [showKey, setShowKey] = useState(false);
  useEffect(() => saveFeatureSettings(features), [features]);
  function update(name, enabled) { setFeatures((current) => ({ ...current, [name]: enabled })); }
  function saveKey(value) { setKey(value); if (value) localStorage.setItem("partmaster.openaiApiKey", value); else localStorage.removeItem("partmaster.openaiApiKey"); }
  return <section className="mx-auto max-w-3xl">
    <div className="flex gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-50 text-violet-700"><Sparkles size={20} /></span><div><h3 className="text-lg font-semibold text-ink">Feature controls</h3><p className="mt-1 text-sm leading-6 text-slate-500">Enable or disable expandable Partmaster capabilities. Changes are saved in this browser.</p></div></div>
    <div className="mt-5 divide-y divide-slate-200 rounded-2xl border border-slate-200">{Object.entries(FEATURE_LABELS).map(([name, [label, description]]) => <label key={name} className="flex items-center justify-between gap-4 p-4"><span><span className="block text-sm font-semibold text-slate-800">{label}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{description}</span></span><input type="checkbox" checked={Boolean(features[name])} onChange={(event) => update(name, event.target.checked)} className="h-5 w-5 accent-brand-600" /></label>)}</div>
    <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5"><h4 className="font-semibold text-amber-950">OpenAI API connection</h4><p className="mt-1 text-xs leading-5 text-amber-900">Optional expansion slot. The key is stored only in this browser for now. Do not use this on a shared computer or production deployment until a secure backend secret store is connected.</p><label className="mt-4 block text-sm font-medium text-amber-950" htmlFor="openai-key">API key</label><div className="relative mt-2"><input id="openai-key" type={showKey ? "text" : "password"} value={key} onChange={(event) => saveKey(event.target.value)} placeholder="sk-…" autoComplete="off" className="w-full rounded-xl border border-amber-300 bg-white px-3 py-2.5 pr-11 text-sm" /><button type="button" onClick={() => setShowKey((value) => !value)} className="absolute inset-y-0 right-0 px-3 text-amber-700" aria-label={showKey ? "Hide API key" : "Show API key"}>{showKey ? <EyeOff size={18} /> : <Eye size={18} />}</button></div><label className="mt-4 flex items-center gap-2 text-sm font-semibold text-amber-950"><input type="checkbox" checked={Boolean(features.openAiApi && key)} disabled={!key} onChange={(event) => update("openAiApi", event.target.checked)} className="h-4 w-4 accent-amber-600" />Enable OpenAI API features</label></div>
  </section>;
}
