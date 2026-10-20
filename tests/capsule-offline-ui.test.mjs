import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

class Node {
  constructor() {
    this.value = "";
    this.files = [];
    this.hidden = false;
    this.disabled = false;
    this.listeners = new Map();
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  click() { return this.listeners.get("click")?.(); }
  replaceChildren(...children) { this.children = children; }
  append() {}
  setAttribute() {}
}

test("offline save success requires an active worker with the current verified assets", async () => {
  const nodes = new Map();
  globalThis.document = {
    addEventListener() {},
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new Node());
      return nodes.get(id);
    },
    createElement: () => new Node(),
    body: new Node()
  };
  globalThis.window = { addEventListener() {} };
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.location = { href: "https://example.test/aru-remembrance-field/capsule/" };
  const html = readFileSync(new URL("../capsule/index.html", import.meta.url));
  const appUrl = new URL("../capsule/app.mjs", import.meta.url).href;
  const canonical = new URL("../capsule/", import.meta.url).href;
  let reply = { ok: true, htmlDigest: createHash("sha256").update(html).digest("hex"), appUrl };
  let networkRequests = 0;
  let updates = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(url.href, canonical);
    assert.equal(options.cache, "reload");
    networkRequests++;
    return { ok: true, url: canonical, arrayBuffer: async () => html };
  };
  const worker = { postMessage(_message, ports) { ports[0].postMessage(reply); } };
  const registration = { active: worker, installing: null, waiting: null,
    async update() { updates++; } };
  Object.defineProperty(globalThis, "navigator", { configurable: true,
    value: { serviceWorker: { async register(path, options) {
      assert.equal(path, "./offline-worker.js");
      assert.deepEqual(options, { scope: "./", updateViaCache: "none" });
      return registration;
    }, ready: Promise.resolve(registration) } } });

  await import("../capsule/app.mjs");
  const button = document.getElementById("save-offline-reader");
  const result = document.getElementById("offline-status");
  await button.click();
  assert.match(result.textContent, /Verified reader saved/);
  assert.equal(button.disabled, false);

  reply = { ok: false };
  await button.click();
  assert.match(result.textContent, /Could not verify a current offline reader/);
  reply = { ok: true, htmlDigest: "0".repeat(64), appUrl };
  await button.click();
  assert.match(result.textContent, /Could not verify a current offline reader/);
  reply = { ok: true, htmlDigest: createHash("sha256").update(html).digest("hex"),
    appUrl: `${appUrl}?old=1` };
  await button.click();
  assert.match(result.textContent, /Could not verify a current offline reader/);
  assert.equal(networkRequests, 4);
  assert.equal(updates, 4);
  assert.equal(button.disabled, false);
});
