import test from "node:test";
import assert from "node:assert/strict";
import { FICTIONAL_SAMPLE, openCapsule } from "../capsule/core.mjs";

let userActivation = false;

class Node {
  constructor() {
    this.value = "";
    this.files = [];
    this.hidden = false;
    this.disabled = false;
    this.style = {};
    this.listeners = new Map();
    const classes = new Set();
    this.classList = { toggle(name) { classes.has(name) ? classes.delete(name) : classes.add(name); },
      add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name) };
  }
  addEventListener(event, callback) { this.listeners.set(event, callback); }
  click() {
    userActivation = true;
    try { return this.listeners.get("click")?.(); }
    finally { userActivation = false; }
  }
  dispatch(event) { return this.listeners.get(event)?.(); }
  append(...children) { this.children = [...(this.children ?? []), ...children]; }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  removeAttribute() {}
  scrollIntoView() {}
  focus() {}
  load() {}
  remove() {}
}

test("a sealed share contains only ciphertext and rejects changes before or after sealing", async () => {
  const nodes = new Map();
  globalThis.document = {
    addEventListener() {},
    getElementById: id => {
      if (!nodes.has(id)) nodes.set(id, new Node());
      return nodes.get(id);
    },
    createElement: () => new Node(),
    body: new Node()
  };
  const windowListeners = new Map();
  let printCount = 0;
  globalThis.window = { addEventListener: (type, callback) => windowListeners.set(type, callback),
    print: () => {
      assert.equal(document.body.classList.contains("capsule-print"), true);
      printCount++;
    } };
  globalThis.matchMedia = () => ({ matches: true });
  const shares = [];
  let supported = true;
  Object.defineProperty(globalThis, "navigator", { configurable: true,
    value: { canShare: data => supported && data.files[0] instanceof File,
      share: data => {
        assert.equal(userActivation, true, "share must start within the user's tap");
        shares.push(data);
        return Promise.resolve();
      } } });
  await import("../capsule/app.mjs");
  const el = id => document.getElementById(id);
  el("print-keepsake").click();
  assert.equal(printCount, 0, "there is no printable gift before opening");
  el("hero-sample").click();
  el("print-keepsake").click();
  assert.equal(printCount, 1);
  windowListeners.get("afterprint")();
  assert.equal(document.body.classList.contains("capsule-print"), false);
  const [,, sequence, cards] = el("gift-view").children;
  const [toggle, controls, stage] = sequence.children;
  const [previous, progress, next] = controls.children;
  toggle.click();
  assert.equal(cards.hidden, true);
  assert.equal(progress.textContent, "1 of 3 · The blue umbrella");
  assert.equal(previous.disabled, true);
  next.click();
  assert.equal(progress.textContent, "2 of 3 · Our first garden");
  next.click();
  assert.equal(progress.textContent, "3 of 3 · A note in the suitcase");
  assert.equal(next.disabled, true);
  toggle.click();
  assert.equal(stage.hidden, true);
  assert.equal(cards.hidden, false);
  el("edit-opened").click();
  const passphrase = "a separate gift sharing phrase 2026";
  const setPassphrase = () => {
    el("passphrase").value = passphrase;
    el("confirm-passphrase").value = passphrase;
  };

  setPassphrase();
  const sealing = el("prepare-share").click();
  el("recipient").value = "Changed during sealing";
  el("recipient").dispatch("input");
  await sealing;
  assert.equal(el("share-ready").hidden, true);
  assert.match(el("create-status").textContent, /changed while sealing/);

  el("recipient").value = FICTIONAL_SAMPLE.recipient;
  setPassphrase();
  await el("prepare-share").click();
  assert.equal(el("share-ready").hidden, false);
  assert.equal(el("share-file").hidden, false);
  assert.equal(el("passphrase").value, "");
  await el("prepare-share").click();
  assert.equal(el("share-ready").hidden, false);
  el("share-file").click();
  assert.equal(shares.length, 1);
  assert.deepEqual(Object.keys(shares[0]), ["files"]);
  const file = shares[0].files[0];
  assert.ok(file instanceof File);
  assert.match(file.name, /^remembrance-capsule-\d{4}-\d{2}-\d{2}\.json$/);
  const contents = await file.text();
  assert.equal(contents.includes(passphrase), false);
  assert.equal(contents.includes("blue umbrella"), false);
  const opened = await openCapsule(contents, passphrase);
  assert.deepEqual(opened.memories, FICTIONAL_SAMPLE.memories);

  const secondRow = el("memory-list").children[1];
  secondRow.children[1].children[0].click(); // Move the garden before the umbrella.
  assert.equal(el("share-ready").hidden, true);
  setPassphrase();
  await el("prepare-share").click();
  el("share-file").click();
  assert.equal(shares.length, 2);
  const reordered = await openCapsule(await shares[1].files[0].text(), passphrase);
  assert.deepEqual(reordered.memories.map(memory => memory.title),
    ["Our first garden", "The blue umbrella", "A note in the suitcase"]);

  el("letter").value = "A different letter";
  el("letter").dispatch("input");
  assert.equal(el("share-ready").hidden, true);
  el("share-file").click();
  assert.equal(shares.length, 2);

  supported = false;
  setPassphrase();
  await el("prepare-share").click();
  assert.equal(el("share-file").hidden, true);
  assert.equal(el("share-fallback").hidden, false);
  assert.equal(el("download-prepared").hidden, false);
});
