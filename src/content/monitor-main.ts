import { startPopupGuard } from "./popup-guard";

/**
 * Runs in the page's own (MAIN) context at document_start, in every frame, before page scripts:
 *  - the popup guard (blocks popunder techniques; real clicks on links/buttons still work)
 *  - transparent wrappers on the notification permission APIs, so the monitor can see a request
 *    happened (they never change the result, grant, or block anything)
 */
(() => {
  const w = window as Window & { __TAIF_MAIN__?: boolean };
  if (w.__TAIF_MAIN__) return;
  w.__TAIF_MAIN__ = true;
  try {
    startPopupGuard();
  } catch {
    // The page keeps working without the guard.
  }
  if (window.top !== window) return;
  const report = () => window.postMessage({ __taif: "notification_request" }, "*");
  try {
    const original = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = ((...args: Parameters<typeof Notification.requestPermission>) => {
      report();
      return original(...args);
    }) as typeof Notification.requestPermission;
  } catch {
    // Notification API unavailable on this page.
  }
  try {
    const proto = PushManager.prototype;
    const subscribe = proto.subscribe;
    proto.subscribe = function (this: PushManager, ...args: Parameters<PushManager["subscribe"]>) {
      report();
      return subscribe.apply(this, args);
    };
  } catch {
    // Push API unavailable on this page.
  }
})();
