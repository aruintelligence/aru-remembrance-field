import { CAPSULE_FORMAT, DRAFT_FORMAT, FICTIONAL_SAMPLE, MAX_AUDIO_BYTES,
  MAX_FILE_BYTES, MAX_MEMORIES, MAX_PHOTO_BYTES, audioFromBytes, openCapsule,
  openDraft, photoFromBytes, recallMemories, sealCapsule, sealDraft,
  validateCapsule, validateDraft } from "./core.mjs?v=342747fb9592ae4cfe27a7dd7b3c59403c498618efc71af3835b54ee5afa62b0";

const $ = id => document.getElementById(id);
let memories = [];
let editingIndex = null;
let openedCapsule = null;
let pendingPhoto = null;
let pendingAudio = null;
let recorder = null;
let recordingStream = null;
let recordingTimer = null;
let recordingRequested = false;
let captureAttempt = 0;
const MAX_RECORDING_SECONDS = 30;

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

function draft() {
  if (recordingRequested || recorder) throw Error("Stop the voice recording before previewing or sealing your gift.");
  if (editingIndex !== null || pendingPhoto || pendingAudio ||
      $("memory-photo").files[0] || $("memory-audio").files[0] ||
      ["memory-title", "memory-when", "memory-story"].some(id => $(id).value.trim())) {
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
        status("record-status", "Voice note ready to play. Save the memory and download a gift or private draft to keep it.");
      } catch (error) {
        status("record-status", error.message, true);
      } finally {
        if (recorder === current) { recorder = null; recordingControls(); }
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
    const edit = element("button", "button quiet small", "Edit");
    edit.type = "button";
    edit.setAttribute("aria-label", `Edit ${memory.title}`);
    edit.addEventListener("click", () => {
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
    });
    const remove = element("button", "button quiet small", "Remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${memory.title}`);
    remove.addEventListener("click", () => {
      memories.splice(index, 1);
      clearMemoryForm();
      renderMemoryList();
      status("create-status", "Memory removed from this page session.");
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
        renderMemoryList();
        status("create-status", "Voice note removed from this page session. Save a new private draft or gift to keep the change.");
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
    clearMemoryForm();
    renderMemoryList();
    status("create-status", "Memory saved in this page session. Download the capsule to keep it.");
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

function showGift(capsule, label) {
  openedCapsule = validateCapsule(capsule);
  $("opened").hidden = false;
  $("answer").replaceChildren();
  $("memory-question").value = "";
  const view = $("gift-view");
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
  view.append(letter, heading, cards);
  status("open-status", label);
  $("opened").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ?
    "auto" : "smooth", block: "start" });
}

function downloadJson(envelope, filename) {
  const blob = new Blob([JSON.stringify(envelope, null, 2) + "\n"],
    { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = element("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function checkpoint() {
  if (recordingRequested || recorder) throw Error("Stop the voice recording before saving a private draft.");
  const selected = $("memory-photo").files[0];
  if (selected) {
    if (selected.size > MAX_PHOTO_BYTES) throw Error("Choose a photo under 600 KB.");
    pendingPhoto = photoFromBytes(await selected.arrayBuffer(), selected.type);
  }
  const selectedAudio = $("memory-audio").files[0];
  if (selectedAudio) {
    if (selectedAudio.size > MAX_AUDIO_BYTES) throw Error("Choose a voice recording under 1 MB.");
    pendingAudio = audioFromBytes(await selectedAudio.arrayBuffer(),
      selectedAudio.type, selectedAudio.name);
  }
  return validateDraft({ format: DRAFT_FORMAT, saved_at: new Date().toISOString(),
    recipient: $("recipient").value, from: $("from").value, letter: $("letter").value,
    memories, editing_index: editingIndex,
    pending: { title: $("memory-title").value, when: $("memory-when").value,
      story: $("memory-story").value, photo: pendingPhoto, audio: pendingAudio } });
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
    status("draft-status", "Private draft restored locally. Continue editing, then save a new draft or seal the finished gift.");
    $("recipient").focus();
  } catch (error) { status("draft-status", error.message, true); }
  finally { button.disabled = false; $("restore-passphrase").value = ""; }
}

async function downloadGift() {
  const button = $("download");
  button.disabled = true;
  try {
    const capsule = draft();
    const passphrase = $("passphrase").value;
    if (passphrase !== $("confirm-passphrase").value) throw Error("Passphrases do not match.");
    const envelope = await sealCapsule(capsule, passphrase);
    downloadJson(envelope, `remembrance-capsule-${new Date().toISOString().slice(0, 10)}.json`);
    $("passphrase").value = "";
    $("confirm-passphrase").value = "";
    status("create-status", "Sealed file downloaded. Save a second copy somewhere you control, and share the passphrase separately. It cannot be recovered here.");
  } catch (error) { status("create-status", error.message, true); }
  finally { button.disabled = false; }
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
$("record-voice").addEventListener("click", startRecording);
$("stop-recording").addEventListener("click", stopRecording);
$("discard-recording").addEventListener("click", () => {
  pendingAudio = null;
  showAudioPreview(editingIndex === null ? null : memories[editingIndex].audio);
  $("pending-audio-hint").textContent = "Recording discarded. The original voice note, if any, is still attached to this memory.";
  status("record-status", "Recording discarded from this page session.");
});
$("memory-audio").addEventListener("change", () => {
  if (!$("memory-audio").files[0]) return;
  pendingAudio = null;
  showAudioPreview(null);
  $("pending-audio-hint").textContent = "Selected file will replace the attached voice note when you add this memory or save a private draft.";
});
window.addEventListener("pagehide", abortRecording);
$("save-draft").addEventListener("click", saveCheckpoint);
$("resume-draft").addEventListener("click", resumeCheckpoint);
$("cancel-edit").addEventListener("click", () => { clearMemoryForm(); renderMemoryList(); });
$("preview").addEventListener("click", () => {
  try { const capsule = draft(); switchTab("open");
    showGift(capsule, "Preview only · Download a sealed file to keep and share it."); }
  catch (error) { status("create-status", error.message, true); }
});
$("download").addEventListener("click", downloadGift);
$("open-capsule").addEventListener("click", openGift);
$("edit-opened").addEventListener("click", () => {
  if (!openedCapsule) return;
  if (hasUnsavedWork() && !confirm("Replace the unfinished work currently on this page with an editable copy of this gift?")) return;
  $("recipient").value = openedCapsule.recipient;
  $("from").value = openedCapsule.from;
  $("letter").value = openedCapsule.letter;
  memories = structuredClone(openedCapsule.memories);
  clearMemoryForm();
  renderMemoryList();
  $("passphrase").value = "";
  $("confirm-passphrase").value = "";
  switchTab("create");
  status("create-status", "This is an editable copy in this page session. The opened file is unchanged; seal and download a new file to keep edits.");
  $("recipient").focus();
});
$("sample").addEventListener("click", showSample);
$("hero-sample").addEventListener("click", () => { showSample(); $("make").scrollIntoView(); });
$("ask").addEventListener("click", ask);
$("memory-question").addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); ask(); }
});
renderMemoryList();
