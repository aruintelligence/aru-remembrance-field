import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { CAPSULE_FORMAT, DRAFT_FORMAT, FICTIONAL_SAMPLE, LEGACY_CAPSULE_FORMAT,
  LEGACY_DRAFT_FORMAT, VOICE_CAPSULE_FORMAT, VOICE_DRAFT_FORMAT,
  MAX_AUDIO_BYTES, MAX_MEMORIES, audioFromBytes,
  openCapsule, openDraft, photoFromBytes, recallMemories, suggestMemoryQuestions, sealCapsule,
  createDraftRecoverySealer,
  sealDraft, validateCapsule, validateDraft } from
  "../capsule/core.mjs";

const sample = () => structuredClone(FICTIONAL_SAMPLE);

test("the public page and app use content-based URLs for their current modules", () => {
  const core = readFileSync(new URL("../capsule/core.mjs", import.meta.url));
  const app = readFileSync(new URL("../capsule/app.mjs", import.meta.url), "utf8");
  const html = readFileSync(new URL("../capsule/index.html", import.meta.url), "utf8");
  const hash = data => createHash("sha256").update(data).digest("hex");
  assert.ok(app.includes(`from "./core.mjs?v=${hash(core)}";`));
  assert.ok(html.includes(`src="./app.mjs?v=${hash(app)}"`));
});
const legacySample = () => {
  const gift = sample();
  gift.format = LEGACY_CAPSULE_FORMAT;
  gift.memories.forEach(memory => { delete memory.audio; });
  return gift;
};

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

test("a gift sealed by the original release still opens after draft support is added", async () => {
  const oldFile = readFileSync(new URL("./fixtures/capsule-v1-sealed.json", import.meta.url), "utf8");
  const oldGift = await openCapsule(oldFile, "previous public gift phrase 2026");
  assert.deepEqual(oldGift, legacySample());
  const resealed = await sealCapsule(oldGift, "a new versioned passphrase 2026");
  const reopened = await openCapsule(resealed, "a new versioned passphrase 2026");
  assert.deepEqual(reopened, sample());
});

test("a version 2 voice gift and private draft remain readable and upgrade without losing audio", async () => {
  const oldGiftFile = readFileSync(new URL("./fixtures/capsule-v2-sealed.json", import.meta.url), "utf8");
  const oldGift = await openCapsule(oldGiftFile, "previous voice gift phrase 2026");
  assert.equal(oldGift.format, VOICE_CAPSULE_FORMAT);
  assert.ok(oldGift.memories[0].audio.startsWith("data:audio/mp4;base64,"));
  const newGift = await openCapsule(await sealCapsule(oldGift, "updated voice gift phrase 2026"),
    "updated voice gift phrase 2026");
  assert.equal(newGift.format, CAPSULE_FORMAT);
  assert.equal(newGift.memories[0].audio, oldGift.memories[0].audio);

  const oldDraftFile = readFileSync(new URL("./fixtures/capsule-draft-v2-sealed.json", import.meta.url), "utf8");
  const oldDraft = await openDraft(oldDraftFile, "previous voice draft phrase 2026");
  assert.equal(oldDraft.format, VOICE_DRAFT_FORMAT);
  const newDraft = await openDraft(await sealDraft(oldDraft, "updated voice draft phrase 2026"),
    "updated voice draft phrase 2026");
  assert.equal(newDraft.format, DRAFT_FORMAT);
  assert.equal(newDraft.pending.audio, oldDraft.pending.audio);
});

test("wrong passphrase, changed ciphertext, unsupported parameters, and plaintext fail", async () => {
  const passphrase = "a separate memorable phrase 2026";
  const sealed = await sealCapsule(sample(), passphrase);
  await assert.rejects(openCapsule(sealed, "another long passphrase"), /Unable to open/);
  const changed = { ...sealed, ciphertext: `${sealed.ciphertext[0] === "A" ? "B" : "A"}${sealed.ciphertext.slice(1)}` };
  await assert.rejects(openCapsule(changed, passphrase), /Unable to open/);
  await assert.rejects(openCapsule({ ...sealed, iterations: 1 }, passphrase), /Unable to open/);
  await assert.rejects(openCapsule({ ...sealed, format: "aru-remembrance-capsule-sealed/1" },
    passphrase), /Unable to open/);
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

test("suggested questions lead to authored source memories, including generic titles", () => {
  const gift = sample();
  const suggestions = suggestMemoryQuestions(gift);
  assert.equal(suggestions.length, 3);
  for (const { id, question } of suggestions) {
    assert.ok(gift.memories.some(memory => memory.id === id));
    assert.ok(recallMemories(gift, question).matches.some(memory => memory.id === id));
  }
  const generic = sample();
  generic.memories[0].title = "Our memory";
  const [first] = suggestMemoryQuestions(generic);
  assert.equal(first.id, "sample-1");
  assert.ok(first.question.includes("walked") || first.question.includes("home") ||
    first.question.includes("under") || first.question.includes("blue"));
  assert.throws(() => suggestMemoryQuestions({ ...generic, memories: [] }), /Invalid capsule/);
});

function unfinishedDraft() {
  return { format: DRAFT_FORMAT, saved_at: "2026-10-19T20:00:00.000Z",
    recipient: "Alex", from: "", letter: "I was thinking about the time",
    memories: [], editing_index: null,
    pending: { title: "On the beach", when: "", story: "We found",
      photo: null, audio: null } };
}

test("a private draft from the previous release opens and upgrades on the next save", async () => {
  const oldFile = readFileSync(new URL("./fixtures/capsule-draft-v1-sealed.json", import.meta.url), "utf8");
  const oldDraft = await openDraft(oldFile, "previous private draft phrase 2026");
  assert.equal(oldDraft.format, LEGACY_DRAFT_FORMAT);
  assert.equal(oldDraft.pending.story, "Still writing");
  assert.equal(oldDraft.pending.audio, undefined);
  const newFile = await sealDraft(oldDraft, "a new draft passphrase 2026");
  const restored = await openDraft(newFile, "a new draft passphrase 2026");
  assert.equal(restored.format, DRAFT_FORMAT);
  assert.equal(restored.pending.audio, null);
  assert.equal(restored.pending.story, "Still writing");
});

test("real M4A, MP3, WAV, and WebM samples survive gift and private draft", async () => {
  const formats = [
    ["m4a", "", "audio/mp4"], ["mp3", "audio/mpeg", "audio/mpeg"],
    ["wav", "audio/wav", "audio/wav"],
    ["webm", "audio/webm;codecs=opus", "audio/webm"]
  ];
  for (const [extension, type, canonical] of formats) {
    const bytes = readFileSync(new URL(`./fixtures/voice-sample.${extension}`, import.meta.url));
    const audio = audioFromBytes(bytes, type, `voice-sample.${extension}`);
    assert.ok(audio.startsWith(`data:${canonical};base64,`));
    const gift = sample();
    gift.memories[0].audio = audio;
    const passphrase = "a separate voice phrase 2026";
    const sealed = await sealCapsule(gift, passphrase);
    assert.equal(JSON.stringify(sealed).includes("data:audio"), false);
    const opened = await openCapsule(sealed, passphrase);
    assert.equal(opened.memories[0].audio, audio);
    const draft = unfinishedDraft();
    draft.pending.audio = audio;
    const checkpoint = await sealDraft(draft, passphrase);
    assert.equal((await openDraft(checkpoint, passphrase)).pending.audio, audio);
  }
});

test("voice data rejects spoofed types, malformed headers, and files beyond the limit", () => {
  const mp3 = readFileSync(new URL("./fixtures/voice-sample.mp3", import.meta.url));
  assert.throws(() => audioFromBytes(mp3, "text/html", "voice.mp3"), /Choose an M4A/);
  assert.throws(() => audioFromBytes(mp3, "audio/mp4", "voice.m4a"), /Choose an M4A/);
  assert.throws(() => audioFromBytes(new Uint8Array(MAX_AUDIO_BYTES + 1),
    "audio/mpeg", "voice.mp3"), /Choose an M4A/);
  const spoofed = sample();
  spoofed.memories[0].audio = "data:audio/mp4;base64,PHN2Zy8+";
  assert.throws(() => validateCapsule(spoofed), /Invalid audio/);
  const legacy = legacySample();
  legacy.memories[0].audio = audioFromBytes(mp3, "audio/mpeg", "voice.mp3");
  assert.throws(() => validateCapsule(legacy), /Invalid memory/);
  const webm = readFileSync(new URL("./fixtures/voice-sample.webm", import.meta.url));
  const webmAudio = audioFromBytes(webm, "", "voice.webm");
  const oldGift = sample();
  oldGift.format = VOICE_CAPSULE_FORMAT;
  oldGift.memories[0].audio = webmAudio;
  assert.throws(() => validateCapsule(oldGift), /Invalid audio/);
  const oldDraft = unfinishedDraft();
  oldDraft.format = VOICE_DRAFT_FORMAT;
  oldDraft.pending.audio = webmAudio;
  assert.throws(() => validateDraft(oldDraft), /Invalid audio/);
  assert.throws(() => audioFromBytes(mp3, "audio/webm", "fake.webm"), /Choose an M4A/);
  assert.throws(() => audioFromBytes(new TextEncoder().encode("\x1aE\xdf\xa3 <script>webm"),
    "audio/webm", "fake.webm"), /Choose an M4A/);
});

test("an unfinished letter and unsaved memory survive an encrypted private checkpoint", async () => {
  const draft = unfinishedDraft();
  draft.letter = "  I was thinking about the time\n";
  draft.pending.story = "We found\n";
  const passphrase = "a different, private draft phrase";
  const first = await sealDraft(draft, passphrase);
  const second = await sealDraft(draft, passphrase);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.iv, second.iv);
  assert.equal(JSON.stringify(first).includes("On the beach"), false);
  assert.deepEqual(await openDraft(JSON.stringify(first), passphrase), draft);
  await assert.rejects(openCapsule(first, passphrase), /Unable to open/);
  const gift = await sealCapsule(sample(), passphrase);
  await assert.rejects(openDraft(gift, passphrase), /Unable to open/);
});

test("session recovery creates independently salted, compatible encrypted drafts", async () => {
  const draft = unfinishedDraft();
  const phrase = "private recovery phrase 2026";
  const sealRecovery = await createDraftRecoverySealer(phrase);
  const first = await sealRecovery(draft);
  draft.pending.story = "The beach, and then the stars";
  const second = await sealRecovery(draft);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.iv, second.iv);
  assert.equal(JSON.stringify(second).includes(phrase), false);
  assert.equal(JSON.stringify(second).includes("the stars"), false);
  assert.equal((await openDraft(first, phrase)).pending.story, "We found");
  assert.deepEqual(await openDraft(second, phrase), draft);
  await assert.rejects(createDraftRecoverySealer("short"), /12–256/);
});

test("an in-progress edit and its selected photo survive a checkpoint", async () => {
  const draft = unfinishedDraft();
  draft.memories = sample().memories.slice(0, 1);
  draft.editing_index = 0;
  draft.pending.title = "The rainy beach";
  draft.pending.photo = photoFromBytes(Uint8Array.from(atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII="),
    char => char.charCodeAt(0)), "image/png");
  const opened = await openDraft(await sealDraft(draft, "private draft passphrase 2026"),
    "private draft passphrase 2026");
  assert.deepEqual(opened, draft);
  assert.equal(opened.pending.photo, draft.pending.photo);
});

test("wrong keys, changes, and malformed or oversized checkpoints are rejected", async () => {
  const passphrase = "private draft passphrase 2026";
  const envelope = await sealDraft(unfinishedDraft(), passphrase);
  await assert.rejects(openDraft(envelope, "incorrect passphrase 2026"), /Unable to open/);
  await assert.rejects(openDraft({ ...envelope, ciphertext: envelope.ciphertext.slice(0, -4) + "AAAA" },
    passphrase), /Unable to open/);
  await assert.rejects(openDraft({ ...envelope, format: "aru-remembrance-capsule-sealed/1" },
    passphrase), /Unable to open/);
  await assert.rejects(openDraft("x".repeat(27_000_001), passphrase), /Unable to open/);
  const bad = unfinishedDraft();
  bad.editing_index = 0;
  assert.throws(() => validateDraft(bad), /Invalid edit position/);
  bad.editing_index = null;
  bad.pending.photo = "data:image/svg+xml;base64,PHN2Zy8+";
  assert.throws(() => validateDraft(bad), /Invalid photo/);
});
