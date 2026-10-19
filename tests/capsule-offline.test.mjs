import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const root = new URL("../capsule/", import.meta.url);
const file = name => readFileSync(new URL(name, root));
const hash = data => createHash("sha256").update(data).digest("hex");
const html = file("index.html");
const app = file("app.mjs");
const core = file("core.mjs");
const worker = file("offline-worker.js").toString();
const scope = "https://example.test/aru-remembrance-field/capsule/";
const assets = new Map([
  [scope, html],
  [`${scope}app.mjs?v=${hash(app)}`, app],
  [`${scope}core.mjs?v=${hash(core)}`, core]
]);

function harness(changedAsset = null) {
  const handlers = new Map();
  const cacheStore = new Map();
  const calls = { skipped: 0, claimed: 0, network: 0 };
  const caches = {
    async open(name) {
      if (!cacheStore.has(name)) cacheStore.set(name, new Map());
      const entries = cacheStore.get(name);
      return {
        async addAll(requests) {
          for (const request of requests) {
            const contents = assets.get(request.url);
            if (!contents) throw Error(`Unexpected cache request ${request.url}`);
            entries.set(request.url, new Response(request.url === changedAsset ?
              Buffer.concat([contents, Buffer.from("stale")]) : contents));
          }
        },
        async match(request) { return entries.get(request.url ?? request)?.clone(); }
      };
    },
    async keys() { return [...cacheStore.keys()]; },
    async delete(name) { return cacheStore.delete(name); }
  };
  const self = {
    registration: { scope },
    clients: { async claim() { calls.claimed++; } },
    async skipWaiting() { calls.skipped++; },
    addEventListener(name, fn) { handlers.set(name, fn); }
  };
  runInNewContext(worker, { self, caches, crypto: webcrypto, Request, URL, Uint8Array,
    fetch: async () => { calls.network++; throw Error("Offline"); } });
  const lifecycle = name => {
    let pending;
    handlers.get(name)({ waitUntil(promise) { pending = promise; } });
    return pending;
  };
  const request = (url, mode, destination) => {
    let response;
    handlers.get("fetch")({ request: { url, method: "GET", mode, destination },
      respondWith(promise) { response = promise; } });
    return response;
  };
  return { cacheStore, calls, lifecycle, request };
}

test("offline shell is pinned to the current HTML and both current modules", () => {
  const appHash = hash(app);
  const coreHash = hash(core);
  const htmlHash = hash(html);
  assert.match(worker, new RegExp(`"\\./app\\.mjs\\?v=${appHash}"`));
  assert.match(worker, new RegExp(`"\\./core\\.mjs\\?v=${coreHash}"`));
  assert.ok(worker.includes(`const DIGESTS = ["${htmlHash}", "${appHash}", "${coreHash}"];`));
  const normalized = worker.replace(/aru-capsule-reader-[a-f0-9]{64}/,
    `aru-capsule-reader-${"0".repeat(64)}`)
    .replace(/app\.mjs\?v=[a-f0-9]{64}/, `app.mjs?v=${"0".repeat(64)}`)
    .replace(/core\.mjs\?v=[a-f0-9]{64}/, `core.mjs?v=${"0".repeat(64)}`)
    .replace(/const DIGESTS = \[[^\n]+;/,
      `const DIGESTS = ["${"0".repeat(64)}", "${"0".repeat(64)}", "${"0".repeat(64)}"];`);
  assert.ok(worker.includes(`aru-capsule-reader-${hash(`${coreHash}\n${appHash}\n${htmlHash}\n${hash(normalized)}`)}`));
});

test("an installed reader serves its verified shell offline and ignores all other requests", async () => {
  const environment = harness();
  await environment.lifecycle("install");
  assert.equal(environment.calls.skipped, 1);
  assert.equal([...environment.cacheStore.values()][0].size, 3);
  environment.cacheStore.set("aru-capsule-reader-obsolete", new Map());
  environment.cacheStore.set("another-app-cache", new Map());
  await environment.lifecycle("activate");
  assert.equal(environment.calls.claimed, 1);
  assert.equal(environment.cacheStore.has("aru-capsule-reader-obsolete"), false);
  assert.equal(environment.cacheStore.has("another-app-cache"), true);

  const page = await environment.request(scope, "navigate", "document");
  assert.equal(await page.text(), html.toString());
  const alias = await environment.request(`${scope}index.html`, "navigate", "document");
  assert.equal(await alias.text(), html.toString());
  for (const [url, contents] of [...assets].slice(1)) {
    const response = await environment.request(url, "cors", "script");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), contents);
  }
  assert.equal(environment.calls.network, 0);
  assert.equal(environment.request(`${scope}private-draft.json`, "navigate", "document"), undefined);
  assert.equal(environment.request(`${scope}app.mjs?v=wrong`, "cors", "script"), undefined);
  assert.equal(environment.request(`${scope}index.html?secret=anything`, "navigate", "document"), undefined);
  assert.equal(environment.request("https://example.test/other/", "navigate", "document"), undefined);
});

test("a mismatched asset aborts install without replacing the previous offline reader", async () => {
  const environment = harness(scope);
  environment.cacheStore.set("aru-capsule-reader-previous", new Map([["previous", "kept"]]));
  await assert.rejects(environment.lifecycle("install"), /did not match/);
  assert.equal(environment.calls.skipped, 0);
  assert.equal(environment.cacheStore.size, 1);
  assert.equal(environment.cacheStore.has("aru-capsule-reader-previous"), true);
});
