// Portable, local-only gift format. Nothing in this module calls a network API.
export const CAPSULE_FORMAT = "aru-remembrance-capsule/1";
export const ENVELOPE_FORMAT = "aru-remembrance-capsule-sealed/1";
export const DRAFT_FORMAT = "aru-remembrance-capsule-draft/1";
export const DRAFT_ENVELOPE_FORMAT = "aru-remembrance-capsule-draft-sealed/1";
export const MAX_MEMORIES = 8;
export const MAX_PHOTO_BYTES = 600_000;
export const MAX_PLAINTEXT_BYTES = 7_000_000;
export const MAX_FILE_BYTES = 10_000_000;
const ITERATIONS = 310_000;
const STOP = new Set("a an and are as at be by can did do does for from how i in is it me my of on or our she he the their them they this to was were what when where who why with you your tell show about remember memory memories".split(" "));

function assertText(value, label, maximum, required = true) {
  if (typeof value !== "string" || value.length > maximum ||
      (required && !value.trim())) throw new Error(`Invalid ${label}`);
  return value.trim();
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

export function validateCapsule(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.format !== CAPSULE_FORMAT || !Array.isArray(value.memories) ||
      value.memories.length < 1 || value.memories.length > MAX_MEMORIES) {
    throw new Error("Invalid capsule");
  }
  const recipient = assertText(value.recipient, "recipient", 60);
  const from = assertText(value.from, "sender", 60);
  const letter = assertText(value.letter, "letter", 1600);
  assertTimestamp(value.created_at, "creation date");
  const ids = new Set();
  const memories = value.memories.map((item, index) => validateMemory(item, index, ids));
  const capsule = { format: CAPSULE_FORMAT, created_at: value.created_at,
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

function validateMemory(item, index, ids) {
  if (!item || typeof item !== "object" || Array.isArray(item) ||
      typeof item.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(item.id) ||
      ids.has(item.id)) throw new Error(`Invalid memory ${index + 1}`);
  ids.add(item.id);
  return {
    id: item.id,
    title: assertText(item.title, "memory title", 100),
    when: assertText(item.when, "memory date", 80, false),
    story: assertText(item.story, "memory story", 2400),
    photo: validatePhoto(item.photo ?? null)
  };
}

// A checkpoint accepts unfinished writing, including a memory currently being edited.
// It is a separate encrypted format and cannot be mistaken for a finished gift.
export function validateDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.format !== DRAFT_FORMAT || !Array.isArray(value.memories) ||
      value.memories.length > MAX_MEMORIES || !value.pending ||
      typeof value.pending !== "object" || Array.isArray(value.pending)) {
    throw new Error("Invalid draft");
  }
  assertTimestamp(value.saved_at, "save date");
  const ids = new Set();
  const memories = value.memories.map((item, index) => validateMemory(item, index, ids));
  const editingIndex = value.editing_index;
  if (editingIndex !== null && (!Number.isInteger(editingIndex) ||
      editingIndex < 0 || editingIndex >= memories.length)) throw new Error("Invalid edit position");
  const draft = {
    format: DRAFT_FORMAT, saved_at: value.saved_at,
    recipient: assertText(value.recipient, "recipient", 60, false),
    from: assertText(value.from, "sender", 60, false),
    letter: assertText(value.letter, "letter", 1600, false), memories,
    editing_index: editingIndex,
    pending: {
      title: assertText(value.pending.title, "pending title", 100, false),
      when: assertText(value.pending.when, "pending date", 80, false),
      story: assertText(value.pending.story, "pending story", 2400, false),
      photo: validatePhoto(value.pending.photo ?? null)
    }
  };
  if (new TextEncoder().encode(JSON.stringify(draft)).length > MAX_PLAINTEXT_BYTES) {
    throw new Error("Draft exceeds size limit");
  }
  return draft;
}

function passphraseIsValid(passphrase) {
  return typeof passphrase === "string" && passphrase.length >= 12 &&
    passphrase.length <= 256;
}

async function deriveKey(passphrase, salt, usage) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase),
    "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITERATIONS,
    hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, [usage]);
}

async function sealValue(value, passphrase, format) {
  if (!passphraseIsValid(passphrase)) throw new Error("Use a passphrase of 12–256 characters");
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error("A secure browser context is required to seal a capsule");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, "encrypt");
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
    additionalData: new TextEncoder().encode(format) }, key, plaintext);
  return { format, kdf: "PBKDF2-SHA256", iterations: ITERATIONS,
    cipher: "AES-256-GCM", salt: base64FromBytes(salt), iv: base64FromBytes(iv),
    ciphertext: base64FromBytes(new Uint8Array(ciphertext)) };
}

export async function sealCapsule(value, passphrase) {
  return sealValue(validateCapsule(value), passphrase, ENVELOPE_FORMAT);
}

export async function sealDraft(value, passphrase) {
  return sealValue(validateDraft(value), passphrase, DRAFT_ENVELOPE_FORMAT);
}

async function openValue(input, passphrase, format, validate) {
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
        envelope.format !== format || envelope.kdf !== "PBKDF2-SHA256" ||
        envelope.iterations !== ITERATIONS || envelope.cipher !== "AES-256-GCM") throw Error();
    const salt = bytesFromBase64(envelope.salt, 16);
    const iv = bytesFromBase64(envelope.iv, 12);
    const ciphertext = bytesFromBase64(envelope.ciphertext, MAX_PLAINTEXT_BYTES + 16);
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 17) throw Error();
    const key = await deriveKey(passphrase, salt, "decrypt");
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv,
      additionalData: new TextEncoder().encode(format) }, key, ciphertext);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return validate(value);
  } catch {
    throw new Error("Unable to open this file. Check the passphrase or file type.");
  }
}

export async function openCapsule(input, passphrase) {
  return openValue(input, passphrase, ENVELOPE_FORMAT, validateCapsule);
}

export async function openDraft(input, passphrase) {
  return openValue(input, passphrase, DRAFT_ENVELOPE_FORMAT, validateDraft);
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
    const score = wanted.reduce((sum, word) => sum +
      (title.has(word) ? 3 : 0) + (when.has(word) ? 1 : 0) +
      (story.has(word) ? 1 : 0), 0);
    return { index: index + 1, id: memory.id, title: memory.title,
      story: memory.story, when: memory.when, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3);
  return { kind: matches.length ? "matched" : "no_match", matches };
}

export const FICTIONAL_SAMPLE = Object.freeze({ format: CAPSULE_FORMAT,
  created_at: "2026-10-19T00:00:00.000Z", recipient: "Alex", from: "Taylor",
  letter: "For every ordinary day that became extraordinary because we were together. These are a few moments I never want us to lose.",
  memories: [
    { id: "sample-1", title: "The blue umbrella", when: "One rainy Saturday",
      story: "We walked home under a blue umbrella that was too small for both of us. You laughed when the rain won anyway, and we stopped for hot chocolate.", photo: null },
    { id: "sample-2", title: "Our first garden", when: "Early spring",
      story: "We planted mint in a little clay pot by the kitchen window. You insisted it needed a name, so we called it Captain Mint.", photo: null },
    { id: "sample-3", title: "A note in the suitcase", when: "Before the long trip",
      story: "I tucked a note into your suitcase that said you were brave. You found it after arriving and sent me a picture of the sunset.", photo: null }
  ]
});
