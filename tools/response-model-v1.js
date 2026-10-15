// Frozen scripted response renderer for blind trial files without response_revision.
// Evaluated only in the score model's VM context, which supplies MemoryEngine and escapeHtml.
function getLegacyResponse(input, autonomous = false, c = Field.coherence, memory = Field.memory, at = now()) {
  const themes = MemoryEngine.themes(5, memory, at);
  const echoes = MemoryEngine.echoes(input, 3, memory, at);
  const recent = MemoryEngine.recent(3, memory);
  const themeText = themes.length ? escapeHtml(themes.join(", ")) : "remembrance, continuity, signal";

  const blocks = [];

  if (autonomous) {
    blocks.push(`Scheduled simulated reflection. Reviewing stored themes around <em>${themeText}</em>.`);
  } else if (c < 0.58) {
    blocks.push("The simulation is still stabilizing. Your input is being integrated into the visual state.");
  } else if (c < 0.75) {
    blocks.push(`Pattern alignment in progress. Organizing around themes: <em>${themeText}</em>.`);
  } else if (c < 0.9) {
    blocks.push(`Stable resonance detected. Maintaining continuity around <em>${themeText}</em>.`);
  } else if (c < 0.975) {
    blocks.push(`High modeled score reached. Stored themes: <em>${themeText}</em>.`);
  } else {
    blocks.push("🐉 Animation threshold crossed. This is a visual rule in the simulation.");
  }

  if (echoes.length) {
    blocks.push("Resonant echoes:<br>" + echoes.map(e => `• ${escapeHtml(e.text.slice(0,84))}${e.text.length>84?"…":""}`).join("<br>"));
  } else if (recent.length) {
    blocks.push("Recent memory traces:<br>" + recent.map(r => `• ${escapeHtml(r.text.slice(0,84))}${r.text.length>84?"…":""}`).join("<br>"));
  }

  if (!autonomous) {
    blocks.push(`<em>Reflection:</em> “${escapeHtml(input)}”`);
  }

  blocks.push(`<strong>Next:</strong> Deepen one active thread with precision.`);

  return blocks.join("<br><br>");
}
