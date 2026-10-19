// Refresh content-based module URLs whenever the capsule JavaScript changes.
// This keeps a new page from loading an older app or core module from cache.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const corePath = new URL("../capsule/core.mjs", import.meta.url);
const appPath = new URL("../capsule/app.mjs", import.meta.url);
const htmlPath = new URL("../capsule/index.html", import.meta.url);
const workerPath = new URL("../capsule/offline-worker.js", import.meta.url);
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

// The service worker installs one consistent snapshot of the page and its modules.
// Updating any one of these files changes its cache name and installs a new shell.
const shellHash = hash(Buffer.from(`${coreHash}\n${appHash}\n${hash(Buffer.from(versionedHtml))}`));
const htmlHash = hash(Buffer.from(versionedHtml));
const worker = readFileSync(workerPath, "utf8");
let versionedWorker = replaceOnce(worker,
  /const CACHE_NAME = "aru-capsule-reader-[a-f0-9]{64}";/,
  `const CACHE_NAME = "aru-capsule-reader-${shellHash}";`, "offline cache");
versionedWorker = replaceOnce(versionedWorker, /"\.\/app\.mjs\?v=[a-f0-9]{64}"/,
  `"./app.mjs?v=${appHash}"`, "offline app module");
versionedWorker = replaceOnce(versionedWorker, /"\.\/core\.mjs\?v=[a-f0-9]{64}"/,
  `"./core.mjs?v=${coreHash}"`, "offline core module");
versionedWorker = replaceOnce(versionedWorker,
  /const DIGESTS = \["[a-f0-9]{64}", "[a-f0-9]{64}", "[a-f0-9]{64}"\];/,
  `const DIGESTS = ["${htmlHash}", "${appHash}", "${coreHash}"];`, "offline asset digests");
if (versionedWorker !== worker) writeFileSync(workerPath, versionedWorker);

console.log(`Capsule assets: core ${coreHash.slice(0, 12)}, app ${appHash.slice(0, 12)}, offline ${shellHash.slice(0, 12)}`);
