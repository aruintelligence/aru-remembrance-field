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

function harness(changedAsset = null, networkResult = null) {
  const handlers = new Map();
  const cacheStore = new Map();
  const calls = { skipped: 0, claimed: 0, network: 0, networkRequests: [] };
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
    fetch: async (request, options) => {
      calls.network++;
      calls.networkRequests.push({ url: request.url, cache: options?.cache });
      if (networkResult) return networkResult(request);
      throw Error("Offline");
    } });
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
  const message = async data => {
    let reply;
    let pending;
    handlers.get("message")({ data, ports: [{ postMessage(value) { reply = value; } }],
      waitUntil(promise) { pending = promise; } });
    if (pending) await pending;
    return reply;
  };
  return { cacheStore, calls, lifecycle, request, message };
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
  assert.equal(environment.calls.network, 2);
  assert.deepEqual(environment.calls.networkRequests, [
    { url: scope, cache: "reload" },
    { url: `${scope}index.html`, cache: "reload" }
  ]);
  assert.equal(environment.request(`${scope}private-draft.json`, "navigate", "document"), undefined);
  assert.equal(environment.request(`${scope}app.mjs?v=wrong`, "cors", "script"), undefined);
  assert.equal(environment.request(`${scope}index.html?secret=anything`, "navigate", "document"), undefined);
  assert.equal(environment.request("https://example.test/other/", "navigate", "document"), undefined);
});

test("online navigations use the current page without replacing the verified offline snapshot", async () => {
  const fresh = "<!doctype html><title>New release</title>";
  const environment = harness(null, () => new Response(fresh));
  await environment.lifecycle("install");
  const page = await environment.request(scope, "navigate", "document");
  assert.equal(await page.text(), fresh);
  assert.deepEqual(environment.calls.networkRequests, [{ url: scope, cache: "reload" }]);
  const snapshot = [...environment.cacheStore.values()][0].get(scope);
  assert.equal(await snapshot.text(), html.toString());
  const moduleUrl = [...assets.keys()][1];
  const moduleResponse = await environment.request(moduleUrl, "cors", "script");
  assert.deepEqual(Buffer.from(await moduleResponse.arrayBuffer()), app);
  assert.equal(environment.calls.network, 1);
});

test("a failed online navigation falls back to the verified saved reader", async () => {
  const environment = harness(null, () => new Response("Unavailable", { status: 503 }));
  await environment.lifecycle("install");
  const page = await environment.request(`${scope}index.html`, "navigate", "document");
  assert.equal(await page.text(), html.toString());
  assert.equal(environment.calls.network, 1);
});

test("the active worker reports readiness only while its saved assets pass verification", async () => {
  const environment = harness();
  await environment.lifecycle("install");
  assert.deepEqual(JSON.parse(JSON.stringify(await environment.message({ type: "aru-capsule-reader-verify" }))), {
    ok: true, htmlDigest: hash(html), appUrl: `${scope}app.mjs?v=${hash(app)}`
  });
  assert.equal(await environment.message({ type: "unrelated-message" }), undefined);
  [...environment.cacheStore.values()][0].set(scope, new Response("changed after install"));
  assert.deepEqual(JSON.parse(JSON.stringify(await environment.message({ type: "aru-capsule-reader-verify" }))),
    { ok: false });
});

test("a mismatched asset aborts install without replacing the previous offline reader", async () => {
  const environment = harness(scope);
  environment.cacheStore.set("aru-capsule-reader-previous", new Map([["previous", "kept"]]));
  await assert.rejects(environment.lifecycle("install"), /did not match/);
  assert.equal(environment.calls.skipped, 0);
  assert.equal(environment.cacheStore.size, 1);
  assert.equal(environment.cacheStore.has("aru-capsule-reader-previous"), true);
});
