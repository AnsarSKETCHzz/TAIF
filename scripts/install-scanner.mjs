import { copyFile, readFile, rm } from "node:fs/promises";
import { Script } from "node:vm";

/**
 * Copies the standalone bundles into dist/ and refuses any that would not run as a classic
 * script ("Cannot use import statement outside a module" in Chrome).
 */
for (const name of ["background", "scanner", "monitor", "monitor-main", "enhancer", "cosmetic", "scriptlets", "terms"]) {
  const staged = new URL(`../dist-content/${name}/${name}.js`, import.meta.url);
  const bundle = await readFile(staged, "utf8");
  try {
    new Script(bundle, { filename: `${name}.js` });
  } catch (error) {
    throw new Error(`${name}.js is not a standalone classic script: ${error instanceof Error ? error.message : error}`);
  }
  await copyFile(staged, new URL(`../dist/${name}.js`, import.meta.url));
}
await rm(new URL("../dist-content", import.meta.url), { recursive: true, force: true });
// axe-core is injected only when the user asks for a full accessibility audit.
await copyFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), new URL("../dist/axe.min.js", import.meta.url));
