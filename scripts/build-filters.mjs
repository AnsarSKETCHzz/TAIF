/**
 * Builds TAIF's ad-blocking data from:
 *   EasyList, EasyPrivacy  dual-licensed GPLv3 / CC BY-SA 3.0 (https://easylist.to/pages/licence.html)
 *   uBlock filters         GPLv3 (https://github.com/uBlockOrigin/uAssets/blob/master/LICENSE)
 * Outputs:
 *   public/rulesets/<id>.json            declarativeNetRequest static rulesets
 *   public/filters/generic.css           generic element hiding, injected natively by Chrome
 *   public/filters/cosmetic.json         site-specific hiding rules and exceptions
 *   public/filters/ad-domains.json, popup-domains.json
 *   public/filters/meta.json             versions and verified rule counts
 *
 * Usage: node scripts/build-filters.mjs [--download]   (--download refreshes filters-src/*.txt)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { convertFilterList, hidingCss, mergeCosmetic } from "../src/shared/filters.ts";

const LISTS = [
  { id: "easylist", title: "EasyList (ads)", url: "https://easylist.to/easylist/easylist.txt", cosmetic: true, licence: "GPLv3 / CC BY-SA 3.0" },
  { id: "ublock", title: "uBlock filters (ads, popunders)", url: "https://ublockorigin.github.io/uAssets/filters/filters.txt", cosmetic: true, licence: "GPLv3" },
  { id: "easyprivacy", title: "EasyPrivacy (trackers)", url: "https://easylist.to/easylist/easyprivacy.txt", cosmetic: false, licence: "GPLv3 / CC BY-SA 3.0" }
];
// Chrome guarantees 30,000 enabled static rules per extension; all three lists together stay below it.
const MAX_RULES_PER_LIST = 12000;
const root = new URL("..", import.meta.url);
const download = process.argv.includes("--download");

await mkdir(new URL("filters-src/", root), { recursive: true });
await mkdir(new URL("public/rulesets/", root), { recursive: true });
await mkdir(new URL("public/filters/", root), { recursive: true });

const meta = {
  builtAt: new Date().toISOString(),
  licence: "EasyList and EasyPrivacy are dual-licensed under GPLv3 and CC BY-SA 3.0 (https://easylist.to/pages/licence.html); uBlock filters are GPLv3 (https://github.com/uBlockOrigin/uAssets).",
  lists: []
};
let cosmetic = { generic: [], specific: {}, exceptions: {}, genericHide: [] };
const adDomains = new Set();
const popupDomains = new Set();
let total = 0;
const scriptlets = {};

for (const list of LISTS) {
  const source = new URL(`filters-src/${list.id}.txt`, root);
  let text;
  if (download) {
    const response = await fetch(list.url);
    if (!response.ok) throw new Error(`${list.url}: HTTP ${response.status}`);
    text = await response.text();
    if (!/^(\[Adblock Plus|! Title)/.test(text)) throw new Error(`${list.url} is not an Adblock Plus-style filter list.`);
    await writeFile(source, text);
  } else {
    text = await readFile(source, "utf8");
  }
  const version = text.match(/^! (?:Version|Last modified): (.+)$/m)?.[1] ?? "unknown";
  const result = convertFilterList(text, { maxRules: MAX_RULES_PER_LIST });
  for (const rule of result.rules) {
    if (!rule.condition.urlFilter && !rule.condition.requestDomains) throw new Error(`${list.id} rule ${rule.id} has no match condition.`);
  }
  total += result.rules.length;
  await writeFile(new URL(`public/rulesets/${list.id}.json`, root), JSON.stringify(result.rules));
  if (list.cosmetic) {
    cosmetic = mergeCosmetic(cosmetic, result.cosmetic);
    result.blockedDomains.forEach((domain) => adDomains.add(domain));
    for (const [site, calls] of Object.entries(result.scriptlets)) (scriptlets[site] ??= []).push(...calls);
  }
  result.popupDomains.forEach((domain) => popupDomains.add(domain));
  meta.lists.push({
    id: list.id, title: list.title, url: list.url, licence: list.licence, version,
    rules: result.rules.length,
    allowRuleIds: result.rules.filter((rule) => rule.action.type !== "block").map((rule) => rule.id),
    groupedDomains: result.stats.groupedDomains,
    cosmeticGeneric: list.cosmetic ? result.stats.cosmeticGeneric : 0,
    cosmeticSpecific: list.cosmetic ? result.stats.cosmeticSpecific : 0,
    skipped: result.stats.skipped
  });
  console.log(`${list.id} ${version}: ${result.rules.length} DNR rules (${result.stats.groupedDomains} domains grouped), ${result.stats.cosmeticGeneric} generic + ${result.stats.cosmeticSpecific} site cosmetic, skipped ${Object.values(result.stats.skipped).reduce((a, b) => a + b, 0)}`);
}
// Ad-navigation shield: opening a page on a known ad or ad-popup domain (popunders, forced
// redirects, ad clicks) goes to TAIF's explanation page instead. Same idea as uBlock's strict blocking.
const shieldDomains = [...new Set([...popupDomains, ...adDomains])].sort();
const shield = [];
for (let index = 0; index < shieldDomains.length; index += 1000) {
  shield.push({
    id: shield.length + 1,
    priority: 50,
    action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
    condition: { requestDomains: shieldDomains.slice(index, index + 1000), resourceTypes: ["main_frame"] }
  });
}
await writeFile(new URL("public/rulesets/shield.json", root), JSON.stringify(shield));
total += shield.length;
meta.shield = { domains: shieldDomains.length, rules: shield.length };
if (total > 29000) throw new Error(`${total} rules exceed Chrome's guaranteed static rule count.`);

// Site-specific anti-popup scriptlets (uBlock filters), bundled into the page-context scriptlet runner.
await mkdir(new URL("src/generated/", root), { recursive: true });
await writeFile(new URL("src/generated/scriptlets.json", root), JSON.stringify(scriptlets));
meta.scriptlets = { sites: Object.keys(scriptlets).length, calls: Object.values(scriptlets).reduce((sum, calls) => sum + calls.length, 0) };

// Generic hiding as one stylesheet: Chrome matches it natively (fast, and covers ads added later).
await writeFile(new URL("public/filters/generic.css", root), hidingCss(cosmetic.generic));
// Site-specific rules stay as data; the worker builds a small stylesheet per site.
await writeFile(new URL("public/filters/cosmetic.json", root), JSON.stringify({ ...cosmetic, generic: [] }));
await writeFile(new URL("public/filters/ad-domains.json", root), JSON.stringify([...adDomains].sort()));
await writeFile(new URL("public/filters/popup-domains.json", root), JSON.stringify([...popupDomains].sort()));
meta.cosmetic = { generic: cosmetic.generic.length, sites: Object.keys(cosmetic.specific).length, exceptionSites: Object.keys(cosmetic.exceptions).length };
await writeFile(new URL("public/filters/meta.json", root), JSON.stringify(meta, null, 2));
await writeFile(new URL("public/filters/LICENSE-filters.txt", root), `${meta.licence}\nSource lists: ${LISTS.map((list) => list.url).join(", ")}\nConverted by TAIF (scripts/build-filters.mjs); unsupported filters were skipped, not altered.\n`);
console.log(`total ${total} rules · ${cosmetic.generic.length} generic selectors · ${adDomains.size} ad domains · ${popupDomains.size} popup domains`);
