import { runScriptlets } from "./scriptlets";

/**
 * Site-specific scriptlets (uBlock filters data), page context, top frame, document_start.
 * Kept separate from the small all-frames popup guard so frames don't each parse the site list.
 */
(() => {
  const w = window as Window & { __TAIF_SCRIPTLETS__?: boolean };
  if (w.__TAIF_SCRIPTLETS__) return;
  w.__TAIF_SCRIPTLETS__ = true;
  try {
    runScriptlets();
  } catch {
    // Scriptlets are best-effort per site.
  }
})();
