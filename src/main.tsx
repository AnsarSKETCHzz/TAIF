import React from "react";
import { createRoot } from "react-dom/client";
import "./ui/styles.css";

const isPopup = document.body.classList.contains("popup");
// Each page loads only its own UI: the popup never downloads the dashboard, and vice versa.
const Page = React.lazy(() => isPopup
  ? import("./ui/Popup").then((module) => ({ default: module.Popup }))
  : import("./ui/App").then((module) => ({ default: module.App })));

/** A render error would otherwise unmount everything and leave Chrome a zero-height popup it never shows. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { message?: string }> {
  state: { message?: string } = {};

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (this.state.message === undefined) return this.props.children;
    return (
      <div className="tp-boot" role="alert">
        <strong>TAIF Protection hit an error</strong>
        {this.state.message}
        <p>Close and reopen the popup. If it repeats, open chrome://extensions → TAIF → Errors.</p>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><ErrorBoundary><React.Suspense fallback={null}><Page /></React.Suspense></ErrorBoundary></React.StrictMode>
);
