// Chrome shows a popup only once its page has finished loading. The static "Starting…" card in
// index.html is ready immediately; the React app loads right after, so the popup appears at once.
const start = () => void import("./main");
if (document.readyState === "complete") start();
else window.addEventListener("load", start, { once: true });
