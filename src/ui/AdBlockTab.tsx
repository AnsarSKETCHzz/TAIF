import { useEffect, useState } from "react";
import { accessError } from "./EnhanceTab";

interface Settings { network: boolean; privacy: boolean; cosmetic: boolean; notify: boolean; paused: boolean; pausedSites: string[] }
interface ListInfo { id: string; title: string; version: string; rules: number; groupedDomains: number; cosmeticGeneric: number; cosmeticSpecific: number; enabled: boolean; skipped: Record<string, number> }
interface NetworkStatus { enabledRulesets: string[]; activeRules: number; staticRules: number; updatedRules: number; pausedSiteRules: number; lists: ListInfo[]; builtAt: string; licence: string; update?: { at: string; lists: { id: string; version: string; rules: number }[] } }
interface Blocked { count?: number; live?: number; source: string }
interface CosmeticResult { enabled: boolean; matched: number; hidden: number; collapsed: number; overlays: number; adFrames: number; skipped: number; unsupported: number; restored?: number }
interface Entry { id: string; at: number; kind: "ad-tab" | "overlay" | "network" | "cosmetic" | "popup" | "redirect-blocked"; host: string; count?: number }

type StageState = "pending" | "active" | "done" | "skipped" | "failed";
interface Stage { key: string; label: string; state: StageState; detail?: string }

const DEFAULTS: Settings = { network: true, privacy: false, cosmetic: true, notify: true, paused: false, pausedSites: [] };
const STAGES: Omit<Stage, "state">[] = [
  { key: "network", label: "Applying network-filtering rules" },
  { key: "scan", label: "Checking supported advertising patterns" },
  { key: "hide", label: "Removing visible ad elements" },
  { key: "overlays", label: "Suppressing promotional overlays" },
  { key: "verify", label: "Verifying the page state" }
];

/** Runs a method of the injected cosmetic engine, injecting it once per page. */
async function cosmetic<T>(tabId: number, method: string, args: unknown[] = []): Promise<T> {
  const [probe] = await chrome.scripting.executeScript({ target: { tabId }, func: () => Boolean((window as Window & { __TAIF_COSMETIC__?: unknown }).__TAIF_COSMETIC__) });
  if (!probe?.result) await chrome.scripting.executeScript({ target: { tabId }, files: ["cosmetic.js"] });
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (name: string, values: unknown[]) => {
      const api = (window as Window & { __TAIF_COSMETIC__?: Record<string, (...input: unknown[]) => unknown> }).__TAIF_COSMETIC__;
      if (!api) throw new Error("The ad filter did not load on this page.");
      return api[name](...values);
    },
    args: [method, args]
  });
  return result?.result as T;
}

function siteOfUrl(url?: string): string {
  try {
    return url && /^https?:/.test(url) ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

export function AdBlockTab({ tab }: { tab?: chrome.tabs.Tab }) {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [closeAdTabs, setCloseAdTabs] = useState(false);
  const [status, setStatus] = useState<NetworkStatus>();
  const [blocked, setBlocked] = useState<Blocked>();
  const [phase, setPhase] = useState<"ready" | "running" | "done">("ready");
  const [stages, setStages] = useState<Stage[]>(STAGES.map((stage) => ({ ...stage, state: "pending" })));
  const [summary, setSummary] = useState<CosmeticResult>();
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [events, setEvents] = useState<Entry[]>([]);
  const [showLists, setShowLists] = useState(false);
  const [updating, setUpdating] = useState(false);
  const site = siteOfUrl(tab?.url);

  const refresh = async () => {
    const [{ taif_adblock: saved, taif_protection: protection }, { taif_protection_log: log }, state] = await Promise.all([
      chrome.storage.local.get(["taif_adblock", "taif_protection"]),
      chrome.storage.session.get("taif_protection_log"),
      chrome.runtime.sendMessage({ type: "TAIF_ADBLOCK_STATUS", tabId: tab?.id })
    ]);
    setSettings({ ...DEFAULTS, ...(saved as Partial<Settings> | undefined) });
    setCloseAdTabs((protection as { closeAdTabs?: boolean } | undefined)?.closeAdTabs === true);
    setEvents(Array.isArray(log) ? (log as Entry[]).slice().reverse().slice(0, 10) : []);
    if (state?.network) setStatus(state.network as NetworkStatus);
    if (state?.blocked) setBlocked(state.blocked as Blocked);
  };

  useEffect(() => {
    void refresh();
  }, [tab?.id]);

  const save = async (next: Settings) => {
    setSettings(next);
    await chrome.storage.local.set({ taif_adblock: next });
    setNote("Saved. Network changes apply to new requests right away; reload the page to remove ads that already loaded.");
    window.setTimeout(() => void refresh(), 600);
  };

  const setStage = (key: string, state: StageState, detail?: string) =>
    setStages((current) => current.map((stage) => stage.key === key ? { ...stage, state, detail } : stage));

  /** The real workflow; each stage advances only when its operation has finished. */
  const clean = async () => {
    if (!tab?.id) return;
    setPhase("running");
    setError("");
    setSummary(undefined);
    setStages(STAGES.map((stage) => ({ ...stage, state: "pending" })));

    setStage("network", "active");
    try {
      const network = await chrome.runtime.sendMessage({ type: "TAIF_ADBLOCK_APPLY" }) as NetworkStatus & { error?: string };
      if (network?.error) throw new Error(network.error);
      setStatus(network);
      if (!settings.network || settings.paused) setStage("network", "skipped", settings.paused ? "Protection is paused" : "Network filtering is off");
      else setStage("network", "done", `${network.activeRules.toLocaleString()} rules active (${network.enabledRulesets.join(", ") || "updated lists"})`);
    } catch (cause) {
      setStage("network", "failed", accessError(cause));
    }

    let result: CosmeticResult | undefined;
    try {
      setStage("scan", "active");
      result = await cosmetic<CosmeticResult>(tab.id, "scan");
      if (!result.enabled) {
        const why = !settings.cosmetic ? "Cosmetic filtering is off" : "Protection is paused on this site";
        for (const key of ["scan", "hide", "overlays"]) setStage(key, "skipped", why);
      } else {
        setStage("scan", "done", `${result.matched} element${result.matched === 1 ? "" : "s"} match EasyList rules or known ad frames`);
        setStage("hide", "active");
        result = await cosmetic<CosmeticResult>(tab.id, "hide", [true]);
        setStage("hide", "done", `${result.hidden} hidden · ${result.collapsed} empty space${result.collapsed === 1 ? "" : "s"} collapsed${result.skipped ? ` · ${result.skipped} skipped to keep the page working` : ""}`);
        setStage("overlays", "active");
        result = await cosmetic<CosmeticResult>(tab.id, "suppressOverlays");
        setStage("overlays", "done", `${result.overlays} promotional overlay${result.overlays === 1 ? "" : "s"}`);
      }
    } catch (cause) {
      const message = accessError(cause);
      for (const key of ["scan", "hide", "overlays"]) setStage(key, "failed", message);
      setError(message);
    }

    setStage("verify", "active");
    try {
      const verified = result?.enabled ? await cosmetic<CosmeticResult>(tab.id, "verify") : result;
      const state = await chrome.runtime.sendMessage({ type: "TAIF_ADBLOCK_STATUS", tabId: tab.id }) as { blocked?: Blocked };
      setBlocked(state.blocked);
      setSummary(verified);
      setStage("verify", "done", `${verified?.hidden ?? 0} element(s) confirmed hidden · ${state.blocked?.live ?? state.blocked?.count ?? "unknown"} request(s) blocked`);
    } catch (cause) {
      setStage("verify", "failed", accessError(cause));
    }
    setPhase("done");
    void refresh();
  };

  const restore = async () => {
    if (!tab?.id) return;
    try {
      const result = await cosmetic<CosmeticResult>(tab.id, "restore");
      setNote(`Restored ${result.restored ?? 0} element(s) on this page. Blocked network requests can't be undone; reload the page to load them (pause the site first to allow them).`);
      setSummary(undefined);
      setPhase("ready");
    } catch (cause) {
      setError(accessError(cause));
    }
  };

  const update = async () => {
    setUpdating(true);
    setError("");
    const granted = await chrome.permissions.request({ origins: ["https://easylist.to/*"] });
    if (!granted) {
      setUpdating(false);
      setError("Permission to download from easylist.to was not granted; the bundled lists stay active.");
      return;
    }
    const response = await chrome.runtime.sendMessage({ type: "TAIF_FILTER_UPDATE" }) as { ok: boolean; message: string };
    setUpdating(false);
    if (response.ok) setNote(response.message);
    else setError(response.message);
    void refresh();
  };

  const sitePaused = Boolean(site && settings.pausedSites.includes(site));
  const blockedCount = blocked?.live ?? blocked?.count;

  return (
    <section className="tp-body">
      {error && <p className="tp-error" role="alert">{error}</p>}
      {note && <p className="tp-note" role="status">{note}</p>}

      <article className={`tp-clean tp-clean-${phase}`}>
        <div className="tp-browser" aria-hidden="true">
          <div className="tp-browser-bar"><i /><i /><i /></div>
          <div className="tp-browser-body">
            <span className="tp-block tp-b1" /><span className="tp-block tp-ad tp-b2" /><span className="tp-block tp-b3" /><span className="tp-block tp-ad tp-b4" /><span className="tp-block tp-b5" />
            {phase === "running" && <span className="tp-scanline" />}
            {phase !== "ready" && <span className="tp-shieldmark">✓</span>}
          </div>
        </div>
        {phase === "ready" && <h2>Ready to clean this page</h2>}
        {phase === "running" && <h2>Scanning for advertisements…</h2>}
        {phase === "done" && <h2>{settings.paused || sitePaused ? "Ad protection is paused." : "Ad protection is active."}</h2>}
        <button className="tp-btn tp-big" disabled={phase === "running" || !tab?.id} onClick={() => void clean()}>Block Ads &amp; Clean Page</button>

        {phase !== "ready" && (
          <ol className="tp-stages">
            {stages.map((stage) => (
              <li key={stage.key} className={`tp-stage tp-stage-${stage.state}`}>
                <span className="tp-stage-icon" aria-hidden="true">{stage.state === "done" ? "✓" : stage.state === "failed" ? "!" : stage.state === "skipped" ? "–" : ""}</span>
                <span><b>{stage.label}</b>{stage.detail && <small>{stage.detail}</small>}</span>
              </li>
            ))}
          </ol>
        )}

        {phase === "done" && (
          <div className="tp-counts tp-stats" aria-label="Verified results">
            <span><b>{blockedCount ?? "—"}</b> ad/tracking requests blocked on this tab{blocked?.live === undefined && blocked?.count !== undefined ? " (last 5 min)" : ""}</span>
            <span><b>{summary?.hidden ?? 0}</b> ad elements suppressed</span>
            <span><b>{summary?.overlays ?? 0}</b> overlays suppressed</span>
            <span><b>{summary?.collapsed ?? 0}</b> empty spaces collapsed</span>
            <span><b>{summary?.skipped ?? 0}</b> skipped to keep the site working</span>
            {Boolean(summary?.unsupported) && <span><b>{summary?.unsupported}</b> rules unsupported by this browser</span>}
          </div>
        )}
        {phase === "done" && !summary?.hidden && !blockedCount && <p className="tp-muted">No advertisements were detected on this page by the active filters.</p>}
        {phase === "done" && blockedCount === undefined && <p className="tp-muted">{blocked?.source}</p>}
      </article>

      <div className="tp-why-list">
        <h3>Protection settings</h3>
        <label className="tp-check"><input type="checkbox" checked={settings.network} onChange={(event) => void save({ ...settings, network: event.target.checked })} /> Network filtering — block ad requests (EasyList)</label>
        <label className="tp-check"><input type="checkbox" checked={settings.privacy} onChange={(event) => void save({ ...settings, privacy: event.target.checked })} /> Also block trackers (EasyPrivacy)</label>
        <label className="tp-check"><input type="checkbox" checked={settings.cosmetic} onChange={(event) => void save({ ...settings, cosmetic: event.target.checked })} /> Cosmetic filtering — hide ad elements left on the page</label>
        <label className="tp-check"><input type="checkbox" checked={closeAdTabs} onChange={(event) => {
          setCloseAdTabs(event.target.checked);
          void chrome.storage.local.get("taif_protection").then(({ taif_protection: saved }) =>
            chrome.storage.local.set({ taif_protection: { ...(saved as object | undefined), closeAdTabs: event.target.checked } }));
        }} /> Add-on: close ad tabs automatically (otherwise TAIF shows the redirect alert with a Back button)</label>
        <label className="tp-check"><input type="checkbox" checked={settings.notify} onChange={(event) => void save({ ...settings, notify: event.target.checked })} /> Show "Protected by TAIF" notifications</label>
        <div className="tp-tools">
          {site && <button className="tp-link" onClick={() => void save({ ...settings, pausedSites: sitePaused ? settings.pausedSites.filter((item) => item !== site) : [...settings.pausedSites, site] })}>{sitePaused ? `Resume on ${site}` : `Pause on ${site}`}</button>}
          <button className="tp-link" onClick={() => void save({ ...settings, paused: !settings.paused })}>{settings.paused ? "Resume protection everywhere" : "Pause protection everywhere"}</button>
          {tab?.id && <button className="tp-link" onClick={() => void restore()}>Restore cosmetic changes on this page</button>}
        </div>
        <p className="tp-muted">
          Status: network {settings.network && !settings.paused ? `on (${status?.activeRules.toLocaleString() ?? "…"} rules)` : "off"} · trackers {settings.privacy ? "on" : "off"} · cosmetic {settings.cosmetic && !settings.paused ? "on" : "off"} · popups {closeAdTabs ? "on" : "off"}{sitePaused ? ` · paused on ${site}` : ""}.
          {" "}Both run automatically on every page you open; the button shows what was blocked here and cleans up anything already on screen.
        </p>
      </div>

      <div className="tp-why-list">
        <h3>Filter lists</h3>
        <button className="tp-link" onClick={() => setShowLists(!showLists)}>{showLists ? "Hide" : "Show"} list details</button>
        {status && showLists && (
          <ul>
            {status.lists.map((list) => (
              <li key={list.id}>
                <b>{list.title}</b> v{list.version} · {list.enabled ? "active" : "off"} · {list.rules.toLocaleString()} Chrome rules covering {list.groupedDomains.toLocaleString()} domains
                {list.cosmeticGeneric ? ` · ${(list.cosmeticGeneric + list.cosmeticSpecific).toLocaleString()} hiding rules` : ""}
                <small> · skipped (unsupported in Chrome MV3): {Object.values(list.skipped).reduce((sum, count) => sum + count, 0).toLocaleString()}</small>
              </li>
            ))}
            {status.update && <li>Downloaded update {new Date(status.update.at).toLocaleString()}: {status.update.lists.map((list) => `${list.id} ${list.version}`).join(", ")} ({status.updatedRules.toLocaleString()} rules)</li>}
            <li><small>{status.licence}</small></li>
          </ul>
        )}
        <div className="tp-tools">
          <button className="tp-link" disabled={updating} onClick={() => void update()}>{updating ? "Updating…" : "Update filter lists now"}</button>
          {status?.update && <button className="tp-link" onClick={() => void chrome.runtime.sendMessage({ type: "TAIF_FILTER_RESET" }).then(() => refresh())}>Use bundled lists</button>}
        </div>
      </div>

      <div className="tp-why-list">
        <h3>Recent protection events</h3>
        {!events.length && <p className="tp-muted">Nothing blocked yet in this browser session.</p>}
        <ul>{events.map((entry) => (
          <li key={entry.id}>{new Date(entry.at).toLocaleTimeString()} · {entry.host} · {
            entry.kind === "network" ? `${entry.count} advertising/tracking request(s) blocked (network)`
              : entry.kind === "cosmetic" ? `${entry.count} ad element(s) suppressed (cosmetic)`
                : entry.kind === "ad-tab" ? "ad tab closed (popup protection)" : entry.kind === "popup" ? "popup blocked (popup guard)" : entry.kind === "redirect-blocked" ? "ad redirect stopped (shield)" : "overlay hidden"
          }</li>
        ))}</ul>
      </div>
    </section>
  );
}
