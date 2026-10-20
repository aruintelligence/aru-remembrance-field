// Portable, local-only gift format. Nothing in this module calls a network API.
export const LEGACY_CAPSULE_FORMAT = "aru-remembrance-capsule/1";
export const LEGACY_ENVELOPE_FORMAT = "aru-remembrance-capsule-sealed/1";
export const LEGACY_DRAFT_FORMAT = "aru-remembrance-capsule-draft/1";
export const LEGACY_DRAFT_ENVELOPE_FORMAT = "aru-remembrance-capsule-draft-sealed/1";
export const VOICE_CAPSULE_FORMAT = "aru-remembrance-capsule/2";
export const VOICE_ENVELOPE_FORMAT = "aru-remembrance-capsule-sealed/2";
export const VOICE_DRAFT_FORMAT = "aru-remembrance-capsule-draft/2";
export const VOICE_DRAFT_ENVELOPE_FORMAT = "aru-remembrance-capsule-draft-sealed/2";
export const CAPSULE_FORMAT = "aru-remembrance-capsule/3";
export const ENVELOPE_FORMAT = "aru-remembrance-capsule-sealed/3";
export const DRAFT_FORMAT = "aru-remembrance-capsule-draft/3";
export const DRAFT_ENVELOPE_FORMAT = "aru-remembrance-capsule-draft-sealed/3";
export const MAX_MEMORIES = 8;
export const MAX_PHOTO_BYTES = 600_000;
export const MAX_AUDIO_BYTES = 1_000_000;
export const MAX_PLAINTEXT_BYTES = 20_000_000;
export const MAX_FILE_BYTES = 27_000_000;
const ITERATIONS = 310_000;
const STOP = new Set("a an and are as at be by can did do does for from has have had how i in is it me my of on or our she he the their them they this to was were what when where who why with you your tell show about remember memory memories happen happened happening".split(" "));

function assertText(value, label, maximum, required = true) {
  if (typeof value !== "string" || value.length > maximum ||
      (required && !value.trim())) throw new Error(`Invalid ${label}`);
  return value.trim();
}

function draftText(value, label, maximum) {
  if (typeof value !== "string" || value.length > maximum) throw new Error(`Invalid ${label}`);
  return value;
}

function bytesFromBase64(value, maximum) {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid encoded bytes");
  }
  const raw = atob(value);
  if (raw.length > maximum) throw new Error("Encoded bytes exceed limit");
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

function base64FromBytes(bytes) {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(raw);
}

function validImage(bytes, type) {
  if (type === "image/png") return bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
  if (type === "image/jpeg") return bytes.length >= 4 && bytes[0] === 255 &&
    bytes[1] === 216 && bytes[2] === 255;
  if (type === "image/webp") return bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
  return false;
}

export function photoFromBytes(input, type) {
  const bytes = new Uint8Array(input);
  if (bytes.length > MAX_PHOTO_BYTES || !validImage(bytes, type)) {
    throw new Error("Choose a PNG, JPEG, or WebP photo under 600 KB");
  }
  return `data:${type};base64,${base64FromBytes(bytes)}`;
}

function validatePhoto(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 810_000) {
    throw new Error("Invalid photo");
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match || !validImage(bytesFromBase64(match[2], MAX_PHOTO_BYTES), match[1])) {
    throw new Error("Invalid photo");
  }
  return value;
}

function canonicalAudioType(type, name = "") {
  if (typeof type !== "string" || typeof name !== "string") return null;
  const aliases = { "audio/mp4": "audio/mp4", "audio/m4a": "audio/mp4",
    "audio/x-m4a": "audio/mp4", "audio/mpeg": "audio/mpeg",
    "audio/mp3": "audio/mpeg", "audio/wav": "audio/wav",
    "audio/wave": "audio/wav", "audio/x-wav": "audio/wav",
    "audio/webm": "audio/webm" };
  if (type) return aliases[type.split(";")[0].trim().toLowerCase()] ?? null;
  if (/\.m4a$/i.test(name)) return "audio/mp4";
  if (/\.mp3$/i.test(name)) return "audio/mpeg";
  if (/\.wav$/i.test(name)) return "audio/wav";
  if (/\.webm$/i.test(name)) return "audio/webm";
  return null;
}

function marker(bytes, offset, value) {
  return bytes.length >= offset + value.length &&
    [...value].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
}

function validAudio(bytes, type) {
  if (type === "audio/mp4") {
    const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) |
      (bytes[2] << 8) | bytes[3]) >>> 0;
    return bytes.length >= 16 && marker(bytes, 4, "ftyp") &&
      boxSize >= 16 && boxSize <= bytes.length;
  }
  if (type === "audio/mpeg") return (marker(bytes, 0, "ID3") && bytes.length >= 10) ||
    (bytes.length >= 4 && bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0 &&
    (bytes[1] & 0x06) !== 0);
  if (type === "audio/wav") return bytes.length >= 12 &&
    marker(bytes, 0, "RIFF") && marker(bytes, 8, "WAVE");
  if (type === "audio/webm") {
    // EBML header followed by a WebM DocType element; the actual codec still
    // needs the recipient's browser to decode it.
    if (bytes.length < 16 || ![0x1a, 0x45, 0xdf, 0xa3].every((v, i) => bytes[i] === v)) return false;
    for (let i = 4; i < Math.min(bytes.length - 6, 128); i++) {
      if (bytes[i] === 0x42 && bytes[i + 1] === 0x82 && bytes[i + 2] === 0x84 &&
          marker(bytes, i + 3, "webm")) return true;
    }
    return false;
  }
  return false;
}

export function audioFromBytes(input, type, name = "") {
  const bytes = new Uint8Array(input);
  const canonical = canonicalAudioType(type, name);
  if (!canonical || bytes.length > MAX_AUDIO_BYTES || !validAudio(bytes, canonical)) {
    throw new Error("Choose an M4A, MP3, WAV, or WebM recording under 1 MB");
  }
  return `data:${canonical};base64,${base64FromBytes(bytes)}`;
}

function validateAudio(value, allowWebm) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 1_350_000) throw new Error("Invalid audio");
  const match = /^data:(audio\/(?:mp4|mpeg|wav|webm));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match || (!allowWebm && match[1] === "audio/webm") ||
      !validAudio(bytesFromBase64(match[2], MAX_AUDIO_BYTES), match[1])) {
    throw new Error("Invalid audio");
  }
  return value;
}

export function validateCapsule(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![CAPSULE_FORMAT, VOICE_CAPSULE_FORMAT, LEGACY_CAPSULE_FORMAT].includes(value.format) ||
      !Array.isArray(value.memories) ||
      value.memories.length < 1 || value.memories.length > MAX_MEMORIES) {
    throw new Error("Invalid capsule");
  }
  const recipient = assertText(value.recipient, "recipient", 60);
  const from = assertText(value.from, "sender", 60);
  const letter = assertText(value.letter, "letter", 1600);
  assertTimestamp(value.created_at, "creation date");
  const ids = new Set();
  const memories = value.memories.map((item, index) =>
    validateMemory(item, index, ids, value.format !== LEGACY_CAPSULE_FORMAT,
      value.format === CAPSULE_FORMAT));
  const capsule = { format: value.format, created_at: value.created_at,
    recipient, from, letter, memories };
  if (new TextEncoder().encode(JSON.stringify(capsule)).length > MAX_PLAINTEXT_BYTES) {
    throw new Error("Capsule exceeds size limit");
  }
  return capsule;
}

function assertTimestamp(value, label) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      Number.isNaN(Date.parse(value))) throw new Error(`Invalid ${label}`);
}

function validateMemory(item, index, ids, withAudio, allowWebm) {
  if (!item || typeof item !== "object" || Array.isArray(item) ||
      typeof item.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(item.id) ||
      ids.has(item.id)) throw new Error(`Invalid memory ${index + 1}`);
  if (!withAudio && item.audio != null) throw new Error(`Invalid memory ${index + 1}`);
  ids.add(item.id);
  const memory = {
    id: item.id,
    title: assertText(item.title, "memory title", 100),
    when: assertText(item.when, "memory date", 80, false),
    story: assertText(item.story, "memory story", 2400),
    photo: validatePhoto(item.photo ?? null)
  };
  if (withAudio) memory.audio = validateAudio(item.audio ?? null, allowWebm);
  return memory;
}

function currentCapsule(value) {
  const validated = validateCapsule(value);
  if (validated.format === CAPSULE_FORMAT) return validated;
  return validateCapsule({ ...validated, format: CAPSULE_FORMAT,
    memories: validated.memories.map(memory => ({ ...memory, audio: memory.audio ?? null })) });
}

// A checkpoint accepts unfinished writing, including a memory currently being edited.
// It is a separate encrypted format and cannot be mistaken for a finished gift.
export function validateDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![DRAFT_FORMAT, VOICE_DRAFT_FORMAT, LEGACY_DRAFT_FORMAT].includes(value.format) ||
      !Array.isArray(value.memories) ||
      value.memories.length > MAX_MEMORIES || !value.pending ||
      typeof value.pending !== "object" || Array.isArray(value.pending)) {
    throw new Error("Invalid draft");
  }
  assertTimestamp(value.saved_at, "save date");
  const ids = new Set();
  const withAudio = value.format !== LEGACY_DRAFT_FORMAT;
  const memories = value.memories.map((item, index) =>
    validateMemory(item, index, ids, withAudio, value.format === DRAFT_FORMAT));
  if (!withAudio && value.pending.audio != null) throw new Error("Invalid pending audio");
  const editingIndex = value.editing_index;
  if (editingIndex !== null && (!Number.isInteger(editingIndex) ||
      editingIndex < 0 || editingIndex >= memories.length)) throw new Error("Invalid edit position");
  const draft = {
    format: value.format, saved_at: value.saved_at,
    recipient: draftText(value.recipient, "recipient", 60),
    from: draftText(value.from, "sender", 60),
    letter: draftText(value.letter, "letter", 1600), memories,
    editing_index: editingIndex,
    pending: {
      title: draftText(value.pending.title, "pending title", 100),
      when: draftText(value.pending.when, "pending date", 80),
      story: draftText(value.pending.story, "pending story", 2400),
      photo: validatePhoto(value.pending.photo ?? null)
    }
  };
  if (withAudio) draft.pending.audio = validateAudio(value.pending.audio ?? null,
    value.format === DRAFT_FORMAT);
  if (new TextEncoder().encode(JSON.stringify(draft)).length > MAX_PLAINTEXT_BYTES) {
    throw new Error("Draft exceeds size limit");
  }
  return draft;
}

function currentDraft(value) {
  const validated = validateDraft(value);
  if (validated.format === DRAFT_FORMAT) return validated;
  return validateDraft({ ...validated, format: DRAFT_FORMAT,
    memories: validated.memories.map(memory => ({ ...memory, audio: memory.audio ?? null })),
    pending: { ...validated.pending, audio: validated.pending.audio ?? null } });
}

function passphraseIsValid(passphrase) {
  return typeof passphrase === "string" && passphrase.length >= 12 &&
    passphrase.length <= 256;
}

async function importPassphrase(passphrase) {
  if (!passphraseIsValid(passphrase)) throw new Error("Use a passphrase of 12–256 characters");
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error("A secure browser context is required to seal a capsule");
  }
  return crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase),
    "PBKDF2", false, ["deriveKey"]);
}

async function deriveFromMaterial(material, salt, usage) {
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITERATIONS,
    hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, [usage]);
}

async function deriveKey(passphrase, salt, usage) {
  return deriveFromMaterial(await importPassphrase(passphrase), salt, usage);
}

async function sealWithMaterial(value, material, format) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveFromMaterial(material, salt, "encrypt");
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
    additionalData: new TextEncoder().encode(format) }, key, plaintext);
  return { format, kdf: "PBKDF2-SHA256", iterations: ITERATIONS,
    cipher: "AES-256-GCM", salt: base64FromBytes(salt), iv: base64FromBytes(iv),
    ciphertext: base64FromBytes(new Uint8Array(ciphertext)) };
}

async function sealValue(value, passphrase, format) {
  return sealWithMaterial(value, await importPassphrase(passphrase), format);
}

export async function sealCapsule(value, passphrase) {
  return sealValue(currentCapsule(value), passphrase, ENVELOPE_FORMAT);
}

export async function sealDraft(value, passphrase) {
  return sealValue(currentDraft(value), passphrase, DRAFT_ENVELOPE_FORMAT);
}

// The key stays nonextractable in this page session. Each recovery snapshot
// derives a new AES key with a new salt and uses a fresh IV.
export async function createDraftRecoverySealer(passphrase) {
  const material = await importPassphrase(passphrase);
  return value => sealWithMaterial(currentDraft(value), material, DRAFT_ENVELOPE_FORMAT);
}

async function openValue(input, passphrase, acceptedFormats, validate) {
  if (!globalThis.crypto?.subtle || !passphraseIsValid(passphrase)) {
    throw new Error("A secure browser and a passphrase are required");
  }
  let envelope;
  try {
    if (typeof input === "string" && input.length > MAX_FILE_BYTES) throw Error();
    envelope = typeof input === "string" ? JSON.parse(input) : input;
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
        Object.keys(envelope).sort().join("|") !==
          "cipher|ciphertext|format|iterations|iv|kdf|salt" ||
        !Object.hasOwn(acceptedFormats, envelope.format) ||
        envelope.kdf !== "PBKDF2-SHA256" ||
        envelope.iterations !== ITERATIONS || envelope.cipher !== "AES-256-GCM") throw Error();
    const salt = bytesFromBase64(envelope.salt, 16);
    const iv = bytesFromBase64(envelope.iv, 12);
    const ciphertext = bytesFromBase64(envelope.ciphertext, MAX_PLAINTEXT_BYTES + 16);
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 17) throw Error();
    const key = await deriveKey(passphrase, salt, "decrypt");
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv,
      additionalData: new TextEncoder().encode(envelope.format) }, key, ciphertext);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (value?.format !== acceptedFormats[envelope.format]) throw Error();
    return validate(value);
  } catch {
    throw new Error("Unable to open this file. Check the passphrase or file type.");
  }
}

export async function openCapsule(input, passphrase) {
  return openValue(input, passphrase, {
    [LEGACY_ENVELOPE_FORMAT]: LEGACY_CAPSULE_FORMAT,
    [VOICE_ENVELOPE_FORMAT]: VOICE_CAPSULE_FORMAT,
    [ENVELOPE_FORMAT]: CAPSULE_FORMAT
  }, validateCapsule);
}

export async function openDraft(input, passphrase) {
  return openValue(input, passphrase, {
    [LEGACY_DRAFT_ENVELOPE_FORMAT]: LEGACY_DRAFT_FORMAT,
    [VOICE_DRAFT_ENVELOPE_FORMAT]: VOICE_DRAFT_FORMAT,
    [DRAFT_ENVELOPE_FORMAT]: DRAFT_FORMAT
  }, validateDraft);
}

function terms(value) {
  return [...new Set(value.normalize("NFKC").toLocaleLowerCase("en")
    .match(/[\p{L}\p{N}]+/gu)?.filter(term => term.length >= 3 && !STOP.has(term)) ?? [])];
}

export function recallMemories(value, question) {
  const capsule = validateCapsule(value);
  const query = assertText(question, "question", 240);
  const wanted = terms(query);
  if (!wanted.length) return { kind: "insufficient_question", matches: [] };
  const matches = capsule.memories.map((memory, index) => {
    const title = new Set(terms(memory.title));
    const when = new Set(terms(memory.when));
    const story = new Set(terms(memory.story));
    const matchedTerms = wanted.filter(word => title.has(word) || when.has(word) || story.has(word));
    const unmatchedTerms = wanted.filter(word => !matchedTerms.includes(word));
    // Prefer a memory covering more distinct details in the question, then
    // distinguish title/date mentions from story mentions. Never infer an answer.
    const score = matchedTerms.length * 4 + matchedTerms.reduce((sum, word) => sum +
      (title.has(word) ? 3 : 0) + (when.has(word) ? 1 : 0) +
      (story.has(word) ? 1 : 0), 0);
    return { index: index + 1, id: memory.id, title: memory.title,
      story: memory.story, when: memory.when, score, matchedTerms, unmatchedTerms };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3);
  return { kind: matches.length ? "matched" : "no_match", matches };
}

// Offer a few entry points into the actual written gift. Each suggestion is
// checked against the same retrieval path the question box uses.
export function suggestMemoryQuestions(value) {
  const capsule = validateCapsule(value);
  const count = capsule.memories.length;
  const positions = [...new Set([0, Math.floor((count - 1) / 2), count - 1])];
  return positions.flatMap(index => {
    const memory = capsule.memories[index];
    const candidates = [memory.title, ...terms(memory.story).slice(0, 12)];
    for (const detail of candidates) {
      const question = `What do you remember about ${detail}?`;
      if (recallMemories(capsule, question).matches.some(match => match.id === memory.id)) {
        return [{ id: memory.id, question }];
      }
    }
    return [];
  });
}

export const FICTIONAL_SAMPLE = Object.freeze({ format: CAPSULE_FORMAT,
  created_at: "2026-10-19T00:00:00.000Z", recipient: "Alex", from: "Taylor",
  letter: "For every ordinary day that became extraordinary because we were together. These are a few moments I never want us to lose.",
  memories: [
    { id: "sample-1", title: "The blue umbrella", when: "One rainy Saturday",
      story: "We walked home under a blue umbrella that was too small for both of us. You laughed when the rain won anyway, and we stopped for hot chocolate.", photo: null, audio: null },
    { id: "sample-2", title: "Our first garden", when: "Early spring",
      story: "We planted mint in a little clay pot by the kitchen window. You insisted it needed a name, so we called it Captain Mint.", photo: null, audio: null },
    { id: "sample-3", title: "A note in the suitcase", when: "Before the long trip",
      story: "I tucked a note into your suitcase that said you were brave. You found it after arriving and sent me a picture of the sunset.", photo: null, audio: null }
  ]
});
