import { defineConfig } from "vite";

/**
 * Injected scripts and the service worker must be standalone classic scripts (no import/export);
 * build one IIFE per mode: scanner, monitor, monitor-main, background.
 */
const ENTRIES: Record<string, { entry: string; name: string }> = {
  background: { entry: "src/background.ts", name: "TAIFBackground" },
  scanner: { entry: "src/content/scan.ts", name: "TAIFScanner" },
  monitor: { entry: "src/content/monitor.ts", name: "TAIFMonitor" },
  enhancer: { entry: "src/content/enhancer.ts", name: "TAIFEnhancer" },
  cosmetic: { entry: "src/content/cosmetic.ts", name: "TAIFCosmetic" },
  scriptlets: { entry: "src/content/scriptlets-main.ts", name: "TAIFScriptlets" },
  "monitor-main": { entry: "src/content/monitor-main.ts", name: "TAIFMonitorMain" },
  terms: { entry: "src/content/terms.ts", name: "TAIFTerms" }
};

export default defineConfig(({ mode }) => {
  const target = ENTRIES[mode] ?? ENTRIES.scanner;
  return {
    build: {
      outDir: `dist-content/${mode in ENTRIES ? mode : "scanner"}`,
      emptyOutDir: true,
      lib: {
        entry: target.entry,
        name: target.name,
        formats: ["iife"],
        fileName: () => `${mode in ENTRIES ? mode : "scanner"}.js`
      }
    }
  };
});
