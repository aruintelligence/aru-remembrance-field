import { CAPSULE_FORMAT, FICTIONAL_SAMPLE, MAX_FILE_BYTES, MAX_MEMORIES,
  MAX_PHOTO_BYTES, openCapsule, photoFromBytes, recallMemories, sealCapsule,
  validateCapsule } from "./core.mjs";

const $ = id => document.getElementById(id);
let memories = [];
let editingIndex = null;
let openedCapsule = null;

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
  return validateCapsule({ format: CAPSULE_FORMAT,
    created_at: new Date().toISOString(), recipient: $("recipient").value,
    from: $("from").value, letter: $("letter").value, memories });
}

function clearMemoryForm() {
  for (const id of ["memory-title", "memory-when", "memory-story", "memory-photo"]) {
    $(id).value = "";
  }
  editingIndex = null;
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
      element("span", "", [memory.when, memory.photo ? "Photo included" : ""].filter(Boolean).join(" · ") || "Story included"));
    const actions = element("div", "actions");
    const edit = element("button", "button quiet small", "Edit");
    edit.type = "button";
    edit.setAttribute("aria-label", `Edit ${memory.title}`);
    edit.addEventListener("click", () => {
      editingIndex = index;
      $("memory-title").value = memory.title;
      $("memory-when").value = memory.when;
      $("memory-story").value = memory.story;
      $("memory-photo").value = "";
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
    actions.append(edit, remove);
    row.append(info, actions);
    list.append(row);
  });
}

async function saveMemory() {
  const button = $("save-memory");
  button.disabled = true;
  try {
    const photoFile = $("memory-photo").files[0];
    let photo = editingIndex === null ? null : memories[editingIndex].photo;
    if (photoFile) {
      if (photoFile.size > MAX_PHOTO_BYTES) throw Error("Choose a photo under 600 KB.");
      photo = photoFromBytes(await photoFile.arrayBuffer(), photoFile.type);
    }
    const candidate = { id: editingIndex === null ? crypto.randomUUID() : memories[editingIndex].id,
      title: $("memory-title").value, when: $("memory-when").value,
      story: $("memory-story").value, photo };
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

async function downloadGift() {
  const button = $("download");
  button.disabled = true;
  try {
    const capsule = draft();
    const passphrase = $("passphrase").value;
    if (passphrase !== $("confirm-passphrase").value) throw Error("Passphrases do not match.");
    const envelope = await sealCapsule(capsule, passphrase);
    const blob = new Blob([JSON.stringify(envelope, null, 2) + "\n"],
      { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = element("a");
    anchor.href = url;
    anchor.download = `remembrance-capsule-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
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
    if (!file || file.size > MAX_FILE_BYTES) throw Error("Choose a sealed capsule JSON file under 10 MB.");
    const capsule = await openCapsule(await file.text(), $("open-passphrase").value);
    showGift(capsule, "Capsule opened locally. The file was not uploaded.");
  } catch (error) { status("open-status", error.message, true); }
  finally { button.disabled = false; $("open-passphrase").value = ""; }
}

function showSample() {
  switchTab("open");
  showGift(FICTIONAL_SAMPLE, "Fictional sample · No personal file was opened.");
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
      answer.append(article);
    }
  } catch (error) { answer.append(element("p", "", error.message)); }
}

$("create-tab").addEventListener("click", () => switchTab("create"));
$("open-tab").addEventListener("click", () => switchTab("open"));
$("save-memory").addEventListener("click", saveMemory);
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
