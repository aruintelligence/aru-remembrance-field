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
  globalThis.location = { href: "https://aruintelligence.github.io/aru-remembrance-field/capsule/?preview=1#make" };
  const shares = [];
  const copied = [];
  let supported = true;
  Object.defineProperty(globalThis, "navigator", { configurable: true,
    value: { clipboard: { writeText: text => { copied.push(text); return Promise.resolve(); } },
      canShare: data => supported && data.files[0] instanceof File,
      share: data => {
        assert.equal(userActivation, true, "share must start within the user's tap");
        shares.push(data);
        return Promise.resolve();
      } } });
  await import("../capsule/app.mjs");
  const el = id => document.getElementById(id);
  await el("copy-opening-steps").click();
  assert.equal(copied.length, 0, "instructions require a prepared gift");
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
  await el("copy-opening-steps").click();
  assert.equal(copied.length, 1);
  assert.match(copied[0], /https:\/\/aruintelligence\.github\.io\/aru-remembrance-field\/capsule\//);
  for (const privateText of ["?preview", "#make", passphrase, "blue umbrella", "Taylor", "Alex"]) {
    assert.equal(copied[0].includes(privateText), false);
  }
  assert.match(copied[0], /passphrase I give you separately/);
  const code = el("share-file-code").textContent;
  assert.match(code, /^[A-F0-9]{16}$/);
  assert.match(copied[0], new RegExp(code));
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
  el("capsule-file").files = [file];
  await el("capsule-file").dispatch("change");
  assert.equal(el("selected-file-code").hidden, false);
  assert.equal(el("selected-file-code-value").textContent, code);
  assert.equal(el("open-passphrase").value, "", "file identity is available before the passphrase");
  el("capsule-file").files = [new File([contents + " "], file.name, { type: "application/json" })];
  await el("capsule-file").dispatch("change");
  assert.notEqual(el("selected-file-code-value").textContent, code, "different file bytes get a different code");
  el("capsule-file").files = [file];
  await el("capsule-file").dispatch("change");
  el("open-passphrase").value = passphrase;
  await el("open-capsule").click();
  assert.equal(el("opened-file-code").hidden, false);
  assert.equal(el("opened-file-code-value").textContent, code);
  el("sample").click();
  assert.equal(el("opened-file-code").hidden, true, "sample cannot show a real file code");
  el("memory-question").value = "What about the blue umbrella?";
  el("ask").click();
  assert.equal(el("answer").children[1].children[1].textContent, "Matched words: blue, umbrella");
  el("memory-question").value = "What ocean had the blue umbrella?";
  el("ask").click();
  assert.match(el("answer").children[0].textContent, /Only partial word matches/);
  assert.equal(el("answer").children[1].children[2].textContent,
    "Other question words not found here: ocean");

  const secondRow = el("memory-list").children[1];
  secondRow.children[1].children[0].click(); // Move the garden before the umbrella.
  assert.equal(el("share-ready").hidden, true);
  await el("copy-opening-steps").click();
  assert.equal(copied.length, 1, "a stale gift cannot offer opening steps");
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

  const firstRow = el("memory-list").children[0];
  firstRow.children[1].children[2].click(); // Edit the first memory.
  el("memory-voice-words").value = "The lighthouse was our secret signal.";
  el("memory-voice-words").dispatch("input");
  await el("save-memory").click();
  assert.equal(el("memory-voice-words").value, "");
  await el("preview").click();
  const previewCards = el("gift-view").children[3];
  const written = previewCards.children[0].children.find(node => node.className === "voice-words");
  assert.equal(written.children[1].textContent, "The lighthouse was our secret signal.");
  await previewCards.children[0].children.at(-1).click();
  assert.match(copied.at(-1), /Written words:\nThe lighthouse was our secret signal/);
  el("memory-question").value = "What was the lighthouse signal?";
  el("ask").click();
  const evidence = el("answer").children.find(node => node.className === "voice-words-evidence" ||
    node.children?.some(child => child.className === "voice-words-evidence"));
  assert.ok(evidence, "the written words appear in the search source card");
});
