import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDraft } from "../capsule/core.mjs";

class Node {
  constructor() {
    this.value = "";
    this.files = [];
    this.hidden = false;
    this.disabled = false;
    this.style = {};
    this.listeners = new Map();
    this.classList = { toggle() {} };
  }
  addEventListener(event, callback) {
    const callbacks = this.listeners.get(event) ?? [];
    callbacks.push(callback);
    this.listeners.set(event, callbacks);
  }
  dispatch(event) { return Promise.all((this.listeners.get(event) ?? []).map(callback => callback())); }
  click() { return this.dispatch("click"); }
  append(...children) { this.children = [...(this.children ?? []), ...children]; }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  removeAttribute() {}
  scrollIntoView() {}
  focus() {}
  load() {}
  remove() {}
}

function memoryIndexedDB() {
  let records = new Map();
  let failCommit = false;
  const issue = (transaction, callback) => {
    const request = {};
    transaction.pending++;
    queueMicrotask(() => {
      if (transaction.aborted) return;
      request.result = callback();
      request.onsuccess?.();
      transaction.pending--;
      queueMicrotask(() => transaction.complete());
    });
    return request;
  };
  return {
    get records() { return records; },
    failNextCommit() { failCommit = true; },
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          createObjectStore() {}, close() {},
          transaction(name, mode) {
            assert.equal(name, "encrypted-drafts");
            const working = new Map(records);
            const transaction = {
              pending: 0, aborted: false,
              abort() { this.aborted = true; queueMicrotask(() => this.onabort?.()); },
              complete() {
                if (this.aborted || this.pending) return;
                if (mode === "readwrite" && failCommit) {
                  failCommit = false;
                  this.error = Error("Simulated storage failure");
                  this.aborted = true;
                  this.onabort?.();
                  return;
                }
                if (mode === "readwrite") records = working;
                this.oncomplete?.();
              },
              objectStore() {
                return {
                  get: key => issue(transaction, () => working.get(key)),
                  put: (value, key) => issue(transaction, () => working.set(key, value)),
                  delete: key => issue(transaction, () => working.delete(key))
                };
              }
            };
            return transaction;
          }
        };
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  };
}

async function eventually(predicate, message) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.fail(message);
}

test("opt-in recovery stores ciphertext, follows edits, restores, and detects another tab", async () => {
  const nodes = new Map();
  const windowListeners = new Map();
  const documentListeners = new Map();
  const database = memoryIndexedDB();
  globalThis.document = {
    visibilityState: "visible",
    addEventListener: (name, callback) => documentListeners.set(name, callback),
    getElementById: id => {
      if (!nodes.has(id)) nodes.set(id, new Node());
      return nodes.get(id);
    },
    createElement: () => new Node(), body: new Node()
  };
  globalThis.window = { addEventListener: (name, callback) => windowListeners.set(name, callback) };
  globalThis.indexedDB = database;
  globalThis.confirm = () => true;
  globalThis.matchMedia = () => ({ matches: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  await import("../capsule/app.mjs");
  const el = id => document.getElementById(id);
  const phrase = "private on-device recovery phrase 2026";
  assert.equal(database.records.size, 0, "recovery must not start automatically");
  el("recipient").value = "Alex";
  el("letter").value = "An unfinished opening letter";
  el("memory-title").value = "At the beach";
  el("memory-story").value = "We found a shell";
  el("recovery-passphrase").value = phrase;
  el("recovery-confirm").value = phrase;
  await el("enable-recovery").click();
  assert.equal(el("enable-recovery").disabled, true);
  assert.equal(el("recovery-passphrase").value, "");
  let record = database.records.get("current");
  assert.ok(record?.owner);
  assert.equal(JSON.stringify(record).includes("Alex"), false);
  assert.equal(JSON.stringify(record).includes(phrase), false);
  assert.equal((await openDraft(record.envelope, phrase)).pending.story, "We found a shell");

  el("memory-story").value = "We found a shell and watched the stars";
  await el("memory-story").dispatch("input");
  await eventually(() => database.records.get("current").envelope.salt !== record.envelope.salt,
    "a changed draft should be saved after a pause");
  record = database.records.get("current");
  assert.equal((await openDraft(record.envelope, phrase)).pending.story,
    "We found a shell and watched the stars");

  const photo = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII="),
    char => char.charCodeAt(0));
  const voice = readFileSync(new URL("./fixtures/voice-sample.mp3", import.meta.url));
  el("memory-photo").files = [{ size: photo.length, type: "image/png",
    arrayBuffer: async () => photo.buffer }];
  el("memory-audio").files = [{ size: voice.length, type: "audio/mpeg", name: "voice.mp3",
    arrayBuffer: async () => voice }];
  await el("memory-photo").dispatch("change");
  await el("memory-audio").dispatch("change");
  await eventually(() => database.records.get("current").envelope.salt !== record.envelope.salt,
    "selected media should join the encrypted recovery copy");
  record = database.records.get("current");
  const withMedia = await openDraft(record.envelope, phrase);
  assert.ok(withMedia.pending.photo.startsWith("data:image/png;base64,"));
  assert.ok(withMedia.pending.audio.startsWith("data:audio/mpeg;base64,"));
  assert.equal(JSON.stringify(record).includes("data:image"), false);
  el("memory-photo").files = [];
  el("memory-audio").files = [];
  await el("memory-photo").dispatch("change");
  await el("memory-audio").dispatch("change");
  await eventually(() => database.records.get("current").envelope.salt !== record.envelope.salt,
    "cleared media should be removed from the recovery copy");
  record = database.records.get("current");
  assert.equal((await openDraft(record.envelope, phrase)).pending.photo, null);
  assert.equal((await openDraft(record.envelope, phrase)).pending.audio, null);

  el("memory-photo").files = [{ size: 600_001, type: "image/png" }];
  await el("memory-photo").dispatch("change");
  await eventually(() => /Choose a photo under 600 KB/.test(el("recovery-status").textContent),
    "an invalid selection should explain why the last good copy is retained");
  assert.equal(database.records.get("current"), record);
  assert.equal(el("enable-recovery").disabled, true, "recoverable input errors keep the session active");
  el("memory-photo").files = [];
  await el("memory-photo").dispatch("change");
  await eventually(() => database.records.get("current").envelope.salt !== record.envelope.salt,
    "fixing the selection should resume encrypted recovery");

  record = database.records.get("current");
  el("letter").value = "A sentence before backgrounding the page";
  await el("letter").dispatch("input");
  document.visibilityState = "hidden";
  documentListeners.get("visibilitychange")();
  await eventually(() => database.records.get("current").envelope.salt !== record.envelope.salt,
    "backgrounding should flush immediately without waiting for the debounce");
  document.visibilityState = "visible";

  record = database.records.get("current");
  el("letter").value = "A final sentence before leaving the page";
  await el("letter").dispatch("input");
  await windowListeners.get("pagehide")();
  assert.notEqual(database.records.get("current").envelope.salt, record.envelope.salt);
  assert.equal(el("enable-recovery").disabled, false);
  el("recipient").value = "";
  el("letter").value = "";
  el("memory-title").value = "";
  el("memory-story").value = "";
  el("recovery-unlock").value = "incorrect recovery phrase 2026";
  await el("restore-recovery").click();
  assert.match(el("recovery-status").textContent, /Unable to open/);
  assert.equal(el("recipient").value, "");

  el("recovery-unlock").value = phrase;
  await el("restore-recovery").click();
  assert.equal(el("recipient").value, "Alex");
  assert.equal(el("memory-story").value, "We found a shell and watched the stars");
  assert.match(el("recovery-status").textContent, /Automatic saving is paused/);

  el("recovery-passphrase").value = phrase;
  el("recovery-confirm").value = phrase;
  await el("enable-recovery").click();
  const replacement = database.records.get("current");
  database.records.set("current", { ...replacement, owner: "a-different-tab" });
  el("letter").value = "An edit from the old tab";
  await el("letter").dispatch("input");
  await eventually(() => /Another capsule tab changed/.test(el("recovery-status").textContent),
    "the older tab should stop when another tab owns the recovery copy");
  assert.equal(el("enable-recovery").disabled, false);
  assert.equal(database.records.get("current").owner, "a-different-tab");

  await el("forget-recovery").click();
  assert.equal(database.records.has("current"), false);
  assert.equal(el("letter").value, "An edit from the old tab");

  el("recovery-passphrase").value = phrase;
  el("recovery-confirm").value = phrase;
  await el("enable-recovery").click();
  const lastGoodCopy = database.records.get("current");
  database.failNextCommit();
  el("letter").value = "An edit whose storage commit fails";
  await el("letter").dispatch("input");
  await eventually(() => /Simulated storage failure/.test(el("recovery-status").textContent),
    "a failed transaction must stop recovery and report failure");
  assert.equal(database.records.get("current"), lastGoodCopy);
  assert.equal(el("enable-recovery").disabled, false);
});
