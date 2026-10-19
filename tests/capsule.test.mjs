import test from "node:test";
import assert from "node:assert/strict";
import { CAPSULE_FORMAT, FICTIONAL_SAMPLE, MAX_MEMORIES, openCapsule,
  photoFromBytes, recallMemories, sealCapsule, validateCapsule } from
  "../capsule/core.mjs";

const sample = () => structuredClone(FICTIONAL_SAMPLE);

test("a sealed gift opens with its passphrase and never exposes plaintext in its file", async () => {
  const capsule = sample();
  const passphrase = "a separate memorable phrase 2026";
  const first = await sealCapsule(capsule, passphrase);
  const second = await sealCapsule(capsule, passphrase);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.iv, second.iv);
  assert.equal(JSON.stringify(first).includes("blue umbrella"), false);
  assert.deepEqual(await openCapsule(JSON.stringify(first), passphrase), capsule);
});

test("wrong passphrase, changed ciphertext, unsupported parameters, and plaintext fail", async () => {
  const passphrase = "a separate memorable phrase 2026";
  const sealed = await sealCapsule(sample(), passphrase);
  await assert.rejects(openCapsule(sealed, "another long passphrase"), /Unable to open/);
  const changed = { ...sealed, ciphertext: `${sealed.ciphertext[0] === "A" ? "B" : "A"}${sealed.ciphertext.slice(1)}` };
  await assert.rejects(openCapsule(changed, passphrase), /Unable to open/);
  await assert.rejects(openCapsule({ ...sealed, iterations: 1 }, passphrase), /Unable to open/);
  await assert.rejects(openCapsule(JSON.stringify(sample()), passphrase), /Unable to open/);
  await assert.rejects(sealCapsule(sample(), "short"), /12–256/);
});

test("the capsule format bounds content, IDs, count, and image type", () => {
  const invalid = sample();
  invalid.memories[1].id = invalid.memories[0].id;
  assert.throws(() => validateCapsule(invalid), /Invalid memory/);
  const oversized = sample();
  oversized.memories[0].story = "x".repeat(2401);
  assert.throws(() => validateCapsule(oversized), /Invalid memory story/);
  const crowded = sample();
  crowded.memories = Array.from({ length: MAX_MEMORIES + 1 }, (_, index) =>
    ({ id: `m${index}`, title: "Title", when: "", story: "Story", photo: null }));
  assert.throws(() => validateCapsule(crowded), /Invalid capsule/);
  assert.throws(() => photoFromBytes(new TextEncoder().encode("<svg onload=alert(1) />"),
    "image/svg+xml"), /Choose a PNG/);
  const spoofed = sample();
  spoofed.memories[0].photo = "data:image/png;base64,PHN2Zy8+";
  assert.throws(() => validateCapsule(spoofed), /Invalid photo/);
});

test("a small PNG remains inside the sealed gift and opens as the same bytes", async () => {
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII="),
    char => char.charCodeAt(0));
  const gift = sample();
  gift.memories[0].photo = photoFromBytes(png, "image/png");
  const sealed = await sealCapsule(gift, "a separate memorable phrase 2026");
  assert.equal(JSON.stringify(sealed).includes("data:image"), false);
  const opened = await openCapsule(sealed, "a separate memorable phrase 2026");
  assert.equal(opened.memories[0].photo, gift.memories[0].photo);
});

test("recall cites stored memories and refuses unmatched or vague questions", () => {
  const gift = sample();
  const matched = recallMemories(gift, "What happened with the blue umbrella?");
  assert.equal(matched.kind, "matched");
  assert.deepEqual(matched.matches.map(item => item.id), ["sample-1"]);
  assert.equal(matched.matches[0].story, gift.memories[0].story);
  assert.deepEqual(recallMemories(gift, "What is her favorite ocean?"),
    { kind: "no_match", matches: [] });
  assert.deepEqual(recallMemories(gift, "What about it?"),
    { kind: "insufficient_question", matches: [] });
  assert.equal(gift.format, CAPSULE_FORMAT);
});
