/** TAIF's "ad redirect blocked" page: shown instead of a page on a known ad/popup domain. */

interface BlockedInfo { host?: string; url?: string; from?: string; openedBy?: number }

const $ = (id: string) => document.getElementById(id)!;

async function act(action: "back" | "close" | "continue") {
  const response = await chrome.runtime.sendMessage({ type: "TAIF_BLOCKED_ACTION", action }) as { error?: string } | undefined;
  if (response?.error) $("summary").textContent = response.error;
}

void (async () => {
  const info = await chrome.runtime.sendMessage({ type: "TAIF_BLOCKED_INFO" }) as BlockedInfo | undefined;
  if (info?.host) {
    $("title").textContent = `TAIF stopped a redirect to ${info.host}.`;
    $("to").textContent = info.url ?? info.host;
    $("route").hidden = false;
  }
  $("from").textContent = info?.from ?? (info?.openedBy !== undefined ? "the tab that opened this one" : "the previous page");
  $("back").textContent = info?.openedBy !== undefined && !info.from ? "Back to the previous tab (close this one)" : info?.from ? `Back to ${info.from}` : "Back";
  ($("back") as HTMLButtonElement).focus();
})();

$("back").addEventListener("click", () => void act("back"));
$("close").addEventListener("click", () => void act("close"));
$("continue").addEventListener("click", () => void act("continue"));
