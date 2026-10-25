/**
 * End-to-end smoke test: loads dist/ as an unpacked extension in a Chromium browser, drives the
 * redirect lab, and reads the events the service worker stored. Usage:
 *   node scripts/e2e-redirect.mjs "<path to msedge.exe or chromium>"
 * Requires a build (npm run build). Branded Chrome 137+ ignores --load-extension; Edge or Chromium work.
 */
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const browser = process.argv[2];
/** --granted loads a test copy with host access pre-granted (what a toolbar click + live monitoring give a real user). */
const granted = process.argv.includes("--granted");
if (!browser) throw new Error("Pass the browser executable path.");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
let dist = join(root, "dist");
const PORT = 5199;
const DEBUG = 9400 + Math.floor(Math.random() * 500);
const profile = await mkdtemp(join(tmpdir(), "taif-e2e-"));
const results = [];
if (granted) {
  const copy = join(profile, "ext");
  await cp(dist, copy, { recursive: true });
  const manifest = JSON.parse(await readFile(join(copy, "manifest.json"), "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await writeFile(join(copy, "manifest.json"), JSON.stringify(manifest));
  dist = copy;
}
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const server = spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { cwd: root, stdio: "ignore" });
/**
 * Branded Google Chrome ignores --load-extension, so for it (--pipe-load) the extension is loaded
 * through the DevTools pipe with Extensions.loadUnpacked instead.
 */
const pipeLoad = process.argv.includes("--pipe-load");
const chrome = spawn(browser, [
  "--headless=new", `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`,
  ...(pipeLoad
    ? ["--remote-debugging-pipe", "--enable-unsafe-extension-debugging"]
    : [`--load-extension=${dist}`, `--disable-extensions-except=${dist}`]),
  "--no-first-run", "--no-default-browser-check", "about:blank"
], { stdio: pipeLoad ? ["ignore", "ignore", "ignore", "pipe", "pipe"] : "ignore" });
if (pipeLoad) {
  const replies = [];
  chrome.stdio[4].on("data", (chunk) => replies.push(chunk.toString()));
  chrome.stdio[3].write(`${JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: dist } })}\0`);
  for (let i = 0; i < 40 && !replies.join("").includes('"id":1'); i += 1) await sleep(250);
  console.log(`INFO  Extensions.loadUnpacked: ${replies.join("").replace(/\0/g, "").slice(0, 200)}`);
}

async function targets() {
  return (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json();
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); } else events.push(data);
  };
  const ready = new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  const send = async (method, params = {}) => {
    await ready;
    id += 1;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok) => pending.set(id, ok));
  };
  const evaluate = async (expression) => {
    const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description ?? "evaluate failed");
    return reply.result?.result?.value;
  };
  return { send, evaluate, events, close: () => ws.close() };
}

/** The popup has answered once its status pill replaced the loading card. */
const popupLoaded = (body) => /TAIF Protection/.test(body) && !/Loading…/.test(body) && /Current website/.test(body);

async function clickSelector(page, selector) {
  const box = await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
}

try {
  let worker;
  for (let i = 0; i < 90 && !worker; i += 1) {
    await sleep(500);
    worker = (await targets().catch(() => [])).find((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && t.url.endsWith("/background.js"));
  }
  check("extension service worker started", Boolean(worker), worker?.url);
  if (!worker) throw new Error(`Extension did not load. Targets: ${JSON.stringify((await targets().catch(() => [])).map((t) => t.type + " " + t.url))}`);
  const sw = connect(worker.webSocketDebuggerUrl);
  await sw.send("Runtime.enable");
  const extId = new URL(worker.url).host;
  check("loaded extension is TAIF", (await sw.evaluate("chrome.runtime.getManifest().name")) === "Trustworthy Adaptive Interfaces");
  const events = async () => sw.evaluate(`chrome.storage.session.get("taif_events").then((r) => Object.values(r.taif_events ?? {}).flat().map((e) => ({ type: e.event_type, tab: e.tab_id, title: e.title, summary: e.summary, src: e.chain?.source_host, hops: e.chain?.hops.map((h) => h.host), sev: e.severity, status: e.verification_status, newTab: e.chain?.opened_new_tab, id: e.event_id, scenario: e.scenario_id, conf: e.confidence, ack: e.acknowledged })))`);
  const probe = await sw.evaluate("(async () => { const t = performance.now(); await chrome.storage.session.set({ taif_probe: 1 }); await chrome.storage.session.get('taif_probe'); const t2 = performance.now(); await new Promise((r) => setTimeout(r, 100)); return [Math.round(t2 - t), Math.round(performance.now() - t2)]; })()");
  console.log("INFO  storage round-trip ms / 100ms timer ms:", JSON.stringify(probe));
  const base = `http://a.localhost:${PORT}/test-site/redirect/`;

  // Each scenario runs in its own fresh tab.
  const openTab = async (url) => {
    const before = new Set((await targets()).map((t) => t.id));
    await sw.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(url)} }).then(() => true)`);
    await sleep(2500);
    const target = (await targets()).find((t) => t.type === "page" && !before.has(t.id) && t.url.startsWith(url.slice(0, 20)));
    if (!target) throw new Error(`No tab found for ${url}`);
    const page = connect(target.webSocketDebuggerUrl);
    await page.send("Runtime.enable");
    return page;
  };

  /** Polls stored events until one matches, returning it and the time since the trigger. */
  const waitFor = async (match, ms = 30000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const found = (await events()).find(match);
      if (found) return { found, after: Date.now() - start };
      await sleep(100);
    }
    return { found: undefined, after: ms };
  };

  // 1. Same-domain navigation → no event.
  let page = await openTab(base);
  await clickSelector(page, "#same");
  await sleep(2500);
  check("same-domain link actually navigated", (await page.evaluate("location.pathname")).endsWith("page2.html"));
  check("same-domain navigation raises no event", (await events()).length === 0, JSON.stringify(await events()));

  // 5. Multi-hop A → B → C without a click (page redirects itself after 2s, hop after 0.3s).
  await page.evaluate(`location.href = "auto-redirect.html"`);
  const { found: chain, after: chainMs } = await waitFor((e) => e.hops?.at(-1) === "c.localhost");
  const foreign = chain?.hops.filter((host) => host !== "a.localhost") ?? [];
  check("multi-hop chain A→B→C detected", Boolean(chain) && foreign.join(",") === "b.localhost,c.localhost" && chain.src === "a.localhost", `${chainMs} ms after trigger (incl. 2.3 s of page delays) · ${JSON.stringify(chain?.hops)}`);
  check("chain classified as redirect chain, medium", chain?.type === "multi_hop_redirect" && chain?.sev === "medium");

  // 4. Ad opens a new tab (real mouse click, so the popup blocker allows it).
  page = await openTab(base);
  await clickSelector(page, "#popunder");
  const { found: pop, after: popMs } = await waitFor((e) => e.newTab);
  if (!pop) console.log("INFO  tabs after pop-under click:", JSON.stringify((await targets()).filter((t) => t.type === "page").map((t) => t.url)));
  check("pop-under new tab correlated with opener", Boolean(pop) && pop.src === "a.localhost" && pop.hops?.at(-1) === "b.localhost", `${popMs} ms after click · ${pop?.type}`);

  // 3. Click on a non-link that navigates away (monitor off → cause reported as unknown, not guessed).
  page = await openTab(base);
  await clickSelector(page, "#play");
  const { found: play, after: playMs } = await waitFor((e) => !e.newTab && e.src === "a.localhost" && e.hops?.length === 1 && e.hops[0] === "b.localhost");
  check("cross-site navigation after click recorded with real hosts", Boolean(play), `${playMs} ms after click · ${play?.type} · status ${play?.status}`);
  const all = await events();
  check("no query string leaked into stored summaries", !JSON.stringify(all).includes("SECRET"));
  check("nothing is labelled malicious", !/malicious/i.test(all.map((e) => `${e.title} ${e.summary}`).join(" ")));

  // Ad blocking: network rules + native hiding CSS, on a page with real ad markup.
  const adPage = await openTab(`http://a.localhost:${PORT}/test-site/ads.html`);
  await sleep(3000);
  const ads = await adPage.evaluate(`(() => {
    const shown = (id) => { const el = document.getElementById(id); return el ? getComputedStyle(el).display !== "none" : null; };
    return { adsense: shown("ad-adsense"), gpt: shown("div-gpt-ad-1234567890-0"), late: shown("ad-late"), content: shown("content"), content2: shown("content-2"),
      adsbygoogleLoaded: typeof window.adsbygoogle !== "undefined" && !Array.isArray(window.adsbygoogle) };
  })()`);
  check("ad elements hidden automatically (AdSense, GPT, late-loaded)", ads.adsense === false && ads.gpt === false && ads.late === false, JSON.stringify(ads));
  check("normal content stays visible", ads.content === true && ads.content2 === true);
  const adOutcome = await sw.evaluate("chrome.declarativeNetRequest.testMatchOutcome({ url: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', type: 'script', initiator: 'http://a.localhost' }).then((r) => r.matchedRules.length)");
  check("AdSense script request is blocked by network rules", adOutcome > 0, `${adOutcome} matching rule(s)`);

  // Add-on: "Terms and Conditions" phrases are highlighted (CSS Custom Highlight API), including late-added ones.
  if (granted) {
    const termsPage = await openTab(`http://a.localhost:${PORT}/test-site/terms.html`);
    await sleep(4500);
    const termsInfo = await termsPage.evaluate(`(() => { const h = CSS.highlights.get("taif-terms"); return h ? { size: h.size, texts: [...h].map((r) => r.toString()), negative: [...h].some((r) => document.getElementById("negative").contains(r.commonAncestorContainer)) } : null; })()`);
    check("Terms & Conditions phrases highlighted (incl. split + late-added)", termsInfo?.size === 11 && !termsInfo.negative, termsInfo ? `${termsInfo.size} · ${termsInfo.texts.join(" | ")}` : "no highlight");
    await sw.evaluate(`chrome.storage.local.set({ taif_terms_highlight: false }).then(() => true)`);
    await sleep(500);
    check("turning the Terms highlight off clears it", await termsPage.evaluate(`!CSS.highlights.has("taif-terms")`));
    await sw.evaluate(`chrome.storage.local.remove("taif_terms_highlight").then(() => true)`);
  }

  // Opening a site that redirected you before (here b.localhost, from the "Play" redirect) is flagged again.
  if (granted) {
    await openTab(`http://b.localhost:${PORT}/test-site/redirect/landing.html?revisit=1`);
    const { found: revisit } = await waitFor((e) => e.type === "revisit_redirect_site", 15000);
    check("revisiting a site that redirected you is flagged again", Boolean(revisit), revisit ? revisit.title : "no alert");
  }

  // Popunder lab: real ad techniques must be caught; real links/buttons must keep working.
  const lab = `http://a.localhost:${PORT}/test-site/popunder.html`;
  const opened = async (marker) => (await targets()).some((t) => t.type === "page" && t.url.includes(marker));
  let popLab = await openTab(lab);
  await sleep(1200);
  const caught = [];
  for (const [id, marker, name] of [["#t1", "t1-window-open", "window.open from video overlay"], ["#t3", "t3-iframe-open", "popup via hidden iframe"], ["#t4", "t4-synthetic-link", "synthetic target=_blank link click"], ["#t6", "t6-about-blank", "about:blank popunder"]]) {
    await clickSelector(popLab, id);
    await sleep(1200);
    caught.push([name, !(await opened(marker))]);
  }
  await clickSelector(popLab, "#legit-link");
  await sleep(1200);
  await clickSelector(popLab, "#legit-share");
  await sleep(1200);
  const legitOk = (await opened("legit-link")) && (await opened("legit-share"));
  // Close what the legitimate controls opened (the share popup is a toolbar-less window that would keep focus).
  for (const t of (await targets()).filter((target) => target.type === "page" && /legit-(link|share)/.test(target.url))) {
    await fetch(`http://127.0.0.1:${DEBUG}/json/close/${t.id}`);
  }
  await sleep(500);
  await popLab.send("Page.bringToFront").catch(() => undefined);
  await clickSelector(popLab, "#t5");
  await sleep(1500);
  const shielded = (await popLab.evaluate("location.href").catch(() => "")).includes("/blocked.html");
  caught.push(["forced redirect to listed ad network", shielded]);
  popLab = await openTab(lab);
  await sleep(1200);
  await clickSelector(popLab, "#arm2");
  await sleep(300);
  for (const type of ["mousePressed", "mouseReleased"]) await popLab.send("Input.dispatchMouseEvent", { type, x: 400, y: 300, button: "left", clickCount: 1 });
  const { found: overlayEvent } = await waitFor((e) => e.hops?.at(-1) === "b.localhost" && e.src === "a.localhost" && e.summary?.includes("b.localhost") && e.type !== "user_external_link" && !e.newTab, 15000);
  caught.push(["invisible full-page link overlay (alert shown)", Boolean(overlayEvent)]);
  const caughtCount = caught.filter(([, ok]) => ok).length;
  check(`popunder techniques caught: ${caughtCount}/${caught.length}`, caughtCount === caught.length, caught.map(([name, ok]) => `${ok ? "✓" : "✗"} ${name}`).join(" · "));
  check("legitimate link and share button still open", legitOk);

  if (granted) {
    // An extension page to send popup-style actions from.
    const ext = await openTab(`chrome-extension://${extId}/dashboard.html`);

    // A normal link the user clicks must never become an alert (even if the click signal arrives late).
    page = await openTab(base);
    await sleep(1500);
    await clickSelector(page, "#external");
    const { found: link } = await waitFor((e) => e.src === "a.localhost" && !e.newTab && e.hops?.at(-1) === "b.localhost" && e.type === "user_external_link");
    check("normal link click raises no alert", Boolean(link) && link.sev === "informational", link ? `${link.type} · ${link.sev}` : "not reclassified");

    // Original redirect workflow: the pop-under ad tab stays open and shows the alert; "Back" closes it.
    if (pop) {
      const stillOpen = await sw.evaluate(`chrome.tabs.get(${pop.tab}).then(() => true, () => false)`);
      const adTarget = (await targets()).find((t) => t.type === "page" && t.url.includes("popunder=1"));
      let banner = false;
      if (adTarget) {
        const adView = connect(adTarget.webSocketDebuggerUrl);
        for (let i = 0; i < 20 && !banner; i += 1) {
          banner = await adView.evaluate("Boolean(document.getElementById('taif-alert-host'))").catch(() => false);
          if (!banner) await sleep(250);
        }
        adView.close();
      }
      check("pop-under tab stays open and shows the redirect alert automatically", stillOpen && banner, `open ${stillOpen} · alert shown ${banner}`);
      const reply = await ext.evaluate(`chrome.runtime.sendMessage({ type: "TAIF_ACTION", action: "return", eventId: ${JSON.stringify(pop.id)}, tabId: ${pop.tab} })`);
      await sleep(1500);
      const closed = await sw.evaluate(`chrome.tabs.get(${pop.tab}).then(() => false, () => true)`);
      const activeUrl = await sw.evaluate(`chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => tabs[0]?.url ?? "")`);
      check("Back closes the ad tab and returns to the opener tab", closed && activeUrl.includes("a.localhost"), `${JSON.stringify(reply)} · active ${activeUrl}`);
    }

    // Popup speed: open and close five times with an ad-heavy page in the active tab.
    const adLab = await openTab(`http://a.localhost:${PORT}/test-site/ads.html`);
    await sleep(1500);
    const times = [];
    for (let round = 0; round < 5; round += 1) {
      const before = new Set((await targets()).map((t) => t.id));
      const started = Date.now();
      await ext.evaluate("chrome.action.openPopup().then(() => 'ok', (e) => 'error: ' + e.message)");
      let shown;
      let popupTarget;
      for (let i = 0; i < 200 && shown === undefined; i += 1) {
        await sleep(25);
        popupTarget = (await targets()).find((t) => t.url === `chrome-extension://${extId}/index.html` && !before.has(t.id));
        if (!popupTarget) continue;
        const view = connect(popupTarget.webSocketDebuggerUrl);
        const text = await view.evaluate("document.body.innerText").catch(() => "");
        view.close();
        if (/TAIF Protection/.test(text) && /Current website/.test(text)) shown = Date.now() - started;
      }
      times.push(shown ?? -1);
      if (popupTarget) await fetch(`http://127.0.0.1:${DEBUG}/json/close/${popupTarget.id}`);
      await sleep(400);
    }
    check("popup opens fast every time (5 open/close cycles, ad page open)", times.every((ms) => ms > 0 && ms < 1500), `${times.join(" ms, ")} ms`);
    void adLab;

    // Scenario 2 across visits: the countdown starts again at 01:00 on every load.
    const countdown = await openTab(`http://a.localhost:${PORT}/test-site/countdown.html`);
    await sleep(17000);
    await countdown.evaluate("location.reload(), true").catch(() => undefined);
    const { found: restart, after: restartMs } = await waitFor((e) => e.scenario === 2 && /restart/i.test(e.title), 40000);
    check("countdown that restarts on reload is detected", Boolean(restart), restart ? `${restart.title} · ${restartMs} ms` : "");

    // Popup speed and "Got it" on the countdown page.
    const existingIds = new Set((await targets()).map((t) => t.id));
    const startedAt = Date.now();
    await ext.evaluate("chrome.action.openPopup().then(() => 'ok', (e) => 'error: ' + e.message)");
    let shownMs;
    let readyMs;
    let view;
    for (let i = 0; i < 200 && readyMs === undefined; i += 1) {
      await sleep(50);
      const target = (await targets()).find((t) => t.url === `chrome-extension://${extId}/index.html` && !existingIds.has(t.id));
      if (!target) continue;
      view ??= connect(target.webSocketDebuggerUrl);
      const body = await view.evaluate("document.body.innerText").catch(() => "");
      if (shownMs === undefined && /TAIF Protection/.test(body)) shownMs = Date.now() - startedAt;
      if (/Got it/.test(body)) readyMs = Date.now() - startedAt;
    }
    check("popup content appears quickly", shownMs !== undefined && shownMs < 3000, `first paint ${shownMs} ms · results ${readyMs} ms (headless, busy PC)`);
    if (view) {
      const before = await view.evaluate("document.querySelectorAll('.tp-problem').length");
      await view.evaluate("document.querySelector('.tp-problem .tp-btn').click(), true").catch(() => undefined);
      await sleep(1500);
      const after = await view.evaluate("document.querySelectorAll('.tp-problem').length");
      check("Got it removes the card", before > 0 && after === before - 1, `${before} → ${after} cards`);
      view.close();
      for (const t of (await targets()).filter((t) => t.url === `chrome-extension://${extId}/index.html` && !existingIds.has(t.id))) await fetch(`http://127.0.0.1:${DEBUG}/json/close/${t.id}`);
      await sleep(1000);
    }
  }

  // The real toolbar popup must open, close and reopen repeatedly on a normal website.
  // With host access, reopen on the tab the click redirected to, where a redirect alert is primary.
  if (granted) await sw.evaluate(`chrome.tabs.update(${play?.tab}, { active: true }).then(() => true)`);
  else await openTab(base);
  for (let round = 1; round <= 3; round += 1) {
    const opened = await sw.evaluate("chrome.action.openPopup().then(() => 'ok', (e) => 'error: ' + e.message)");
    let popupTarget;
    for (let i = 0; i < 40 && !popupTarget; i += 1) {
      await sleep(250);
      popupTarget = (await targets()).find((t) => t.url === `chrome-extension://${extId}/index.html`);
    }
    let body = "";
    if (popupTarget) {
      const view = connect(popupTarget.webSocketDebuggerUrl);
      for (let i = 0; i < 80 && !popupLoaded(body); i += 1) {
        await sleep(250);
        body = await view.evaluate("document.body.innerText").catch(() => "");
      }
      view.close();
      await fetch(`http://127.0.0.1:${DEBUG}/json/close/${popupTarget.id}`);
      await sleep(1000);
    }
    check(`toolbar popup opens (round ${round})`, opened === "ok" && /TAIF Protection/.test(body) && (!granted || /UNEXPECTED REDIRECT DETECTED/.test(body)), `${opened} · ${body.slice(0, 160).replace(/\s+/g, " ")}`);
  }

  // Popup renders and reports state without throwing.
  const popup = await openTab(`chrome-extension://${extId}/index.html`);
  await sleep(1500);

  // Chrome stops an idle service worker after ~30 s; reopening must still work from a cold worker.
  const swId = worker.id;
  await popup.evaluate(`(${play?.tab ?? "undefined"} === undefined ? Promise.resolve() : chrome.tabs.update(${play?.tab}, { active: true })).then(() => true)`).catch(() => undefined);
  await popup.send("ServiceWorker.enable");
  await popup.send("ServiceWorker.stopAllWorkers");
  await sleep(1500);
  const stopped = !(await targets()).some((t) => t.id === swId);
  const existing = new Set((await targets()).map((t) => t.id));
  const reopened = await popup.evaluate("chrome.action.openPopup().then(() => 'ok', (e) => 'error: ' + e.message)");
  let coldBody = "";
  for (let i = 0; i < 80 && !popupLoaded(coldBody); i += 1) {
    await sleep(250);
    const target = (await targets()).find((t) => t.url === `chrome-extension://${extId}/index.html` && !existing.has(t.id));
    if (target) {
      const view = connect(target.webSocketDebuggerUrl);
      coldBody = await view.evaluate("document.body.innerText").catch(() => "");
      view.close();
    }
  }
  check("popup opens after the worker was stopped", reopened === "ok" && /TAIF Protection/.test(coldBody) && (!granted || /UNEXPECTED REDIRECT DETECTED/.test(coldBody)), `worker stopped: ${stopped} · ${reopened} · ${coldBody.slice(0, 140).replace(/\s+/g, " ")}`);
  const text = await popup.evaluate("document.body.innerText");
  check("popup renders", /TAIF Protection/.test(text), text.slice(0, 120).replace(/\s+/g, " "));
  const exceptions = sw.events.filter((e) => e.method === "Runtime.exceptionThrown");
  check("no uncaught service-worker exceptions", exceptions.length === 0, exceptions.map((e) => e.params.exceptionDetails.text).join("; "));
} catch (error) {
  check("e2e run", false, error instanceof Error ? error.message : String(error));
} finally {
  // Kill only the processes this script started (browser children included).
  for (const child of [chrome, server]) {
    if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    else child.kill();
  }
  await sleep(500);
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
