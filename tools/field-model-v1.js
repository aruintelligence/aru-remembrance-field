// Archived v1 score rules for verifying earlier receipts. Do not edit.
function tokenize(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(w => w.length > 2);
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function now() { return Date.now(); }
function ageFactor(ts, at = now()) {
  const hours = Math.max(0, (at - Number(ts)) / 36e5);
  return Math.exp(-hours / 42);
}

function escapeHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function similarity(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  let overlap = 0;
  A.forEach(t => { if (B.has(t)) overlap++; });
  return overlap / Math.max(A.size, B.size, 1);
}

const MemoryEngine = {
  add(input) {
    Field.memory = advanceMemory(Field.memory, input, Field.coherence, now());
    Field.save();
  },

  recent(n = 4, memory = Field.memory) { return memory.slice(-n); },

  themes(limit = 5, memory = Field.memory, at = now()) {
    const freq = {};
    const stop = new Set(["that","with","this","from","have","will","been","they","them","just","what","your","into","about","there","their","would","could","should","field","remember","memory","coherence","signal","thing","really"]);
    memory.slice(-32).forEach(m => {
      (m.tokens || []).forEach(t => {
        if (!stop.has(t)) freq[t] = (freq[t] || 0) + (m.weight || 1) * ageFactor(m.time, at);
      });
    });
    return Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,limit).map(e=>e[0]);
  },

  resonance(input, memory = Field.memory, at = now()) {
    const tokens = tokenize(input);
    return memory.slice(-22).reduce((acc, m) => {
      return acc + similarity(tokens, m.tokens || []) * (m.weight || 1) * ageFactor(m.time, at) * 0.05;
    }, 0);
  },

  echoes(input, limit = 3, memory = Field.memory, at = now()) {
    const tokens = tokenize(input);
    return memory
      .map(m => ({ text: m.text, score: similarity(tokens, m.tokens || []) * (m.weight || 1) * ageFactor(m.time, at) }))
      .filter(x => x.score > 0.16)
      .sort((a,b) => b.score - a.score)
      .slice(0, limit);
  }
};

function advanceMemory(memory, input, coherence, at) {
  const next = memory.map(m => ({...m, tokens: [...(m.tokens || [])]}));
  const tokens = tokenize(input);
  const cleaned = input.toLowerCase().replace(/[^\w\s]/g, "").trim();
  let best = null;
  let bestScore = 0;
  for (const m of next.slice(-24)) {
    const score = similarity(tokens, m.tokens) + (m.cleaned === cleaned ? 0.6 : 0);
    if (score > bestScore) { bestScore = score; best = m; }
  }
  if (best && bestScore >= 0.8) {
    best.text = input;
    best.tokens = tokens;
    best.cleaned = cleaned;
    best.time = at;
    best.weight = clamp((best.weight || 1) + 0.22, 0.2, 6);
    best.count = (best.count || 1) + 1;
  } else {
    next.push({text: input, cleaned, tokens, weight: 1 + coherence * 1.5, time: at, count: 1});
  }
  next.forEach(m => {
    m.weight = clamp((m.weight || 1) * (0.992 + ageFactor(m.time, at) * 0.006), 0.15, 6);
  });
  return next.slice(-100);
}

function detectIntent(input) {
  const lower = input.toLowerCase().trim();
  if (lower.includes("?")) return "question";
  if (/\b(i am|i feel|i remember|i know|i believe|this is)\b/.test(lower)) return "identity";
  if (/\b(why|how|what if|explain|show|help|explore)\b/.test(lower)) return "exploration";
  if (/\b(always|never|must|cannot)\b/.test(lower)) return "absolute";
  if (lower.split(/\s+/).length <= 4) return "fragment";
  return "statement";
}

function contradictionPenalty(input, memory = Field.memory) {
  const lower = input.toLowerCase();
  const recent = memory.slice(-10).map(m => m.text.toLowerCase());
  let penalty = 0;
  if (lower.includes("always") && recent.some(t => t.includes("never"))) penalty += 0.03;
  if (lower.includes("never") && recent.some(t => t.includes("always"))) penalty += 0.03;
  if (lower.includes("true") && recent.some(t => t.includes("false"))) penalty += 0.02;
  if (lower.includes("false") && recent.some(t => t.includes("true"))) penalty += 0.02;
  return penalty;
}

function repetitionPenalty(input, messages = Field.messages) {
  const cleaned = input.toLowerCase().replace(/[^\w\s]/g, "").trim();
  const recentUser = messages.filter(m => m.type === "user").slice(-5).map(m => (m.text || "").toLowerCase().replace(/[^\w\s]/g, "").trim());
  const repeats = recentUser.filter(x => x === cleaned).length;
  return repeats ? repeats * 0.03 : 0;
}

function evaluateCoherence(input, state, at) {
  const before = state.coherence;
  const terms = [];
  let delta = 0;
  const addTerm = (label, value) => {
    terms.push({ label, value });
    delta += value;
  };
  const lower = input.toLowerCase();
  const intent = detectIntent(input);
  const tokens = tokenize(input);

  const powerWords = {
    awareness: 0.04, remember: 0.035, remembrance: 0.04, memory: 0.024,
    sovereign: 0.024, consciousness: 0.03, truth: 0.024, presence: 0.02,
    ignite: 0.018, witness: 0.02, inward: 0.02
  };

  let wordBonus = 0;
  Object.entries(powerWords).forEach(([w, b]) => { if (lower.includes(w)) wordBonus += b; });
  addTerm("Matched word rules", wordBonus);

  addTerm("Length rule", (tokens.length > 8 ? 0.012 : 0) + (tokens.length > 18 ? 0.016 : 0));
  addTerm("Intent rule", intent === "question" ? 0.01 : intent === "exploration" ? 0.014 : intent === "absolute" ? -0.015 : 0);

  addTerm("Prior memory overlap", MemoryEngine.resonance(input, state.memory, at));
  addTerm("Contradiction rule", -contradictionPenalty(input, state.memory));
  addTerm("Prior repetition rule", -repetitionPenalty(input, state.messages));
  addTerm("Baseline drift", -(0.008 + before * 0.009));

  const after = clamp(before + delta, 0.35, 0.995);
  return { before, delta, after, terms, clamped: after !== before + delta };
}

function compareInput(input, at = now()) {
  // Hold the starting score and timestamp fixed. Only prior memory and message
  // history are removed in the control; neither branch mutates stored state.
  const state = { coherence: Field.coherence, memory: Field.memory, messages: Field.messages };
  const actual = evaluateCoherence(input, state, at);
  const control = evaluateCoherence(input, { coherence: state.coherence, memory: [], messages: [] }, at);
  return { actual, control, effect: actual.after - control.after, at };
}

function runTrajectory(inputs, startMu = 0.64, startAt = 1700000000000, stepMs = 1000) {
  let withHistory = startMu;
  let withoutHistory = startMu;
  let memory = [];
  const messages = [];
  const steps = [];
  inputs.forEach((input, index) => {
    const at = startAt + index * stepMs;
    const actual = evaluateCoherence(input, {coherence: withHistory, memory, messages}, at);
    const control = evaluateCoherence(input, {coherence: withoutHistory, memory: [], messages: []}, at);
    withHistory = actual.after;
    withoutHistory = control.after;
    steps.push({input, at, actual, control, effect: withHistory - withoutHistory});
    memory = advanceMemory(memory, input, withHistory, at);
    messages.push({type: "user", text: input});
  });
  return {steps, final: {with_history: withHistory, without_history: withoutHistory,
    difference: withHistory - withoutHistory}};
}

function updateCoherence(input) {
  // The score reads only the last 22 memories and last five user messages.
  // Capture exactly those prior inputs before this submission changes history.
  const priorMemory = Field.memory.slice(-22).map(m => ({
    text: m.text, tokens: [...m.tokens], weight: m.weight, time: m.time
  }));
  const priorUserMessages = Field.messages.filter(m => m.type === "user").slice(-5)
    .map(m => ({ type: "user", text: m.text }));
  const comparison = compareInput(input);
  Field.coherence = comparison.actual.after;
  Field.lastTransition = {
    ...comparison.actual,
    evaluatedAt: comparison.at,
    control: { after: comparison.control.after, delta: comparison.control.delta },
    memoryEffect: comparison.effect
  };
  Field.lastProof = {
    schema_version: 1,
    model_revision: PROOF_MODEL_REVISION,
    scope: "one-step symbolic score; not an authenticated record",
    input,
    evaluated_at: comparison.at,
    start_mu: comparison.actual.before,
    prior_memory: priorMemory,
    prior_user_messages: priorUserMessages,
    result: {
      actual: comparison.actual,
      control: comparison.control,
      history_effect: comparison.effect
    }
  };
  Field.save();
  return Field.lastTransition;
}

function getResponse(input, autonomous = false, c = Field.coherence, memory = Field.memory, at = now()) {
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

