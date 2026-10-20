import { CAPSULE_FORMAT, DRAFT_FORMAT, FICTIONAL_SAMPLE, MAX_AUDIO_BYTES,
  MAX_FILE_BYTES, MAX_MEMORIES, MAX_PHOTO_BYTES, audioFromBytes, openCapsule,
  openDraft, photoFromBytes, recallMemories, suggestMemoryQuestions, sealCapsule, sealDraft,
  createDraftRecoverySealer,
  validateCapsule, validateDraft } from "./core.mjs?v=c4b5f7c607450d1ce71a7e55d1fc98d0756988fe58d124be3124b716187ca622";

const $ = id => document.getElementById(id);
let memories = [];
let editingIndex = null;
let openedCapsule = null;
let pendingPhoto = null;
let pendingAudio = null;
let preparedGift = null;
let recorder = null;
let recordingStream = null;
let recordingTimer = null;
let recordingRequested = false;
let captureAttempt = 0;
const MAX_RECORDING_SECONDS = 30;
const STORY_PROMPTS = [
  "What tiny detail would only the two of you recognize?",
  "What did they say that you still hear in their voice?",
  "Where were you, and what could you see or hear?",
  "What ordinary moment became special later?",
  "What did they teach you without realizing it?",
  "If a photo existed of this moment, what would be just outside its frame?"
];
let storyPromptIndex = 0;
const RECOVERY_DB = "aru-remembrance-capsule-recovery-v1";
const RECOVERY_STORE = "encrypted-drafts";
let recoverySealer = null;
let recoveryOwner = null;
let recoveryRevision = 0;
let recoveryWritten = 0;
let recoverySession = 0;
let recoveryTimer = null;
let recoveryRunning = null;
let recoveryActionBusy = false;

function status(target, message, error = false) {
  const node = $(target);
  node.textContent = message;
  node.classList.toggle("error", error);
}

function switchTab(name) {
  for (const selected of ["create", "open"]) {
    const active = selected === name;
    $(`${selected}-panel`).hidden = !active;
    $(`${selected}-tab`).setAttribute("aria-selected", String(active));
  }
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function hasUnfinishedMemory() {
  return editingIndex !== null || pendingPhoto || pendingAudio ||
    $("memory-photo").files[0] || $("memory-audio").files[0] ||
    ["memory-title", "memory-when", "memory-story"].some(id => $(id).value.trim());
}

function giftSnapshot() {
  return JSON.stringify([$("recipient").value, $("from").value, $("letter").value, memories]);
}

function invalidatePreparedGift() {
  if (!preparedGift) return;
  preparedGift = null;
  $("share-ready").hidden = true;
  status("create-status", "Gift changed. Seal it again before sharing or downloading a new copy.");
}

function draft() {
  if (recordingRequested || recorder) throw Error("Stop the voice recording before previewing or sealing your gift.");
  if (hasUnfinishedMemory()) {
    throw Error("Add or cancel the unfinished memory before previewing or sealing your gift. You can save a private draft at any time.");
  }
  return validateCapsule({ format: CAPSULE_FORMAT,
    created_at: new Date().toISOString(), recipient: $("recipient").value,
    from: $("from").value, letter: $("letter").value, memories });
}

function showAudioPreview(audio) {
  const player = $("audio-preview");
  player.hidden = !audio;
  if (audio) player.src = audio;
  else { player.removeAttribute("src"); player.load(); }
  $("discard-recording").hidden = !pendingAudio;
}

function stopTracks() {
  recordingStream?.getTracks().forEach(track => track.stop());
  recordingStream = null;
}

function recordingControls() {
  $("record-voice").disabled = recordingRequested || !!recorder;
  $("memory-audio").disabled = recordingRequested || !!recorder;
  $("stop-recording").hidden = !recorder || recorder.state !== "recording";
}

function abortRecording() {
  captureAttempt++;
  recordingRequested = false;
  if (recordingTimer) clearInterval(recordingTimer);
  recordingTimer = null;
  if (recorder) {
    recorder.onstop = null;
    recorder.onerror = null;
    recorder.ondataavailable = null;
    if (recorder.state !== "inactive") recorder.stop();
  }
  recorder = null;
  stopTracks();
  recordingControls();
  status("record-status", "");
  $("record-clock").textContent = "";
}

function stopRecording() {
  if (!recorder || recorder.state !== "recording") return;
  recorder.stop();
  recordingControls();
  status("record-status", "Finishing your recording…");
  $("record-clock").textContent = "";
}

async function startRecording() {
  if (recordingRequested || recorder) return;
  invalidatePreparedGift();
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
    status("record-status", "Direct recording is unavailable here. Choose a voice file instead.", true);
    return;
  }
  const mimeType = typeof MediaRecorder.isTypeSupported === "function" ?
    ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"]
      .find(type => MediaRecorder.isTypeSupported(type)) : "audio/mp4";
  if (!mimeType) {
    status("record-status", "This browser has no supported recording format. Choose a voice file instead.", true);
    return;
  }
  const attempt = ++captureAttempt;
  recordingRequested = true;
  recordingControls();
  status("record-status", "Asking for microphone access…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (attempt !== captureAttempt) { stream.getTracks().forEach(track => track.stop()); return; }
    recordingStream = stream;
    const current = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
    recorder = current;
    const chunks = [];
    let bytes = 0;
    let recordingError = "";
    const startedAt = Date.now();
    current.ondataavailable = event => {
      if (!event.data?.size) return;
      chunks.push(event.data);
      bytes += event.data.size;
      if (bytes > MAX_AUDIO_BYTES && current.state === "recording") {
        recordingError = "Recording exceeded 1 MB. Try a shorter note or choose a file.";
        stopRecording();
      }
    };
    current.onerror = () => {
      abortRecording();
      status("record-status", "The recording stopped unexpectedly. Try again or choose a file.", true);
    };
    current.onstop = async () => {
      if (recorder !== current) return;
      if (recordingTimer) clearInterval(recordingTimer);
      recordingTimer = null;
      stopTracks();
      try {
        if (recordingError) throw Error(recordingError);
        const blob = new Blob(chunks, { type: current.mimeType || mimeType });
        if (!blob.size || blob.size > MAX_AUDIO_BYTES) throw Error("Recording is empty or exceeded 1 MB. Try a shorter note.");
        const audio = audioFromBytes(await blob.arrayBuffer(), blob.type);
        if (recorder !== current) return;
        pendingAudio = audio;
        $("memory-audio").value = "";
        showAudioPreview(audio);
        $("pending-audio-hint").textContent = "Recorded voice attached to this memory. Play it back, then add the memory or save a private draft.";
        status("record-status", "Voice note ready to play. Save the memory, then seal a gift or private draft to keep it.");
      } catch (error) {
        status("record-status", error.message, true);
      } finally {
        if (recorder === current) { recorder = null; recordingControls(); }
        scheduleRecovery();
      }
    };
    current.start(1000);
    recordingRequested = false;
    recordingControls();
    status("record-status", "Recording now. Press Stop when you are done.");
    const tick = () => {
      if (recorder !== current || current.state !== "recording") return;
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      if (seconds >= MAX_RECORDING_SECONDS) { stopRecording(); return; }
      $("record-clock").textContent = `${seconds} of ${MAX_RECORDING_SECONDS} seconds`;
    };
    tick();
    recordingTimer = setInterval(tick, 500);
  } catch (error) {
    abortRecording();
    scheduleRecovery();
    status("record-status", error.name === "NotAllowedError" ?
      "Microphone access was declined. You can choose a voice file instead." :
      "Could not start recording. Try again or choose a voice file.", true);
  }
}

function clearMemoryForm() {
  abortRecording();
  for (const id of ["memory-title", "memory-when", "memory-story", "memory-photo", "memory-audio"]) {
    $(id).value = "";
  }
  editingIndex = null;
  pendingPhoto = null;
  pendingAudio = null;
  $("pending-photo-hint").textContent = "";
  $("pending-audio-hint").textContent = "";
  showAudioPreview(null);
  $("save-memory").textContent = "Add memory";
  $("cancel-edit").hidden = true;
}

function renderMemoryList() {
  const list = $("memory-list");
  list.replaceChildren();
  $("memory-counter").textContent = `${memories.length} / ${MAX_MEMORIES} memories`;
  $("save-memory").disabled = memories.length >= MAX_MEMORIES && editingIndex === null;
  if (!memories.length) {
    list.append(element("p", "micro", "Your first moment will appear here."));
    return;
  }
  memories.forEach((memory, index) => {
    const row = element("div", "memory-row");
    const info = element("div");
    info.append(element("strong", "", `${index + 1}. ${memory.title}`),
      element("span", "", [memory.when, memory.photo ? "Photo included" : "",
        memory.audio ? "Voice included" : ""].filter(Boolean).join(" · ") || "Story included"));
    const actions = element("div", "actions");
    for (const [direction, label] of [[-1, "Move up"], [1, "Move down"]]) {
      const move = element("button", "button quiet small", label);
      move.type = "button";
      move.disabled = index + direction < 0 || index + direction >= memories.length;
      move.setAttribute("aria-label", `${label}: ${memory.title}`);
      move.addEventListener("click", () => {
        if (editingIndex !== null || recordingRequested || recorder) {
          status("create-status", "Save or cancel the current edit and stop recording before moving a memory.", true);
          return;
        }
        [memories[index], memories[index + direction]] =
          [memories[index + direction], memories[index]];
        invalidatePreparedGift();
        renderMemoryList();
        status("create-status", `Moved “${memory.title}” to position ${index + direction + 1}. Save a new gift to keep this order.`);
        scheduleRecovery();
      });
      actions.append(move);
    }
    const edit = element("button", "button quiet small", "Edit");
    edit.type = "button";
    edit.setAttribute("aria-label", `Edit ${memory.title}`);
    edit.addEventListener("click", () => {
      invalidatePreparedGift();
      abortRecording();
      editingIndex = index;
      pendingPhoto = null;
      pendingAudio = null;
      $("pending-photo-hint").textContent = "";
      $("pending-audio-hint").textContent = "";
      $("memory-title").value = memory.title;
      $("memory-when").value = memory.when;
      $("memory-story").value = memory.story;
      $("memory-photo").value = "";
      $("memory-audio").value = "";
      showAudioPreview(memory.audio);
      $("save-memory").textContent = "Save changes";
      $("cancel-edit").hidden = false;
      renderMemoryList();
      $("memory-title").focus();
      scheduleRecovery();
    });
    const remove = element("button", "button quiet small", "Remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${memory.title}`);
    remove.addEventListener("click", () => {
      memories.splice(index, 1);
      invalidatePreparedGift();
      clearMemoryForm();
      renderMemoryList();
      status("create-status", "Memory removed from this page session.");
      scheduleRecovery();
    });
    actions.append(edit);
    if (memory.audio) {
      const removeVoice = element("button", "button quiet small", "Remove voice");
      removeVoice.type = "button";
      removeVoice.setAttribute("aria-label", `Remove voice from ${memory.title}`);
      removeVoice.addEventListener("click", () => {
        if (editingIndex === index) {
          status("create-status", "Save or cancel the current edit before removing its voice note.", true);
          return;
        }
        memories[index] = { ...memories[index], audio: null };
        invalidatePreparedGift();
        renderMemoryList();
        status("create-status", "Voice note removed from this page session. Save a new private draft or gift to keep the change.");
        scheduleRecovery();
      });
      actions.append(removeVoice);
    }
    actions.append(remove);
    row.append(info, actions);
    list.append(row);
  });
}

async function saveMemory() {
  const button = $("save-memory");
  button.disabled = true;
  try {
    if (recordingRequested || recorder) throw Error("Stop the voice recording before adding this memory.");
    const photoFile = $("memory-photo").files[0];
    let photo = pendingPhoto || (editingIndex === null ? null : memories[editingIndex].photo);
    if (photoFile) {
      if (photoFile.size > MAX_PHOTO_BYTES) throw Error("Choose a photo under 600 KB.");
      photo = photoFromBytes(await photoFile.arrayBuffer(), photoFile.type);
    }
    const audioFile = $("memory-audio").files[0];
    let audio = pendingAudio || (editingIndex === null ? null : memories[editingIndex].audio);
    if (audioFile) {
      if (audioFile.size > MAX_AUDIO_BYTES) throw Error("Choose a voice recording under 1 MB.");
      audio = audioFromBytes(await audioFile.arrayBuffer(), audioFile.type, audioFile.name);
    }
    const candidate = { id: editingIndex === null ? crypto.randomUUID() : memories[editingIndex].id,
      title: $("memory-title").value, when: $("memory-when").value,
      story: $("memory-story").value, photo, audio };
    const check = validateCapsule({ format: CAPSULE_FORMAT,
      created_at: new Date().toISOString(), recipient: "Recipient", from: "Sender",
      letter: "A letter", memories: [candidate] });
    if (editingIndex === null) {
      if (memories.length >= MAX_MEMORIES) throw Error("The capsule holds eight memories.");
      memories.push(check.memories[0]);
    } else memories[editingIndex] = check.memories[0];
    invalidatePreparedGift();
    clearMemoryForm();
    renderMemoryList();
    status("create-status", recoverySealer ?
      "Memory added. Encrypted recovery will save it shortly; download a private draft for a separate backup." :
      "Memory saved in this page session. Download the capsule to keep it.");
    scheduleRecovery();
  } catch (error) { status("create-status", error.message, true); }
  finally { button.disabled = memories.length >= MAX_MEMORIES && editingIndex === null; }
}

function giftCard(memory, index) {
  const card = element("article", "card");
  if (memory.photo) {
    const photo = element("img");
    photo.src = memory.photo;
    photo.alt = `Photo accompanying ${memory.title}`;
    card.append(photo);
  }
  card.append(element("span", "number", `Memory ${String(index + 1).padStart(2, "0")}`),
    element("h4", "", memory.title));
  if (memory.when) card.append(element("span", "when", memory.when));
  card.append(element("p", "", memory.story));
  if (memory.audio) card.append(voicePlayer(memory));
  const copy = element("button", "button quiet small", "Copy this story");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(`${memory.title}\n${memory.when ? `${memory.when}\n` : ""}${memory.story}`);
      status("open-status", `Copied “${memory.title}”.`);
    } catch { status("open-status", "Copy is unavailable in this browser.", true); }
  });
  card.append(copy);
  return card;
}

function voicePlayer(memory) {
  const player = element("div", "voice-player");
  const label = element("p", "voice-label", "A voice to remember");
  const recording = element("audio");
  recording.controls = true;
  recording.preload = "none";
  recording.src = memory.audio;
  recording.setAttribute("aria-label", `Voice recording for ${memory.title}`);
  player.append(label, recording);
  return player;
}

function pauseAudioWithin(node) {
  for (const audio of node.querySelectorAll?.("audio") ?? []) audio.pause();
}

function showGift(capsule, label) {
  openedCapsule = validateCapsule(capsule);
  $("opened").hidden = false;
  $("answer").replaceChildren();
  $("memory-question").value = "";
  const view = $("gift-view");
  pauseAudioWithin(view);
  view.replaceChildren();
  const letter = element("div", "letter");
  letter.append(element("span", "overline", "A letter, kept for you"),
    element("h3", "", `For ${openedCapsule.recipient}`),
    element("p", "", openedCapsule.letter),
    element("p", "signature", `From ${openedCapsule.from}`));
  const heading = element("h3", "section-title", "The moments inside");
  heading.style.marginTop = "32px";
  const cards = element("div", "cards");
  openedCapsule.memories.forEach((memory, index) => cards.append(giftCard(memory, index)));
  const sequence = element("div", "story-sequence");
  const toggle = element("button", "button secondary small", "Read one at a time");
  toggle.type = "button";
  toggle.setAttribute("aria-pressed", "false");
  const controls = element("div", "story-controls");
  controls.hidden = true;
  const previous = element("button", "button quiet small", "Previous memory");
  const next = element("button", "button quiet small", "Next memory");
  previous.type = next.type = "button";
  const progress = element("span", "micro");
  progress.setAttribute("role", "status");
  progress.setAttribute("aria-live", "polite");
  controls.append(previous, progress, next);
  const stage = element("div", "story-stage");
  stage.hidden = true;
  let storyIndex = 0;
  const displayStory = () => {
    pauseAudioWithin(stage);
    const memory = openedCapsule.memories[storyIndex];
    stage.replaceChildren(giftCard(memory, storyIndex));
    progress.textContent = `${storyIndex + 1} of ${openedCapsule.memories.length} · ${memory.title}`;
    previous.disabled = storyIndex === 0;
    next.disabled = storyIndex === openedCapsule.memories.length - 1;
  };
  toggle.addEventListener("click", () => {
    const reading = cards.hidden === false;
    if (reading) pauseAudioWithin(cards);
    cards.hidden = reading;
    stage.hidden = controls.hidden = !reading;
    toggle.textContent = reading ? "Show all memories" : "Read one at a time";
    toggle.setAttribute("aria-pressed", String(reading));
    if (reading) { storyIndex = 0; displayStory(); }
    else {
      pauseAudioWithin(stage);
      stage.replaceChildren();
    }
  });
  previous.addEventListener("click", () => { if (storyIndex > 0) { storyIndex--; displayStory(); } });
  next.addEventListener("click", () => {
    if (storyIndex < openedCapsule.memories.length - 1) { storyIndex++; displayStory(); }
  });
  sequence.append(toggle, controls, stage);
  view.append(letter, heading, sequence, cards);
  const starters = $("question-starters");
  starters.replaceChildren();
  for (const { question } of suggestMemoryQuestions(openedCapsule)) {
    const button = element("button", "button quiet small", question);
    button.type = "button";
    button.addEventListener("click", () => {
      $("memory-question").value = question;
      ask();
    });
    starters.append(button);
  }
  status("open-status", label);
  $("opened").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ?
    "auto" : "smooth", block: "start" });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = element("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function downloadJson(envelope, filename) {
  downloadBlob(new Blob([JSON.stringify(envelope, null, 2) + "\n"],
    { type: "application/json" }), filename);
}

async function checkpoint() {
  if (recordingRequested || recorder) throw Error("Stop the voice recording before saving a private draft.");
  const selected = $("memory-photo").files[0];
  let photo = pendingPhoto;
  if (selected) {
    if (selected.size > MAX_PHOTO_BYTES) throw Error("Choose a photo under 600 KB.");
    photo = photoFromBytes(await selected.arrayBuffer(), selected.type);
  }
  const selectedAudio = $("memory-audio").files[0];
  let audio = pendingAudio;
  if (selectedAudio) {
    if (selectedAudio.size > MAX_AUDIO_BYTES) throw Error("Choose a voice recording under 1 MB.");
    audio = audioFromBytes(await selectedAudio.arrayBuffer(),
      selectedAudio.type, selectedAudio.name);
  }
  if (selected !== $("memory-photo").files[0] ||
      selectedAudio !== $("memory-audio").files[0]) {
    throw Error("A selected file changed while saving. Try again.");
  }
  const result = validateDraft({ format: DRAFT_FORMAT, saved_at: new Date().toISOString(),
    recipient: $("recipient").value, from: $("from").value, letter: $("letter").value,
    memories, editing_index: editingIndex,
    pending: { title: $("memory-title").value, when: $("memory-when").value,
      story: $("memory-story").value, photo, audio } });
  pendingPhoto = photo;
  pendingAudio = audio;
  return result;
}

function recoveryTransaction(mode, action) {
  if (!globalThis.indexedDB) return Promise.reject(Error("On-device recovery is unavailable in this browser."));
  return new Promise((resolve, reject) => {
    let opening;
    try { opening = indexedDB.open(RECOVERY_DB, 1); }
    catch (error) { reject(error); return; }
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    opening.onupgradeneeded = () => opening.result.createObjectStore(RECOVERY_STORE);
    opening.onerror = () => finish(reject, opening.error || Error("Could not open recovery storage."));
    opening.onblocked = () => finish(reject, Error("Close other capsule tabs and try again."));
    opening.onsuccess = () => {
      const db = opening.result;
      if (settled) { db.close(); return; }
      let transaction;
      try { transaction = db.transaction(RECOVERY_STORE, mode); }
      catch (error) { db.close(); finish(reject, error); return; }
      let result;
      let reason;
      transaction.oncomplete = () => { db.close(); finish(resolve, result); };
      transaction.onabort = () => {
        db.close();
        finish(reject, reason || transaction.error || Error("Recovery storage failed."));
      };
      try {
        action(transaction.objectStore(RECOVERY_STORE), value => { result = value; }, error => {
          reason = error;
          transaction.abort();
        });
      } catch (error) { reason = error; transaction.abort(); }
    };
  });
}

function readRecovery() {
  return recoveryTransaction("readonly", (store, set) => {
    const request = store.get("current");
    request.onsuccess = () => set(request.result ?? null);
  });
}

function writeRecovery(envelope, owner, replace) {
  return recoveryTransaction("readwrite", (store, _, abort) => {
    const request = store.get("current");
    request.onsuccess = () => {
      if (!replace && request.result?.owner !== owner) {
        abort(Error("Another capsule tab changed the recovery copy."));
        return;
      }
      store.put({ owner, envelope }, "current");
    };
  });
}

function recoveryControls() {
  $("enable-recovery").disabled = recoveryActionBusy || !!recoverySealer;
  $("restore-recovery").disabled = recoveryActionBusy;
  $("forget-recovery").disabled = recoveryActionBusy;
}

function pauseRecovery() {
  const running = recoveryRunning;
  recoverySession++;
  recoverySealer = null;
  recoveryOwner = null;
  recoveryRevision = 0;
  recoveryWritten = 0;
  clearTimeout(recoveryTimer);
  recoveryTimer = null;
  recoveryControls();
  return running;
}

function flushRecovery() {
  if (!recoverySealer || recoveryRunning) return recoveryRunning;
  const session = recoverySession;
  let running;
  running = (async () => {
    while (recoverySealer && session === recoverySession && recoveryWritten < recoveryRevision) {
      if (recordingRequested || recorder) {
        status("recovery-status", "Recovery waits until the voice recording has stopped.");
        return;
      }
      const revision = recoveryRevision;
      const owner = recoveryOwner;
      const sealer = recoverySealer;
      status("recovery-status", "Encrypting changes for on-device recovery…");
      let snapshot;
      try { snapshot = await checkpoint(); }
      catch (error) {
        status("recovery-status", `${error.message} Fix this item to resume encrypted recovery. The previous copy is kept.`, true);
        return;
      }
      if (session !== recoverySession || revision !== recoveryRevision) continue;
      const envelope = await sealer(snapshot);
      if (session !== recoverySession || revision !== recoveryRevision) continue;
      await writeRecovery(envelope, owner, recoveryWritten === 0);
      if (session !== recoverySession) return;
      recoveryWritten = revision;
      status("recovery-status", `Encrypted recovery saved on this device at ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
    }
  })().catch(error => {
    if (session !== recoverySession) return;
    pauseRecovery();
    status("recovery-status", `${error.message} Recovery stopped. Save a private draft file and enable it again.`, true);
  }).finally(() => { if (recoveryRunning === running) recoveryRunning = null; });
  recoveryRunning = running;
  return running;
}

function scheduleRecovery() {
  if (!recoverySealer) return;
  recoveryRevision++;
  clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(() => { recoveryTimer = null; flushRecovery(); }, 1200);
}

async function enableRecovery() {
  if (recoveryActionBusy || recoverySealer) return;
  recoveryActionBusy = true;
  recoveryControls();
  try {
    const passphrase = $("recovery-passphrase").value;
    if (passphrase !== $("recovery-confirm").value) throw Error("Recovery passphrases do not match.");
    const sealer = await createDraftRecoverySealer(passphrase);
    const existing = await readRecovery();
    if (existing && !confirm("Replace the encrypted recovery copy already saved in this browser?")) {
      status("recovery-status", "Existing recovery copy kept.");
      return;
    }
    recoverySession++;
    recoverySealer = sealer;
    recoveryOwner = crypto.randomUUID();
    recoveryRevision = 1;
    recoveryWritten = 0;
    $("recovery-passphrase").value = "";
    $("recovery-confirm").value = "";
    await flushRecovery();
  } catch (error) { status("recovery-status", error.message, true); }
  finally { recoveryActionBusy = false; recoveryControls(); }
}

async function restoreRecovery() {
  if (recoveryActionBusy) return;
  recoveryActionBusy = true;
  recoveryControls();
  try {
    const stored = await readRecovery();
    if (!stored) throw Error("No on-device recovery copy was found in this browser.");
    const restored = await openDraft(stored.envelope, $("recovery-unlock").value);
    if (hasUnsavedWork() && !confirm("Replace the unfinished work on this page with the on-device recovery copy?")) {
      status("recovery-status", "Current work kept. Recovery copy was not loaded.");
      return;
    }
    await pauseRecovery();
    applyRestoredDraft(restored);
    status("recovery-status", "Encrypted recovery restored. Automatic saving is paused; enable it again to save new changes.");
    $("recipient").focus();
  } catch (error) { status("recovery-status", error.message, true); }
  finally { recoveryActionBusy = false; recoveryControls(); $("recovery-unlock").value = ""; }
}

async function forgetRecovery() {
  if (recoveryActionBusy) return;
  if (!confirm("Permanently remove the encrypted recovery copy from this browser? Keep a downloaded private draft first if you need one.")) return;
  recoveryActionBusy = true;
  recoveryControls();
  try {
    await pauseRecovery();
    await recoveryTransaction("readwrite", store => { store.delete("current"); });
    status("recovery-status", "On-device recovery copy removed. Your current page work is still here.");
  } catch (error) { status("recovery-status", error.message, true); }
  finally { recoveryActionBusy = false; recoveryControls(); }
}

async function saveCheckpoint() {
  const button = $("save-draft");
  button.disabled = true;
  try {
    const passphrase = $("draft-passphrase").value;
    if (passphrase !== $("draft-confirm").value) throw Error("Draft passphrases do not match.");
    const envelope = await sealDraft(await checkpoint(), passphrase);
    downloadJson(envelope, `remembrance-private-draft-${new Date().toISOString().slice(0, 10)}.json`);
    $("draft-passphrase").value = "";
    $("draft-confirm").value = "";
    status("draft-status", "Private draft downloaded, including the memory you are editing. Keep the file and its passphrase; save another checkpoint after further changes.");
  } catch (error) { status("draft-status", error.message, true); }
  finally { button.disabled = false; }
}

function hasUnsavedWork() {
  return recordingRequested || !!recorder || memories.length > 0 ||
    pendingPhoto !== null || pendingAudio !== null ||
    $("memory-photo").files.length > 0 || $("memory-audio").files.length > 0 ||
    ["recipient", "from", "letter", "memory-title", "memory-when", "memory-story"]
      .some(id => $(id).value.trim());
}

function applyRestoredDraft(restored) {
  invalidatePreparedGift();
  abortRecording();
  $("recipient").value = restored.recipient;
  $("from").value = restored.from;
  $("letter").value = restored.letter;
  memories = restored.memories;
  editingIndex = restored.editing_index;
  pendingPhoto = restored.pending.photo;
  pendingAudio = restored.pending.audio ?? null;
  $("memory-title").value = restored.pending.title;
  $("memory-when").value = restored.pending.when;
  $("memory-story").value = restored.pending.story;
  $("memory-photo").value = "";
  $("memory-audio").value = "";
  $("passphrase").value = "";
  $("confirm-passphrase").value = "";
  $("pending-photo-hint").textContent = pendingPhoto ?
    "A photo from your saved draft is attached to the unfinished memory. Choose a new file to replace it." : "";
  $("pending-audio-hint").textContent = pendingAudio ?
    "A voice recording from your saved draft is attached. Play it back or choose a new recording to replace it." : "";
  showAudioPreview(pendingAudio || (editingIndex === null ? null : memories[editingIndex].audio));
  $("save-memory").textContent = editingIndex === null ? "Add memory" : "Save changes";
  $("cancel-edit").hidden = editingIndex === null;
  renderMemoryList();
}

async function resumeCheckpoint() {
  const button = $("resume-draft");
  button.disabled = true;
  try {
    const file = $("draft-file").files[0];
    if (!file || file.size > MAX_FILE_BYTES) throw Error("Choose a private draft JSON file under 27 MB.");
    const restored = await openDraft(await file.text(), $("restore-passphrase").value);
    if (hasUnsavedWork() && !confirm("Replace the unfinished work currently on this page with this saved draft?")) {
      status("draft-status", "Current work kept. The saved draft was not loaded.");
      return;
    }
    applyRestoredDraft(restored);
    scheduleRecovery();
    status("draft-status", "Private draft restored locally. Continue editing, then save a new draft or seal the finished gift.");
    $("recipient").focus();
  } catch (error) { status("draft-status", error.message, true); }
  finally { button.disabled = false; $("restore-passphrase").value = ""; }
}

function preparedGiftIsCurrent() {
  if (preparedGift && !recordingRequested && !recorder && !hasUnfinishedMemory() &&
      preparedGift.snapshot === giftSnapshot()) return true;
  invalidatePreparedGift();
  status("create-status", "The gift has changed. Seal it again before using the prepared file.", true);
  return false;
}

function showPreparedGift() {
  $("share-ready").hidden = false;
  $("share-filename").textContent = preparedGift.filename;
  let canShare = false;
  try { canShare = !!preparedGift.file && !!navigator.share &&
    !!navigator.canShare?.({ files: [preparedGift.file] }); }
  catch { /* The download option remains available. */ }
  $("share-file").hidden = !canShare;
  $("share-fallback").hidden = canShare;
}

async function sealGift(download) {
  $("download").disabled = true;
  $("prepare-share").disabled = true;
  try {
    const capsule = draft();
    const snapshot = giftSnapshot();
    const passphrase = $("passphrase").value;
    if (!passphrase && !$("confirm-passphrase").value && preparedGift && preparedGiftIsCurrent()) {
      if (download) downloadBlob(preparedGift.blob, preparedGift.filename);
      status("create-status", download ? "Prepared encrypted file downloaded again." :
        "Your encrypted file is already ready. Share or download it below.");
      return;
    }
    if (passphrase !== $("confirm-passphrase").value) throw Error("Passphrases do not match.");
    preparedGift = null;
    $("share-ready").hidden = true;
    const envelope = await sealCapsule(capsule, passphrase);
    if (snapshot !== giftSnapshot() || hasUnfinishedMemory() || recordingRequested || recorder) {
      throw Error("The gift changed while sealing. Seal it again to include the latest edits.");
    }
    const filename = `remembrance-capsule-${new Date().toISOString().slice(0, 10)}.json`;
    const contents = JSON.stringify(envelope, null, 2) + "\n";
    const file = typeof File === "function" ?
      new File([contents], filename, { type: "application/json" }) : null;
    const blob = file || new Blob([contents], { type: "application/json" });
    if (blob.size > MAX_FILE_BYTES) throw Error("This gift exceeds the 27 MB file limit.");
    preparedGift = { file, blob, filename, snapshot };
    $("passphrase").value = "";
    $("confirm-passphrase").value = "";
    showPreparedGift();
    if (download) downloadBlob(blob, filename);
    status("create-status", download ?
      "Sealed file downloaded. Keep a copy, or share the prepared file. Give its passphrase separately." :
      $("share-file").hidden ?
        "Sealed file ready. Download it and share from your device. Give its passphrase separately." :
        "Sealed file ready. Tap Share sealed file, or download it. Give its passphrase separately.");
  } catch (error) { status("create-status", error.message, true); }
  finally { $("download").disabled = false; $("prepare-share").disabled = false; }
}

function sharePreparedGift() {
  if (!preparedGiftIsCurrent()) return;
  let sharing;
  try {
    if (!navigator.share || !navigator.canShare?.({ files: [preparedGift.file] })) {
      throw Error("File sharing unavailable");
    }
    // No await before share(): browsers require this call within the tap's user activation.
    sharing = navigator.share({ files: [preparedGift.file] });
  } catch {
    status("create-status", "This browser cannot share the file. Download the prepared file instead.", true);
    return;
  }
  $("share-file").disabled = true;
  status("create-status", "Choose where to send the encrypted file. The passphrase is not included.");
  sharing.then(() => status("create-status",
    "Share sheet closed. Confirm the file arrived, then give the passphrase separately.")).catch(error => {
    status("create-status", error.name === "AbortError" ?
      "Sharing canceled. The encrypted file is still ready." :
      "Could not share the file. Download the prepared copy instead.", error.name !== "AbortError");
  }).finally(() => { $("share-file").disabled = false; });
}

function downloadPreparedGift() {
  if (!preparedGiftIsCurrent()) return;
  downloadBlob(preparedGift.blob, preparedGift.filename);
  status("create-status", "Prepared encrypted file downloaded. Give the passphrase separately.");
}

async function copyOpeningSteps() {
  if (!preparedGiftIsCurrent()) return;
  const reader = new URL("./", location.href).href;
  const steps = `To open a Remembrance Capsule:\n` +
    `1. Keep the encrypted .json file on your device.\n` +
    `2. Open the capsule reader: ${reader}\n` +
    `3. Choose “Open a gift,” select the file, and enter the passphrase I give you separately.\n\n` +
    `Keep the file and passphrase private.`;
  try {
    await navigator.clipboard.writeText(steps);
    status("create-status", "Opening steps copied. Send them with the encrypted file, then give the passphrase separately.");
  } catch {
    status("create-status", "Copying is unavailable here. Share the reader link and tell them to choose Open a gift, select the file, and enter the passphrase separately.", true);
  }
}

async function openGift() {
  const button = $("open-capsule");
  button.disabled = true;
  openedCapsule = null;
  $("opened").hidden = true;
  try {
    const file = $("capsule-file").files[0];
    if (!file || file.size > MAX_FILE_BYTES) throw Error("Choose a sealed capsule JSON file under 27 MB.");
    const capsule = await openCapsule(await file.text(), $("open-passphrase").value);
    showGift(capsule, "Capsule opened locally. The file was not uploaded.");
  } catch (error) { status("open-status", error.message, true); }
  finally { button.disabled = false; $("open-passphrase").value = ""; }
}

function showSample() {
  switchTab("open");
  showGift(FICTIONAL_SAMPLE, "Fictional written sample · Add your own voice note when creating a gift.");
}

async function saveOfflineReader() {
  const button = $("save-offline-reader");
  if (!navigator.serviceWorker) {
    status("offline-status", "Offline saving is unavailable in this browser. You can still use the reader online.", true);
    return;
  }
  button.disabled = true;
  status("offline-status", "Saving the reader code on this device…");
  let timeout;
  try {
    const registration = await navigator.serviceWorker.register("./offline-worker.js",
      { scope: "./", updateViaCache: "none" });
    // ready stays pending if installation fails, so bound the wait and report a failure.
    const active = await Promise.race([
      navigator.serviceWorker.ready.then(ready => ready.active),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Error("timeout")), 20_000); })
    ]);
    if (!active) throw Error("no active worker");
    status("offline-status", "Reader saved on this device. Bookmark this page and keep the sealed file and passphrase separately. Your browser may clear offline data.");
  } catch {
    status("offline-status", "Could not save the reader here. Check your connection and browser settings, then try again.", true);
  } finally {
    clearTimeout(timeout);
    button.disabled = false;
  }
}

function ask() {
  const answer = $("answer");
  answer.replaceChildren();
  if (!openedCapsule) return;
  try {
    const result = recallMemories(openedCapsule, $("memory-question").value);
    if (result.kind !== "matched") {
      answer.append(element("p", "", result.kind === "insufficient_question" ?
        "Ask about a specific moment, place, or detail in the written memories." :
        "I could not find that in these written memories. I will not make up an answer."));
      return;
    }
    answer.append(element("p", "", "Related memories from this capsule:"));
    for (const match of result.matches) {
      const article = element("article");
      article.append(element("small", "", `Memory ${match.index} of ${openedCapsule.memories.length} · ${match.title}`),
        element("p", "", match.story));
      const memory = openedCapsule.memories[match.index - 1];
      if (memory.audio) article.append(voicePlayer(memory));
      answer.append(article);
    }
  } catch (error) { answer.append(element("p", "", error.message)); }
}

$("create-tab").addEventListener("click", () => switchTab("create"));
$("open-tab").addEventListener("click", () => switchTab("open"));
$("save-memory").addEventListener("click", saveMemory);
$("next-story-prompt").addEventListener("click", () => {
  storyPromptIndex = (storyPromptIndex + 1) % STORY_PROMPTS.length;
  $("story-prompt").textContent = STORY_PROMPTS[storyPromptIndex];
  $("memory-story").focus();
});
$("record-voice").addEventListener("click", startRecording);
$("stop-recording").addEventListener("click", stopRecording);
$("discard-recording").addEventListener("click", () => {
  pendingAudio = null;
  showAudioPreview(editingIndex === null ? null : memories[editingIndex].audio);
  $("pending-audio-hint").textContent = "Recording discarded. The original voice note, if any, is still attached to this memory.";
  status("record-status", "Recording discarded from this page session.");
  scheduleRecovery();
});
$("memory-photo").addEventListener("change", () => {
  if (!$("memory-photo").files[0]) {
    pendingPhoto = null;
    $("pending-photo-hint").textContent = "Photo selection cleared.";
  }
});
$("memory-audio").addEventListener("change", () => {
  if (!$("memory-audio").files[0]) {
    pendingAudio = null;
    showAudioPreview(editingIndex === null ? null : memories[editingIndex].audio);
    $("pending-audio-hint").textContent = "Voice file selection cleared.";
    return;
  }
  pendingAudio = null;
  showAudioPreview(null);
  $("pending-audio-hint").textContent = "Selected file will replace the attached voice note when you add this memory or save a private draft.";
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden" || !recoverySealer) return;
  clearTimeout(recoveryTimer);
  recoveryTimer = null;
  flushRecovery();
});
window.addEventListener("pagehide", () => {
  abortRecording();
  if (!recoverySealer) return;
  clearTimeout(recoveryTimer);
  recoveryTimer = null;
  const session = recoverySession;
  return Promise.resolve(flushRecovery()).finally(() => {
    if (session !== recoverySession) return;
    pauseRecovery();
    status("recovery-status", "Recovery paused after leaving this page. Enable it again to save further edits.");
  });
});
$("save-draft").addEventListener("click", saveCheckpoint);
$("resume-draft").addEventListener("click", resumeCheckpoint);
$("enable-recovery").addEventListener("click", enableRecovery);
$("restore-recovery").addEventListener("click", restoreRecovery);
$("forget-recovery").addEventListener("click", forgetRecovery);
$("cancel-edit").addEventListener("click", () => { clearMemoryForm(); renderMemoryList(); scheduleRecovery(); });
$("preview").addEventListener("click", () => {
  try { const capsule = draft(); switchTab("open");
    showGift(capsule, "Preview only · Seal a file to keep or share this gift."); }
  catch (error) { status("create-status", error.message, true); }
});
$("download").addEventListener("click", () => sealGift(true));
$("prepare-share").addEventListener("click", () => sealGift(false));
$("share-file").addEventListener("click", sharePreparedGift);
$("download-prepared").addEventListener("click", downloadPreparedGift);
$("copy-opening-steps").addEventListener("click", copyOpeningSteps);
for (const id of ["recipient", "from", "letter", "memory-title", "memory-when", "memory-story"]) {
  $(id).addEventListener("input", () => { invalidatePreparedGift(); scheduleRecovery(); });
}
for (const id of ["memory-photo", "memory-audio"]) {
  $(id).addEventListener("change", () => { invalidatePreparedGift(); scheduleRecovery(); });
}
$("open-capsule").addEventListener("click", openGift);
window.addEventListener("afterprint", () => document.body.classList.remove("capsule-print"));
$("print-keepsake").addEventListener("click", () => {
  if (!openedCapsule) return;
  pauseAudioWithin($("gift-view"));
  document.body.classList.add("capsule-print");
  try {
    window.print();
    status("open-status", "Choose a printer or save as PDF. A PDF copy is unencrypted; keep it private.");
  } catch {
    document.body.classList.remove("capsule-print");
    status("open-status", "Printing is unavailable in this browser. The digital gift is still open here.", true);
  }
});
$("edit-opened").addEventListener("click", () => {
  if (!openedCapsule) return;
  if (hasUnsavedWork() && !confirm("Replace the unfinished work currently on this page with an editable copy of this gift?")) return;
  $("recipient").value = openedCapsule.recipient;
  $("from").value = openedCapsule.from;
  $("letter").value = openedCapsule.letter;
  memories = structuredClone(openedCapsule.memories);
  invalidatePreparedGift();
  clearMemoryForm();
  renderMemoryList();
  $("passphrase").value = "";
  $("confirm-passphrase").value = "";
  switchTab("create");
  status("create-status", "This is an editable copy in this page session. The opened file is unchanged; seal and download a new file to keep edits.");
  $("recipient").focus();
  scheduleRecovery();
});
$("sample").addEventListener("click", showSample);
$("save-offline-reader").addEventListener("click", saveOfflineReader);
$("hero-sample").addEventListener("click", () => { showSample(); $("make").scrollIntoView(); });
$("ask").addEventListener("click", ask);
$("memory-question").addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); ask(); }
});
renderMemoryList();
