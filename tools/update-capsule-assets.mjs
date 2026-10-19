// Refresh content-based module URLs whenever the capsule JavaScript changes.
// This keeps a new page from loading an older app or core module from cache.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const corePath = new URL("../capsule/core.mjs", import.meta.url);
const appPath = new URL("../capsule/app.mjs", import.meta.url);
const htmlPath = new URL("../capsule/index.html", import.meta.url);
const hash = data => createHash("sha256").update(data).digest("hex");

function replaceOnce(value, pattern, replacement, label) {
  const matches = value.match(new RegExp(pattern.source, "g")) ?? [];
  if (matches.length !== 1) throw new Error(`Expected one ${label} reference, found ${matches.length}`);
  return value.replace(pattern, replacement);
}

const coreHash = hash(readFileSync(corePath));
const app = readFileSync(appPath, "utf8");
const versionedApp = replaceOnce(app, /from "\.\/core\.mjs(?:\?v=[a-f0-9]{64})?";/,
  `from "./core.mjs?v=${coreHash}";`, "core module");
if (versionedApp !== app) writeFileSync(appPath, versionedApp);

const appHash = hash(Buffer.from(versionedApp));
const html = readFileSync(htmlPath, "utf8");
const versionedHtml = replaceOnce(html, /src="\.\/app\.mjs(?:\?v=[a-f0-9]{64})?"/,
  `src="./app.mjs?v=${appHash}"`, "app module");
if (versionedHtml !== html) writeFileSync(htmlPath, versionedHtml);

console.log(`Capsule assets: core ${coreHash.slice(0, 12)}, app ${appHash.slice(0, 12)}`);
