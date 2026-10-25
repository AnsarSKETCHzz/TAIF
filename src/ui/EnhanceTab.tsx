import { useEffect, useState } from "react";
import {
  CATEGORY_LABELS,
  CATEGORY_LIMITS,
  CATEGORY_RULES,
  DEFAULT_SETTINGS,
  STRENGTH,
  withDefaults,
  type Candidate,
  type Category,
  type EnhanceReport,
  type EnhanceSettings,
  type Status,
  type Strength
} from "../shared/enhance";

const STATUS_LABEL: Record<Status, string> = {
  detected: "Detected",
  suggested: "Suggested",
  applied: "Applied",
  verified: "Verified",
  skipped: "Skipped",
  unsupported: "Unsupported",
  unverified: "Unable to verify",
  undone: "Undone"
};

const CHANGED: Status[] = ["applied", "verified", "unverified"];

/** Runs a method of the injected enhancer in the active tab, injecting it once per page. */
export async function callEnhancer<T>(tabId: number, method: string, args: unknown[] = []): Promise<T> {
  const [probe] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => Boolean((window as Window & { __TAIF_ENHANCE__?: unknown }).__TAIF_ENHANCE__)
  });
  if (!probe?.result) await chrome.scripting.executeScript({ target: { tabId }, files: ["enhancer.js"] });
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (name: string, values: unknown[]) => {
      const api = (window as Window & { __TAIF_ENHANCE__?: Record<string, (...input: unknown[]) => unknown> }).__TAIF_ENHANCE__;
      if (!api) throw new Error("The page tools did not load.");
      return api[name](...values);
    },
    args: [method, args]
  });
  return result?.result as T;
}

export function accessError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/chrome:\/\/|cannot be scripted|Cannot access|extensions gallery|chrome-extension|edge:\/\//i.test(message)) {
    return "Chrome doesn't let extensions change this page (browser pages, the Chrome Web Store, built-in PDF viewer). Open a normal website and try again.";
  }
  return message;
}

export function EnhanceTab({ tab }: { tab?: chrome.tabs.Tab }) {
  const [settings, setSettings] = useState<EnhanceSettings>(DEFAULT_SETTINGS);
  const [report, setReport] = useState<EnhanceReport>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [zoom, setZoom] = useState<{ previous: number; current: number }>();
  const [terms, setTerms] = useState(true);
  useEffect(() => {
    void chrome.storage.local.get("taif_terms_highlight").then((stored) => setTerms(stored.taif_terms_highlight !== false), () => undefined);
  }, []);

  useEffect(() => {
    void (async () => {
      const { taif_enhance_settings: saved } = await chrome.storage.local.get("taif_enhance_settings");
      setSettings(withDefaults(saved));
      if (!tab?.id) return;
      const stored = await chrome.storage.session.get(`taif_zoom_${tab.id}`);
      const zoomState = stored[`taif_zoom_${tab.id}`] as { previous: number; current: number } | undefined;
      if (zoomState) setZoom(zoomState);
      const existing = await callEnhancer<EnhanceReport | undefined>(tab.id, "report").catch(() => undefined);
      if (existing) setReport(existing);
    })();
  }, [tab?.id]);

  const run = async (work: () => Promise<EnhanceReport | undefined>) => {
    if (!tab?.id) return;
    setBusy(true);
    setError("");
    try {
      const next = await work();
      if (next) {
        setReport(next);
        setSelected(new Set(next.candidates.filter((candidate) => candidate.status === "suggested").map((candidate) => candidate.id)));
      }
    } catch (cause) {
      setError(accessError(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = async (next: EnhanceSettings) => {
    setSettings(next);
    await chrome.storage.local.set({ taif_enhance_settings: next });
  };

  const analyze = () => run(() => callEnhancer(tab!.id!, "analyze", [settings, settings.mode === "quick"]));
  const applySelected = () => run(() => callEnhancer(tab!.id!, "apply", [[...selected]]));
  const undo = (ids: string[]) => run(() => callEnhancer(tab!.id!, "undo", [ids]));
  const exclude = (id: string) => run(() => callEnhancer(tab!.id!, "exclude", [id]));
  const restoreAll = () => run(async () => {
    const next = await callEnhancer<EnhanceReport>(tab!.id!, "restoreAll");
    if (zoom) await resetZoom();
    return next;
  });
  const toggleRisk = async (risk: boolean) => {
    const next = { ...settings, risk };
    await save(next);
    await run(() => callEnhancer(tab!.id!, "setRisk", [next]));
  };

  /** Zooms the whole tab: the fallback that enlarges any CAPTCHA, including ones TAIF cannot detect. */
  const zoomPage = async () => {
    if (!tab?.id) return;
    const previous = zoom?.previous ?? await chrome.tabs.getZoom(tab.id);
    const current = Math.min(3, Math.round(((zoom?.current ?? previous) + 0.25) * 100) / 100);
    await chrome.tabs.setZoom(tab.id, current);
    const state = { previous, current };
    setZoom(state);
    await chrome.storage.session.set({ [`taif_zoom_${tab.id}`]: state });
  };
  const resetZoom = async () => {
    if (!tab?.id || !zoom) return;
    await chrome.tabs.setZoom(tab.id, zoom.previous);
    setZoom(undefined);
    await chrome.storage.session.remove(`taif_zoom_${tab.id}`);
  };

  const candidates = report?.candidates ?? [];
  const changed = candidates.filter((candidate) => CHANGED.includes(candidate.status));
  const counts = {
    found: candidates.length,
    selected: candidates.filter((candidate) => selected.has(candidate.id) || CHANGED.includes(candidate.status)).length,
    enhanced: changed.filter((candidate) => candidate.status !== "unverified").length,
    skipped: candidates.filter((candidate) => candidate.status === "skipped" || candidate.status === "unsupported").length,
    unverified: candidates.filter((candidate) => candidate.status === "unverified").length
  };
  const anythingChanged = changed.length > 0 || Boolean(report?.context.length) || Boolean(zoom);
  const byCategory = new Map<Category, Candidate[]>();
  for (const candidate of candidates) byCategory.set(candidate.category, [...(byCategory.get(candidate.category) ?? []), candidate]);

  return (
    <section className="tp-body">
      {error && <p className="tp-error" role="alert">{error}</p>}

      <div className="tp-actions tp-wrap">
        <button className="tp-btn" disabled={busy || !tab?.id} onClick={() => void analyze()}>
          {busy ? "Working…" : settings.mode === "quick" ? "Analyze & Enhance Page" : "Analyze (Review First)"}
        </button>
        {settings.mode === "review" && report && <button className="tp-btn tp-ghost" disabled={busy || !selected.size} onClick={() => void applySelected()}>Apply selected ({selected.size})</button>}
      </div>
      <div className="tp-strength" role="radiogroup" aria-label="Zoom strength">
        <span>Zoom strength</span>
        {(Object.keys(STRENGTH) as Strength[]).map((key) => (
          <button key={key} role="radio" aria-checked={settings.strength === key} className={settings.strength === key ? "tp-chip tp-chip-on" : "tp-chip"}
            onClick={() => void (async () => {
              const next = { ...settings, strength: key };
              await save(next);
              // Re-apply at the new strength when the page was already enhanced.
              if (report && tab?.id) await run(async () => {
                await callEnhancer(tab.id!, "restoreAll");
                return callEnhancer(tab.id!, "analyze", [next, next.mode === "quick"]);
              });
            })()}>
            {STRENGTH[key].label}{key === "normal" ? "" : ` ×${STRENGTH[key].zoom}`}
          </button>
        ))}
      </div>
      <label className="tp-check">
        <input type="checkbox" checked={terms} onChange={(event) => {
          setTerms(event.target.checked);
          void chrome.storage.local.set({ taif_terms_highlight: event.target.checked });
        }} /> Highlight “Terms & Conditions” on every site (add-on)
      </label>
      <div className="tp-tools">
        <button className="tp-link" onClick={() => void save({ ...settings, mode: settings.mode === "quick" ? "review" : "quick" })}>
          Mode: {settings.mode === "quick" ? "Quick Enhance" : "Review First"} (switch)
        </button>
        {report && <button className="tp-link" disabled={busy} onClick={() => void analyze()}>Refresh analysis</button>}
        {report && <button className="tp-link" onClick={() => setSelected(new Set(candidates.filter((candidate) => candidate.eligible && !CHANGED.includes(candidate.status)).map((candidate) => candidate.id)))}>Select eligible</button>}
        {report && <button className="tp-link" disabled={!selected.size} onClick={() => void undo([...selected])}>Remove selected enhancements</button>}
        <button className="tp-link" onClick={() => setShowSettings(!showSettings)}>{showSettings ? "Hide" : "Show"} settings</button>
      </div>

      <div className="tp-captcha">
        <strong>CAPTCHA too small?</strong>
        <span>Analyze & Enhance enlarges CAPTCHAs it finds. If one is still small, zoom the whole page — this works on every site. TAIF never solves or bypasses CAPTCHAs.</span>
        <div className="tp-actions">
          <button className="tp-btn tp-ghost" disabled={!tab?.id} onClick={() => void zoomPage().catch((cause) => setError(accessError(cause)))}>Zoom whole page{zoom ? ` (${Math.round(zoom.current * 100)}%)` : ""}</button>
          {zoom && <button className="tp-btn tp-ghost" onClick={() => void resetZoom()}>Reset zoom</button>}
        </div>
      </div>

      {showSettings && (
        <div className="tp-settings">
          <label>Target size <input type="number" min={24} max={72} value={settings.targetPx} onChange={(event) => void save({ ...settings, targetPx: Number(event.target.value) })} /> px</label>
          <label>Minimum text <input type="number" min={12} max={28} value={settings.minFontPx} onChange={(event) => void save({ ...settings, minFontPx: Number(event.target.value) })} /> px</label>
          <label>Screen size
            <select value={settings.screen} onChange={(event) => void save({ ...settings, screen: event.target.value as EnhanceSettings["screen"] })}>
              <option value="auto">Automatic</option><option value="compact">Compact (override)</option><option value="spacious">Spacious (override)</option>
            </select>
          </label>
          <label className="tp-check"><input type="checkbox" checked={settings.guidance} onChange={(event) => void save({ ...settings, guidance: event.target.checked })} /> First-visit tips</label>
          <label className="tp-check"><input type="checkbox" checked={settings.focusRing} onChange={(event) => void save({ ...settings, focusRing: event.target.checked })} /> Strong keyboard focus outline</label>
          <label className="tp-check"><input type="checkbox" checked={settings.risk} onChange={(event) => void toggleRisk(event.target.checked)} /> Simulated risk (test input): highlight payments/deletions and ask for a second click</label>
          <button className="tp-link" onClick={() => void chrome.storage.local.remove("taif_visits")}>Reset first-visit state (all sites)</button>
          <fieldset>
            <legend>Categories</legend>
            {(Object.keys(CATEGORY_LABELS) as Category[]).map((category) => (
              <label className="tp-check" key={category}>
                <input type="checkbox" checked={settings.categories[category]} onChange={(event) => void save({ ...settings, categories: { ...settings.categories, [category]: event.target.checked } })} /> {CATEGORY_LABELS[category]}
              </label>
            ))}
          </fieldset>
          <button className="tp-link" onClick={() => setShowRules(!showRules)}>{showRules ? "Hide" : "Show"} detection rules</button>
          {showRules && <ul className="tp-rules">{(Object.keys(CATEGORY_LABELS) as Category[]).map((category) => (
            <li key={category}><b>{CATEGORY_LABELS[category]}:</b> {CATEGORY_RULES[category]} <i>Limit: {CATEGORY_LIMITS[category]}</i></li>
          ))}</ul>}
        </div>
      )}

      {report && (
        <>
          <div className="tp-counts" aria-label="Analysis summary">
            <span><b>{counts.found}</b> found</span><span><b>{counts.selected}</b> selected</span><span><b>{counts.enhanced}</b> enhanced</span>
            <span><b>{counts.skipped}</b> skipped</span><span><b>{counts.unverified}</b> not verified</span>
          </div>
          <p className="tp-muted">{report.host} · {report.screen.mode} screen ({report.screen.width} × {report.screen.height}) · {report.visitor} visitor · {new Date(report.analyzedAt).toLocaleTimeString()}</p>

          {[...byCategory.entries()].map(([category, items]) => (
            <details className="tp-group" key={category} open={items.some((item) => item.status !== "skipped")}>
              <summary>{CATEGORY_LABELS[category]} ({items.length})</summary>
              <ul className="tp-list">
                {items.map((candidate) => (
                  <li className="tp-row" key={candidate.id}>
                    <div className="tp-row-head">
                      {settings.mode === "review" && candidate.eligible && !CHANGED.includes(candidate.status) && (
                        <input type="checkbox" aria-label={`Select ${candidate.name}`} checked={selected.has(candidate.id)}
                          onChange={(event) => setSelected((previous) => {
                            const next = new Set(previous);
                            if (event.target.checked) next.add(candidate.id); else next.delete(candidate.id);
                            return next;
                          })} />
                      )}
                      <span className={`tp-sev tp-st-${candidate.status}`}>{STATUS_LABEL[candidate.status]}</span>
                      <strong>{candidate.name || candidate.tag}</strong>
                    </div>
                    <small>
                      {Math.round(candidate.before.w)} × {Math.round(candidate.before.h)} px, {Math.round(candidate.before.font)} px text
                      {candidate.after ? ` → ${Math.round(candidate.after.w)} × ${Math.round(candidate.after.h)} px, ${Math.round(candidate.after.font)} px` : ""}
                    </small>
                    {candidate.issues.length > 0 && <small>Issues: {candidate.issues.join("; ")}</small>}
                    <small>Why: {candidate.reason} · Suggested: {candidate.suggestion}</small>
                    <div className="tp-tools">
                      {CHANGED.includes(candidate.status) && <button className="tp-link" onClick={() => void undo([candidate.id])}>Undo</button>}
                      {candidate.status !== "skipped" && <button className="tp-link" onClick={() => void exclude(candidate.id)}>Exclude this session</button>}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ))}

          <div className="tp-why-list">
            <h3>Why did the interface change?</h3>
            {!changed.length && !report.context.length && <p className="tp-muted">Nothing has been changed on this page.</p>}
            <ul>
              {changed.map((candidate) => (
                <li key={candidate.id}>
                  <span className={`tp-sev tp-st-${candidate.status}`}>{STATUS_LABEL[candidate.status]}</span> {candidate.explanation}
                  <button className="tp-link" onClick={() => void undo([candidate.id])}>Undo</button>
                </li>
              ))}
              {report.context.map((change) => (
                <li key={change.id}>
                  <b>{change.signal}</b> → {change.element} · rule: {change.rule} · change: {change.change}
                  {/^[gr]\d/.test(change.id) && <button className="tp-link" onClick={() => void undo([change.id])}>Undo</button>}
                </li>
              ))}
              {zoom && <li><b>Page zoom</b> → whole page at {Math.round(zoom.current * 100)}% (was {Math.round(zoom.previous * 100)}%) <button className="tp-link" onClick={() => void resetZoom()}>Undo</button></li>}
            </ul>
          </div>
        </>
      )}

      {anythingChanged && <button className="tp-btn tp-restore" disabled={busy} onClick={() => void restoreAll()}>Restore original page (undo everything)</button>}
    </section>
  );
}
