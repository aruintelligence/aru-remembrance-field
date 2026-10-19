const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const { createHash, webcrypto } = require('node:crypto');
const { verifyProof, loadEvaluator } = require('../tools/verify-proof.cjs');
const { verifyTrajectory } = require('../tools/verify-trajectory.cjs');
const { verifyMemoryChallenge } = require('../tools/verify-memory-challenge.cjs');
const { verifyEvidenceReceipt, verifyLedgerCheckpoint } = require('../tools/verify-evidence-receipt.cjs');
const { verifyBlindTrial } = require('../tools/verify-blind-trial.cjs');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function boot(values = {}, options = {}) {
  const saved = options.sharedSaved || new Map(Object.entries(values));
  const elements = new Map();
  const exports = [];
  const frames = new Map();
  let nextFrame = 1;
  let paintCalls = 0;
  const documentEvents = new Map();
  const windowEvents = new Map();
  const motionPreference = {
    matches: !!options.reducedMotion,
    addEventListener(event, callback) { if (event === 'change') this.onchange = callback; }
  };
  const canvasContext = { setTransform() {}, fillRect() { paintCalls++; }, fillStyle: '' };
  class Element {
    constructor(tag = 'div') {
      this.tag = tag;
      this.children = [];
      this.value = '';
      this.style = {};
      this.textContent = '';
      this.innerHTML = '';
      this.className = '';
    }
    appendChild(child) { this.children.push(child); child.parent = this; }
    replaceChildren() { this.children = []; }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this);
    }
    scrollIntoView() {}
    focus() {}
    setAttribute(name, value) { (this.attributes ||= {})[name] = value; }
    getAttribute(name) { return this.attributes?.[name] ?? null; }
    getContext() { return canvasContext; }
    click() { this.clicked = true; }
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const document = {
    body: new Element('body'),
    currentScript: options.scriptSource === null ? null : {textContent: source},
    hidden: !!options.hidden,
    addEventListener(event, callback) { documentEvents.set(event, callback); },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element(id));
      return elements.get(id);
    },
    createElement(tag) { return new Element(tag); }
  };
  const window = {
    innerWidth: 72, innerHeight: 72, devicePixelRatio: options.dpr || 1,
    addEventListener(event, callback) { windowEvents.set(event, callback); }, confirm() { return true },
    matchMedia() { return motionPreference; },
    location: { reload() { window.reloaded = true; } }
  };
  const localStorage = {
    getItem(key) { return saved.has(key) ? saved.get(key) : null; },
    setItem(key, value) { saved.set(key, value); },
    removeItem(key) { saved.delete(key); }
  };
  const context = vm.createContext({
    document, window, localStorage, console, Blob, TextEncoder, TextDecoder,
    crypto: options.crypto || webcrypto,
    URL: {
      createObjectURL(blob) { exports.push(blob); return 'blob:test-export'; },
      revokeObjectURL() {}
    },
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); }, setInterval() {},
    setTimeout(callback) { callback(); }
  });
  vm.runInContext(source, context);
  return {
    context, saved, elements, exports, window,
    get pendingFrames() { return frames.size; },
    get paintCalls() { return paintCalls; },
    setHidden(hidden) { document.hidden = hidden; documentEvents.get('visibilitychange')(); },
    notifyStorage(key) { windowEvents.get('storage')?.({key}); },
    setReducedMotion(reduced) {
      motionPreference.matches = reduced;
      motionPreference.onchange?.();
    },
    flushFrame(timestamp) {
      const first = frames.entries().next().value;
      if (!first) return;
      frames.delete(first[0]);
      first[1](timestamp);
    },
    field: vm.runInContext('Field', context),
    input(value) {
      document.getElementById('input').value = value;
      vm.runInContext('ignite()', context);
    },
    fact(key, value) {
      document.getElementById('fact-key').value = key;
      document.getElementById('fact-value').value = value;
      vm.runInContext('rememberFact()', context);
    }
  };
}

test('browser capture profile agrees with Node for the selected originals', async () => {
  const app = boot();
  const root = path.join(__dirname, '..', 'research');
  const files = ['example-evidence-reference-baseline.json',
    'example-evidence-excerpt.json', 'example-evidence-receipt.json'];
  app.context.selectedValuesForTest = files.map(name =>
    JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')));
  const browser = await vm.runInContext('evidenceNormalizationProfile(selectedValuesForTest)',
    app.context);
  const {auditEvidenceBatch} = require('../tools/audit-evidence-batch.cjs');
  const node = auditEvidenceBatch(path.join(root, files[0]),
    files.slice(1).map(name => path.join(root, name)));
  assert.equal(browser, node.normalization_sha256);
});

test('first input is evaluated against prior state, with an exact receipt', () => {
  const app = boot();
  app.input('What?');
  const receipt = app.field.lastTransition;
  const terms = Object.fromEntries(receipt.terms.map(term => [term.label, term.value]));
  assert.equal(terms['Prior memory overlap'], 0);
  assert.ok(terms['Prior repetition rule'] === 0);
  assert.ok(Math.abs(receipt.after - 0.63624) < 1e-9);
  assert.equal(receipt.control.after, receipt.after);
  assert.equal(receipt.memoryEffect, 0);
  assert.ok(Number.isFinite(receipt.evaluatedAt));
  assert.ok(Math.abs(receipt.before + receipt.terms.reduce((sum, term) => sum + term.value, 0) - receipt.after) < 1e-9);
  assert.equal(app.field.memory.length, 1);
  assert.equal(app.field.messages[0].text, 'What?');
  const response = app.elements.get('messages').children.find(el => el.innerHTML.includes('Reflection:'));
  assert.ok(response);
  assert.ok(!response.innerHTML.includes('Resonant echoes:'));
});

test('reduced motion keeps a static field while scoring and the pause control resumes it', () => {
  const app = boot({}, {reducedMotion: true, dpr: 4});
  const button = app.elements.get('motion-toggle');
  assert.equal(app.elements.get('field').width, 144, 'canvas DPR is capped at two');
  assert.equal(app.pendingFrames, 0);
  assert.ok(app.paintCalls > 0, 'a static field is visible');
  assert.equal(button.getAttribute('aria-checked'), 'false');
  assert.equal(app.elements.get('motion-state').textContent, 'off');
  app.input('remember');
  assert.ok(app.field.coherence > 0.64, 'the simulation still scores input');
  assert.equal(app.field.time, 0, 'a paused visual does no simulation steps');
  assert.equal(app.pendingFrames, 0);

  vm.runInContext('toggleVisualMotion()', app.context);
  assert.equal(button.getAttribute('aria-checked'), 'true');
  assert.equal(app.pendingFrames, 1);
  app.flushFrame(0);
  assert.equal(app.field.time, 1);
  app.flushFrame(16);
  assert.equal(app.field.time, 1, 'the active renderer caps work at 30 frames per second');
  app.flushFrame(34);
  assert.equal(app.field.time, 2);
  app.setHidden(true);
  assert.equal(app.pendingFrames, 0);
  app.flushFrame(70);
  assert.equal(app.field.time, 2);
  app.setHidden(false);
  app.flushFrame(100);
  assert.equal(app.field.time, 3);
  vm.runInContext('toggleVisualMotion()', app.context);
  assert.equal(app.pendingFrames, 0);
  app.setReducedMotion(false);
  assert.equal(app.pendingFrames, 0, 'manual choice persists through a preference change');
});

test('system motion changes pause and resume an untouched animation control', () => {
  const app = boot();
  assert.equal(app.pendingFrames, 1);
  const before = app.paintCalls;
  app.setReducedMotion(true);
  assert.equal(app.pendingFrames, 0);
  assert.ok(app.paintCalls > before);
  assert.equal(app.elements.get('motion-toggle').getAttribute('aria-checked'), 'false');
  app.setReducedMotion(false);
  assert.equal(app.pendingFrames, 1);
  assert.equal(app.field.coherence, 0.64);
  assert.equal(app.saved.size, 0);
});

test('second identical input sees prior overlap and prior repetition', () => {
  const app = boot();
  app.input('What?');
  app.input('What?');
  const terms = Object.fromEntries(app.field.lastTransition.terms.map(term => [term.label, term.value]));
  assert.ok(terms['Prior memory overlap'] > 0);
  assert.equal(terms['Prior repetition rule'], -0.03);
  assert.equal(app.field.messages.filter(message => message.type === 'user').length, 2);
  assert.ok(app.field.lastTransition.memoryEffect > 0);
  assert.ok(Math.abs(app.field.lastTransition.memoryEffect -
    (app.field.lastTransition.after - app.field.lastTransition.control.after)) < 1e-12);
});

test('matched and unrelated memory probes isolate the immediate history effect', () => {
  const app = boot();
  const at = 1700000000000;
  const memory = [{ text: 'violet river', tokens: ['violet', 'river'], cleaned: 'violet river', weight: 2, time: at, count: 1 }];
  const evaluate = vm.runInContext('evaluateCoherence', app.context);
  const state = { coherence: 0.64, memory, messages: [] };
  const control = { coherence: 0.64, memory: [], messages: [] };
  const matched = evaluate('violet river', state, at);
  const matchedControl = evaluate('violet river', control, at);
  const unrelated = evaluate('amber comet', state, at);
  const unrelatedControl = evaluate('amber comet', control, at);

  assert.equal(matchedControl.after, 0.62624);
  assert.ok(Math.abs(matched.after - matchedControl.after - 0.1) < 1e-12);
  assert.equal(unrelated.after, unrelatedControl.after);
  assert.equal(app.field.coherence, 0.64);
  assert.equal(app.field.memory.length, 0);
});

test('contradiction and repetition can give a negative history effect', () => {
  const app = boot();
  const evaluate = vm.runInContext('evaluateCoherence', app.context);
  const at = 1700000000000;
  const state = {
    coherence: 0.64,
    memory: [{ text: 'always', tokens: ['always'], weight: 1, time: at }],
    messages: [{ type: 'user', text: 'never' }]
  };
  const withHistory = evaluate('never', state, at);
  const withoutHistory = evaluate('never', { coherence: 0.64, memory: [], messages: [] }, at);
  assert.ok(Math.abs(withHistory.after - withoutHistory.after + 0.06) < 1e-12);
  assert.equal(withHistory.terms.find(t => t.label === 'Contradiction rule').value, -0.03);
  assert.equal(withHistory.terms.find(t => t.label === 'Prior repetition rule').value, -0.03);
});

test('draft comparison changes neither local state nor the draft and escapes preview text', () => {
  const app = boot({
    aru_memory: JSON.stringify([{ text: '<img src=x onerror=alert(1)> violet river', time: Date.now(), weight: 2 }])
  });
  const input = app.elements.get('input') || app.context.document.getElementById('input');
  input.value = 'violet river';
  vm.runInContext('compareDraft()', app.context);
  const panel = app.elements.get('draft-comparison').children[0];
  const cards = panel.children[1].children;
  assert.match(cards[0].children[1].innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(cards[0].children[1].innerHTML, /<img/);
  assert.doesNotMatch(cards[1].children[1].innerHTML, /onerror/);
  assert.equal(input.value, 'violet river');
  assert.equal(app.field.coherence, 0.64);
  assert.equal(app.field.messages.length, 0);
  assert.equal(app.saved.has('aru_last_transition'), false);
});

test('portable proof replays the exact prior state and detects changed receipts or inputs', async () => {
  const app = boot();
  app.input('violet river');
  app.input('violet river');
  vm.runInContext('downloadProof()', app.context);
  const proof = JSON.parse(await app.exports[0].text());
  assert.equal(proof.model_revision, 'aru-field-heuristics-3');
  assert.equal(proof.prior_memory.length, 1);
  assert.equal(proof.prior_user_messages.length, 1);
  assert.equal(proof.prior_user_messages[0].text, 'violet river');
  assert.ok(verifyProof(proof).effect > 0);
  assert.deepEqual(JSON.parse(app.saved.get('aru_last_proof')), proof);

  const changedScore = structuredClone(proof);
  changedScore.result.actual.after += 0.01;
  assert.throws(() => verifyProof(changedScore), /actual\.after/);
  const changedInput = structuredClone(proof);
  changedInput.input = 'amber comet';
  assert.throws(() => verifyProof(changedInput), /does not match/);

  vm.runInContext('eraseProof()', app.context);
  assert.equal(app.field.lastProof, null);
  assert.equal(app.saved.has('aru_last_proof'), false);
  assert.ok(app.field.lastTransition);
});

async function chooseScoreProofFile(app, text, size = Buffer.byteLength(text)) {
  const input = app.context.document.getElementById('score-proof-file');
  input.files = [{size, text: async () => text}];
  await vm.runInContext('verifyScoreProofFile()', app.context);
  return app.elements.get('score-proof-verification').textContent;
}

test('browser replays a shared v3 correction proof and a fresh positive history effect without changing local state', async () => {
  const visitor = boot({unrelated_key: 'keep'});
  visitor.fact('private fact', 'do not overwrite');
  const before = JSON.stringify([...visitor.saved]);
  const fixture = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-proof-v3.json'), 'utf8');
  assert.match(await chooseScoreProofFile(visitor, fixture), /PASS: input “My favorite color is not teal\.”.*With history μ 0.59624; no-history control μ 0.62624; immediate effect -0.03000/);
  assert.ok(Math.abs(verifyProof(JSON.parse(fixture)).effect + 0.03) < 1e-12);
  const origin = boot();
  origin.input('violet river');
  origin.input('violet river');
  const raw = JSON.stringify(origin.field.lastProof);
  const expected = verifyProof(JSON.parse(raw));
  assert.ok(expected.effect > 0);
  assert.match(await chooseScoreProofFile(visitor, raw), /PASS: input “violet river”/);
  assert.match(visitor.elements.get('score-proof-verification').textContent, /immediate effect \+/);
  assert.equal(JSON.stringify([...visitor.saved]), before);
  assert.equal(visitor.field.coherence, 0.64);
  assert.equal(visitor.field.messages.length, 0);
  assert.equal(visitor.field.claims[0].value, 'do not overwrite');
});

test('browser score verifier rejects changed terms, control, effect, unsupported revision, and malformed files', async () => {
  const app = boot();
  const proof = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-proof-v3.json'), 'utf8'));
  const term = structuredClone(proof);
  term.result.actual.terms[0].value += 0.01;
  assert.match(await chooseScoreProofFile(app, JSON.stringify(term)), /FAIL: Invalid proof: actual term 1/);
  const control = structuredClone(proof);
  control.result.control.after += 0.01;
  assert.match(await chooseScoreProofFile(app, JSON.stringify(control)), /FAIL: Invalid proof: control.after/);
  const effect = structuredClone(proof);
  effect.result.history_effect += 0.01;
  assert.match(await chooseScoreProofFile(app, JSON.stringify(effect)), /FAIL: Invalid proof: history effect/);
  const legacy = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-proof.json'), 'utf8');
  assert.ok(verifyProof(JSON.parse(legacy)).effect > 0);
  assert.match(await chooseScoreProofFile(app, legacy), /FAIL: Invalid proof: only current v3/i);
  const archived = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-proof-v2.json'), 'utf8');
  assert.equal(verifyProof(JSON.parse(archived)).effect, 0);
  assert.match(await chooseScoreProofFile(app, archived), /FAIL: Invalid proof: only current v3/i);
  assert.match(await chooseScoreProofFile(app, '{oops'), /FAIL: File is not valid JSON/);
  assert.match(await chooseScoreProofFile(app, '{}', 16 * 1024 * 1024 + 1), /FAIL: Proof exceeds the 16 MiB limit/);
  assert.equal(app.saved.size, 0);
});

test('browser score proof output treats untrusted input as text and ignores a stale read', async () => {
  const origin = boot();
  origin.input('<img src=x onerror=alert(1)>');
  const app = boot();
  assert.match(await chooseScoreProofFile(app, JSON.stringify(origin.field.lastProof)), /PASS: input “<img src=x onerror=alert\(1\)>”/);
  assert.equal(app.elements.get('score-proof-verification').innerHTML, '');
  const input = app.context.document.getElementById('score-proof-file');
  let finishFirst;
  input.files = [{size: 2, text: () => new Promise(resolve => { finishFirst = resolve; })}];
  const first = vm.runInContext('verifyScoreProofFile()', app.context);
  assert.match(await chooseScoreProofFile(app, '{}'), /FAIL: Invalid proof: unsupported schema/);
  finishFirst('{}');
  await first;
  assert.match(app.elements.get('score-proof-verification').textContent, /FAIL: Invalid proof: unsupported schema/);
});

test('whole-word v2 rules reject substrings and retain Unicode and punctuation boundaries', () => {
  const current = loadEvaluator('aru-field-heuristics-2');
  const legacy = loadEvaluator('aru-field-heuristics-1');
  const at = 1700000000000;
  const state = {coherence: 0.64, memory: [
    {text: 'always', tokens: ['always'], weight: 1, time: at}
  ], messages: [{type: 'user', text: 'rose river'}]};
  const evaluate = (context, input) => {
    context.input = input;
    context.state = state;
    return vm.runInContext('evaluateCoherence(input, state, 1700000000000)', context);
  };
  const term = (receipt, label) => receipt.terms.find(item => item.label === label).value;
  assert.equal(term(evaluate(legacy, 'misremember'), 'Matched word rules'), 0.035);
  assert.equal(term(evaluate(current, 'misremember'), 'Matched word rules'), 0);
  assert.equal(term(evaluate(legacy, 'untruth'), 'Matched word rules'), 0.024);
  assert.equal(term(evaluate(current, 'untruth'), 'Matched word rules'), 0);
  assert.equal(term(evaluate(legacy, 'nevermore'), 'Contradiction rule'), -0.03);
  assert.ok(term(evaluate(current, 'nevermore'), 'Contradiction rule') === 0);
  assert.equal(term(evaluate(current, 'never'), 'Contradiction rule'), -0.03);
  assert.equal(term(evaluate(current, 'rose-river'), 'Prior repetition rule'), -0.03);
  assert.ok(term(evaluate(legacy, 'rose-river'), 'Prior repetition rule') === 0);
  assert.equal(vm.runInContext('JSON.stringify(tokenize("ＣＡＦÉ river"))', current), '["café","river"]');
  assert.equal(vm.runInContext('detectIntent("nevermore")', current), 'fragment');
  assert.equal(vm.runInContext('detectIntent("never")', current), 'absolute');
});

test('every scored keyword requires its own word boundary', () => {
  const current = loadEvaluator('aru-field-heuristics-2');
  const keywords = ['awareness', 'remember', 'remembrance', 'memory', 'sovereign',
    'consciousness', 'truth', 'presence', 'ignite', 'witness', 'inward'];
  const state = {coherence: 0.64, memory: [], messages: []};
  for (const word of keywords) {
    current.state = state;
    current.input = word;
    const isolated = vm.runInContext('evaluateCoherence(input, state, 1700000000000)', current);
    assert.ok(isolated.terms[0].value > 0, `${word} should score alone`);
    for (const input of [`prefix${word}`, `${word}suffix`, `prefix${word}suffix`]) {
      current.input = input;
      const wrapped = vm.runInContext('evaluateCoherence(input, state, 1700000000000)', current);
      assert.ok(wrapped.terms[0].value === 0, `${input} must not earn a word bonus`);
    }
    current.input = `(${word})`;
    const punctuated = vm.runInContext('evaluateCoherence(input, state, 1700000000000)', current);
    assert.equal(punctuated.terms[0].value, isolated.terms[0].value);
  }
});

test('v1, v2, and v3 score receipts and trajectories verify under their own revisions', () => {
  const read = file => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', file), 'utf8'));
  assert.ok(verifyProof(read('example-proof.json')).effect > 0);
  assert.equal(verifyProof(read('example-proof-v2.json')).effect, 0);
  assert.ok(Math.abs(verifyProof(read('example-proof-v3.json')).effect + 0.03) < 1e-12);
  assert.equal(verifyTrajectory(read('example-trajectory.json')).steps, 5);
  assert.equal(verifyTrajectory(read('example-trajectory-v2.json')).steps, 3);
  assert.equal(verifyTrajectory(read('example-trajectory-v3.json')).steps, 2);
  const wrongRevision = read('example-proof-v2.json');
  wrongRevision.model_revision = 'aru-field-heuristics-1';
  assert.throws(() => verifyProof(wrongRevision), /does not match the model/);
});

test('blind A/B trial hides labels until rating, then exports a replayable local report', async () => {
  const app = boot({unrelated_key: 'keep'});
  app.fact('private', 'saved');
  const before = JSON.stringify([...app.saved]);
  app.context.document.getElementById('blind-context').value = 'violet river';
  app.context.document.getElementById('blind-prompt').value = 'violet river';
  vm.runInContext('runBlindTrial()', app.context);
  const report = vm.runInContext('lastBlindTrial', app.context);
  assert.ok(report);
  assert.equal(report.choice, null);
  assert.equal(new Set(Object.values(report.assignment)).size, 2);
  assert.equal(app.elements.get('blind-reader-dialog').open, true);
  assert.equal(app.elements.get('blind-vote').hidden, true);
  assert.equal(app.elements.get('blind-download').disabled, true);
  assert.equal(app.elements.get('blind-reveal').textContent, '');
  assert.equal(app.elements.get('blind-result').children[0].children.length, 2);
  assert.equal(app.elements.get('blind-reader-result').children[0].children.length, 2);
  assert.equal(app.elements.get('blind-reader-context').textContent, 'violet river');
  assert.equal(app.elements.get('blind-reader-prompt').textContent, 'violet river');
  assert.ok(report.conditions.with_history.score.after > report.conditions.without_history.score.after);
  const chosen = report.assignment.A === 'with_history' ? 'A' : 'B';
  vm.runInContext(`rateBlindTrial('${chosen}')`, app.context);
  assert.equal(report.choice, chosen);
  assert.equal(app.elements.get('blind-reader-dialog').open, false);
  assert.match(app.elements.get('blind-reveal').textContent, /with prior history.*one subjective rating/);
  assert.equal(app.elements.get('blind-vote').hidden, true);
  assert.equal(app.elements.get('blind-download').disabled, false);
  vm.runInContext('rateBlindTrial("tie")', app.context);
  assert.equal(report.choice, chosen, 'rating is locked after reveal');
  vm.runInContext('downloadBlindTrial()', app.context);
  const exported = JSON.parse(await app.exports[0].text());
  assert.equal(verifyBlindTrial(exported).preferred, 'with_history');
  assert.equal(JSON.stringify([...app.saved]), before);
  assert.equal(app.field.coherence, 0.64);
  assert.equal(app.field.messages.length, 0);
});

test('closing reader view does not rate, reopening preserves assignment, and editing clears it', () => {
  const app = boot();
  app.context.document.getElementById('blind-context').value = 'context <script>private</script>';
  app.context.document.getElementById('blind-prompt').value = 'What was in the context?';
  vm.runInContext('runBlindTrial()', app.context);
  const trial = vm.runInContext('lastBlindTrial', app.context);
  const dialog = app.elements.get('blind-reader-dialog');
  assert.equal(dialog.open, true);
  assert.equal(app.elements.get('blind-reader-context').textContent, 'context <script>private</script>');
  assert.equal(app.elements.get('blind-reader-context').innerHTML, '');
  vm.runInContext('closeBlindReader(); blindReaderClosed()', app.context);
  assert.equal(dialog.open, false);
  assert.equal(trial.choice, null);
  assert.equal(app.elements.get('blind-download').disabled, true);
  assert.match(app.elements.get('blind-reveal').textContent, /closed without a rating/);
  vm.runInContext('openBlindReader()', app.context);
  assert.equal(dialog.open, true);
  assert.equal(vm.runInContext('lastBlindTrial', app.context), trial);
  app.elements.get('blind-prompt').value = 'changed';
  vm.runInContext('clearBlindTrial()', app.context);
  assert.equal(dialog.open, false);
  assert.equal(vm.runInContext('lastBlindTrial', app.context), null);
  assert.equal(app.elements.get('blind-reader-result').children.length, 0);
  assert.equal(app.elements.get('blind-open-reader').hidden, true);
  assert.equal(app.saved.size, 0);
});

test('older browsers can still rate in the inspector when a modal dialog is unavailable', () => {
  const app = boot();
  app.context.document.getElementById('blind-reader-dialog').showModal = undefined;
  app.context.document.getElementById('blind-context').value = 'violet river';
  app.context.document.getElementById('blind-prompt').value = 'violet river';
  vm.runInContext('runBlindTrial()', app.context);
  assert.equal(app.elements.get('blind-vote').hidden, false);
  assert.equal(app.elements.get('blind-open-reader').hidden, true);
  vm.runInContext('rateBlindTrial("tie")', app.context);
  assert.equal(vm.runInContext('lastBlindTrial.choice', app.context), 'tie');
  assert.equal(app.elements.get('blind-vote').hidden, true);
});

test('a local fixed plan fills a blind case and an edited input cannot masquerade as it', async () => {
  const app = boot({unrelated_key: 'keep'});
  const plan = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-blind-trial-plan-v3.json'), 'utf8');
  const file = app.context.document.getElementById('blind-plan-file');
  file.files = [{size: Buffer.byteLength(plan), text: async () => plan}];
  await vm.runInContext('loadBlindTrialPlan()', app.context);
  const selector = app.elements.get('blind-plan-case');
  assert.equal(selector.disabled, false);
  assert.equal(selector.children.length, 2);
  assert.match(app.elements.get('blind-plan-status').textContent, /1 case, 1 expected rating/);
  selector.value = '0';
  vm.runInContext('selectBlindPlanCase()', app.context);
  assert.equal(app.elements.get('blind-context').value, 'favorite color teal');
  assert.equal(app.elements.get('blind-prompt').value, 'My favorite color is not teal.');
  vm.runInContext('runBlindTrial()', app.context);
  vm.runInContext('rateBlindTrial("tie")', app.context);
  vm.runInContext('downloadBlindTrial()', app.context);
  const report = JSON.parse(await app.exports[0].text());
  assert.equal(verifyBlindTrial(report).preferred, 'tie');
  assert.deepEqual(report.context, ['favorite color teal']);
  assert.equal(report.prompt, 'My favorite color is not teal.');
  assert.equal(report.response_revision, 'aru-response-2');
  assert.equal(report.model_revision, 'aru-field-heuristics-3');

  app.elements.get('blind-prompt').value = 'edited';
  vm.runInContext('clearBlindTrial()', app.context);
  assert.equal(selector.value, '');
  assert.equal(app.elements.get('blind-download').disabled, true);
  vm.runInContext('runBlindTrial()', app.context);
  assert.match(app.elements.get('blind-result').textContent, /Choose a planned case/);
  assert.equal(JSON.stringify([...app.saved]), JSON.stringify([['unrelated_key', 'keep']]));
});

test('blind plan loading rejects invalid files and ignores an older read', async () => {
  const app = boot();
  const file = app.context.document.getElementById('blind-plan-file');
  const plan = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-blind-trial-plan-v3.json'), 'utf8');
  file.files = [{size: Buffer.byteLength(plan), text: async () => plan}];
  await vm.runInContext('loadBlindTrialPlan()', app.context);
  assert.equal(app.elements.get('blind-plan-case').disabled, false);

  const repeated = JSON.parse(plan);
  repeated.cases.push({...repeated.cases[0], id: 'duplicate'});
  const invalid = JSON.stringify(repeated);
  file.files = [{size: Buffer.byteLength(invalid), text: async () => invalid}];
  await vm.runInContext('loadBlindTrialPlan()', app.context);
  assert.match(app.elements.get('blind-plan-status').textContent, /FAIL: Repeated context and prompt/);
  assert.equal(app.elements.get('blind-plan-case').disabled, true);

  const oldPlan = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-blind-trial-plan-v2.json'), 'utf8');
  file.files = [{size: Buffer.byteLength(oldPlan), text: async () => oldPlan}];
  await vm.runInContext('loadBlindTrialPlan()', app.context);
  assert.match(app.elements.get('blind-plan-status').textContent, /FAIL: Unsupported trial plan/);
  assert.equal(app.elements.get('blind-plan-case').disabled, true);

  let finishOld;
  file.files = [{size: Buffer.byteLength(plan), text: () => new Promise(resolve => { finishOld = resolve; })}];
  const oldRead = vm.runInContext('loadBlindTrialPlan()', app.context);
  file.files = [{size: 1024 * 1024 + 1, text: async () => ''}];
  await vm.runInContext('loadBlindTrialPlan()', app.context);
  finishOld(plan);
  await oldRead;
  assert.match(app.elements.get('blind-plan-status').textContent, /FAIL: Plan exceeds 1 MiB/);
  assert.equal(app.elements.get('blind-plan-case').disabled, true);
  assert.equal(app.saved.size, 0);
});

test('blind trial invalidates an edited question, rejects invalid input, and escapes shared text', () => {
  const app = boot();
  const context = app.context.document.getElementById('blind-context');
  const prompt = app.context.document.getElementById('blind-prompt');
  context.value = 'violet river';
  vm.runInContext('runBlindTrial()', app.context);
  assert.match(app.elements.get('blind-result').textContent, /Enter 1–8 context lines/);
  prompt.value = '<img src=x onerror=alert(1)> violet river';
  vm.runInContext('runBlindTrial()', app.context);
  const cards = app.elements.get('blind-result').children[0].children;
  assert.match(cards[0].children[1].innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(cards[0].children[1].innerHTML, /<img/);
  prompt.value = 'changed prompt';
  vm.runInContext('clearBlindTrial()', app.context);
  assert.equal(vm.runInContext('lastBlindTrial', app.context), null);
  assert.equal(app.elements.get('blind-vote').hidden, true);
  assert.equal(app.elements.get('blind-result').children.length, 0);
  vm.runInContext('downloadBlindTrial()', app.context);
  assert.equal(app.exports.length, 0);
  assert.equal(app.saved.size, 0);
});

test('blind trial verifier detects altered outputs and context while exposing its rating limit', async () => {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-blind-trial.json'), 'utf8'));
  assert.equal(verifyBlindTrial(example).preferred, 'tie', 'the public fixture is synthetic, not a claimed human win');
  assert.equal(verifyBlindTrial(example).responseRevision, 'aru-response-1');
  const guarded = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-blind-trial-v2.json'), 'utf8'));
  assert.equal(verifyBlindTrial(guarded).responseRevision, 'aru-response-2');
  assert.match(guarded.conditions.with_history.response_html, /memory echoes are withheld/);
  assert.doesNotMatch(guarded.conditions.with_history.response_html, /Resonant echoes/);
  const corrected = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-blind-trial-v3.json'), 'utf8'));
  assert.equal(verifyBlindTrial(corrected).modelRevision, 'aru-field-heuristics-3');
  assert.ok(corrected.conditions.with_history.score.after < corrected.conditions.without_history.score.after);
  const app = boot();
  app.context.document.getElementById('blind-context').value = 'always';
  app.context.document.getElementById('blind-prompt').value = 'never';
  vm.runInContext('runBlindTrial()', app.context);
  vm.runInContext('rateBlindTrial("tie")', app.context);
  vm.runInContext('downloadBlindTrial()', app.context);
  const report = JSON.parse(await app.exports[0].text());
  const result = verifyBlindTrial(report);
  assert.equal(result.preferred, 'tie');
  assert.ok(result.withHistory < result.withoutHistory);
  const score = structuredClone(report);
  score.conditions.with_history.score.after += 0.01;
  assert.throws(() => verifyBlindTrial(score), /after does not match/);
  const response = structuredClone(report);
  response.conditions.without_history.response_html += '<p>invented</p>';
  assert.throws(() => verifyBlindTrial(response), /response does not match/);
  const input = structuredClone(report);
  input.context[0] = 'something else';
  assert.throws(() => verifyBlindTrial(input), /does not match/);
  const unrated = structuredClone(report);
  unrated.choice = null;
  assert.throws(() => verifyBlindTrial(unrated), /invalid assignment or choice/);
  const unsupported = structuredClone(report);
  unsupported.response_revision = 'aru-response-9';
  assert.throws(() => verifyBlindTrial(unsupported), /unsupported blind trial/);
});

test('direct polarity corrections lose overlap credit and the response guard withholds stale echoes', () => {
  const at = 1700000001000;
  const model = loadEvaluator();
  model.memoryToCheck = vm.runInContext('advanceMemory([], "favorite color teal", 0.62624, 1700000000000)', model);
  model.inputToCheck = 'My favorite color is not teal.';
  const score = () => vm.runInContext('evaluateCoherence(inputToCheck, {coherence:0.62624, memory:memoryToCheck, messages:[{type:"user", text:"favorite color teal"}]}, 1700000001000)', model);
  const before = JSON.stringify(score());
  const correctedScore = score();
  assert.equal(correctedScore.terms.find(t => t.label === 'Prior memory overlap').value, 0);
  assert.equal(correctedScore.terms.find(t => t.label === 'Direct negation rule').value, -0.03);
  const oldModel = loadEvaluator('aru-field-heuristics-2');
  oldModel.inputToCheck = model.inputToCheck;
  oldModel.memoryToCheck = model.memoryToCheck;
  assert.ok(vm.runInContext('evaluateCoherence(inputToCheck, {coherence:0.62624, memory:memoryToCheck, messages:[{type:"user", text:"favorite color teal"}]}, 1700000001000).after', oldModel) > correctedScore.after);
  const memoryBefore = JSON.stringify(model.memoryToCheck);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'tools', 'response-model-v1.js'), 'utf8'), model);
  const priorOutput = vm.runInContext('getLegacyResponse(inputToCheck, false, 0.6851839079715081, memoryToCheck, 1700000001000)', model);
  assert.match(priorOutput, /Resonant echoes:<br>• favorite color teal/);
  const guarded = vm.runInContext('getResponse(inputToCheck, false, 0.6851839079715081, memoryToCheck, 1700000001000)', model);
  assert.match(guarded, /Earlier wording may conflict/);
  assert.doesNotMatch(guarded, /Resonant echoes:|Organizing around themes/);
  assert.equal(JSON.stringify(score()), before);
  assert.equal(JSON.stringify(model.memoryToCheck), memoryBefore);
  model.inputToCheck = 'favorite color teal';
  assert.match(vm.runInContext('getResponse(inputToCheck, false, 0.6851839079715081, memoryToCheck, 1700000001000)', model), /Resonant echoes/);
  model.inputToCheck = 'notably teal';
  assert.doesNotMatch(vm.runInContext('getResponse(inputToCheck, false, 0.6851839079715081, memoryToCheck, 1700000001000)', model), /Earlier wording may conflict/);
  model.inputToCheck = 'not teal';
  assert.match(vm.runInContext('getResponse(inputToCheck, false, 0.6851839079715081, memoryToCheck, 1700000001000)', model), /Earlier wording may conflict/);
  model.memoryToCheck = [{text: 'always', tokens: ['always'], weight: 2, time: at}];
  model.inputToCheck = 'never';
  assert.match(vm.runInContext('getResponse(inputToCheck, false, 0.6, memoryToCheck, 1700000001000)', model), /Earlier wording may conflict/);
});

test('full-sequence lab has positive, zero, and negative controls from a fresh initial score', () => {
  const app = boot({aru_coherence: '0.9', aru_memory: JSON.stringify([
    {text: 'violet river', time: Date.now(), weight: 2}
  ])});
  const savedBefore = JSON.stringify([...app.saved]);
  const run = vm.runInContext('runTrajectory', app.context);
  const positive = run(['violet river', 'violet river']);
  const unrelated = run(['amber comet', 'violet river']);
  const negative = run(['always', 'never']);
  assert.equal(positive.steps[0].effect, 0);
  assert.ok(Math.abs(positive.final.difference - 0.06677342396201069) < 1e-12);
  assert.equal(unrelated.final.difference, 0);
  assert.ok(Math.abs(negative.final.difference + 0.03) < 1e-12);
  assert.equal(negative.steps[1].actual.terms.find(t => t.label === 'Contradiction rule').value, -0.03);
  assert.equal(app.field.coherence, 0.9);
  assert.equal(app.field.memory.length, 1);
  assert.equal(JSON.stringify([...app.saved]), savedBefore);
});

test('trajectory download recomputes all steps, rejects altered results, and stays out of local storage', async () => {
  const app = boot();
  const input = app.context.document.getElementById('trajectory-input');
  input.value = 'violet river\nviolet river\n<svg onload=alert(1)>';
  vm.runInContext('runTrajectoryLab()', app.context);
  assert.equal(app.field.coherence, 0.64);
  assert.equal(app.field.memory.length, 0);
  assert.equal(app.saved.size, 0);
  const output = app.elements.get('trajectory-result');
  const table = output.children[1].children[0];
  const thirdInput = table.children[1].children[2].children[1];
  assert.match(thirdInput.textContent, /<svg onload=alert\(1\)>/);
  assert.equal(thirdInput.innerHTML, '');
  vm.runInContext('downloadTrajectory()', app.context);
  const proof = JSON.parse(await app.exports[0].text());
  assert.equal(proof.inputs.length, 3);
  assert.equal(verifyTrajectory(proof).steps, 3);
  const changedScore = structuredClone(proof);
  changedScore.steps[1].actual.after += 0.01;
  assert.throws(() => verifyTrajectory(changedScore), /step 2 with history\.after/);
  const changedInput = structuredClone(proof);
  changedInput.inputs[1] = 'amber comet';
  assert.throws(() => verifyTrajectory(changedInput), /does not match/);
  input.value = 'new draft';
  vm.runInContext('clearTrajectoryResult()', app.context);
  assert.equal(app.elements.get('trajectory-download').disabled, true);
  vm.runInContext('downloadTrajectory()', app.context);
  assert.equal(app.exports.length, 1);
});

test('trajectory limits invalid sequences and verifies the public synthetic fixture', () => {
  const app = boot();
  const input = app.context.document.getElementById('trajectory-input');
  input.value = 'one';
  vm.runInContext('runTrajectoryLab()', app.context);
  assert.match(app.elements.get('trajectory-result').textContent, /2–24/);
  assert.equal(app.elements.get('trajectory-download').disabled, true);
  input.value = `${'a'.repeat(501)}\nsecond`;
  vm.runInContext('runTrajectoryLab()', app.context);
  assert.match(app.elements.get('trajectory-result').textContent, /500 characters/);
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-trajectory.json'), 'utf8'));
  const result = verifyTrajectory(fixture);
  assert.equal(result.steps, 5);
  assert.ok(Math.abs(result.difference - 0.034986718779233206) < 1e-12);
});

test('four-control challenge includes direct corrections without changing saved state', async () => {
  const app = boot();
  app.input('My private local memory');
  app.fact('private fact', 'private value');
  const before = JSON.stringify([...app.saved]);
  vm.runInContext('runMemoryChallenge()', app.context);
  assert.match(app.elements.get('challenge-result').children[0].textContent, /4\/4 controls/);
  assert.equal(app.elements.get('challenge-download').disabled, false);
  const rows = app.elements.get('challenge-result').children[1].children[0].children[1].children;
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => row.children[5].textContent), ['Expected', 'Expected', 'Expected', 'Expected']);
  assert.equal(JSON.stringify([...app.saved]), before);
  vm.runInContext('downloadMemoryChallenge()', app.context);
  const report = JSON.parse(await app.exports[0].text());
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-memory-challenge-v3.json'), 'utf8'));
  assert.deepEqual(report, fixture);
  const results = verifyMemoryChallenge(report);
  assert.deepEqual(results.map(row => row.direction), ['positive', 'zero', 'negative', 'negative']);
  assert.equal(JSON.stringify(report).includes('private value'), false);
  assert.equal(JSON.stringify(report).includes('My private local memory'), false);
});

test('challenge verifier rejects altered outputs, missing controls, relabeling, and swapped inputs', () => {
  const archived = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-memory-challenge.json'), 'utf8'));
  assert.equal(verifyMemoryChallenge(archived).length, 3);
  const report = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-memory-challenge-v3.json'), 'utf8'));
  assert.equal(verifyMemoryChallenge(report).length, 4);
  const altered = structuredClone(report);
  altered.scenarios[0].trajectory.steps[1].actual.after += 0.01;
  assert.throws(() => verifyMemoryChallenge(altered), /step 2 with history\.after/);
  const missing = structuredClone(report);
  missing.scenarios.pop();
  assert.throws(() => verifyMemoryChallenge(missing), /exactly 4/);
  const relabeled = structuredClone(report);
  relabeled.scenarios[2].expected_direction = 'positive';
  assert.throws(() => verifyMemoryChallenge(relabeled), /fixed contradiction sequence/);
  const changed = structuredClone(report);
  changed.scenarios[1].trajectory.inputs = ['violet river', 'violet river'];
  assert.throws(() => verifyMemoryChallenge(changed), /fixed unrelated sequence/);
  const reworded = structuredClone(report);
  reworded.scenarios[3].trajectory.inputs[1] = 'My favorite color is teal.';
  assert.throws(() => verifyMemoryChallenge(reworded), /fixed direct-negation sequence/);
});

test('exact-key evidence recall cites user sources and survives reload without changing freeform memory', () => {
  const app = boot();
  app.fact(' Favorite   Color ', 'teal');
  assert.equal(app.field.claims.length, 1);
  assert.equal(app.field.memory.length, 0);
  assert.equal(app.field.messages.length, 0);
  assert.equal(app.field.coherence, 0.64);
  app.elements.get('fact-key').value = 'FAVORITE COLOR';
  vm.runInContext('recallFact()', app.context);
  assert.match(app.elements.get('ledger-result').textContent, /teal.*Source #1/);
  const reloaded = boot(Object.fromEntries(app.saved));
  reloaded.context.document.getElementById('fact-key').value = 'favorite color';
  vm.runInContext('recallFact()', reloaded.context);
  assert.match(reloaded.elements.get('ledger-result').textContent, /teal.*Source #1/);
  assert.equal(reloaded.field.claimCounter, 2);
});

test('reviewed correction preserves old sources, creates a current one, and replays its transition', async () => {
  const app = boot();
  app.fact('favorite color', 'teal');
  app.fact('FAVORITE  COLOR', 'purple');
  app.fact('unrelated note', 'private');
  const key = app.context.document.getElementById('fact-key');
  const value = app.context.document.getElementById('fact-value');
  key.value = 'Favorite color';
  value.value = '<img src=x onerror=alert(1)>';
  const before = JSON.stringify([...app.saved]);
  vm.runInContext('previewFactCorrection()', app.context);
  const preview = app.elements.get('correction-preview');
  assert.match(preview.children[0].textContent, /source #4.*<img src=x onerror=alert\(1\)>/);
  assert.equal(preview.children[0].innerHTML, '');
  assert.equal(preview.children.length, 3);
  assert.equal(JSON.stringify([...app.saved]), before);
  assert.equal(app.elements.get('correction-apply').disabled, false);
  vm.runInContext('applyFactCorrection()', app.context);
  assert.deepEqual(Array.from(app.field.claims, record => record.status),
    ['superseded', 'superseded', 'active', 'active']);
  assert.equal(app.field.claims[3].value, '<img src=x onerror=alert(1)>');
  assert.equal(app.field.claims[3].id, 4);
  assert.match(app.elements.get('ledger-result').textContent, /Source #4/);
  assert.equal(app.field.coherence, 0.64);
  assert.equal(app.field.messages.length, 0);
  assert.equal(app.elements.get('correction-download').disabled, false);
  vm.runInContext('downloadFactCorrection()', app.context);
  const receipt = JSON.parse(await app.exports[0].text());
  assert.equal(receipt.before_records.length, 3);
  assert.equal(receipt.after_records.length, 4);
  assert.equal(verifyEvidenceReceipt(receipt).superseded, 2);
  const visitor = boot();
  assert.match(await chooseReceiptFile(visitor, JSON.stringify(receipt)), /PASS: correction source #4; 2 prior current sources superseded/);
  assert.equal(visitor.saved.size, 0);
  assert.equal(visitor.field.claims.length, 0);
  const reloaded = boot(Object.fromEntries(app.saved));
  assert.equal(reloaded.field.claims[0].status, 'superseded');
  assert.equal(reloaded.field.claims[3].status, 'active');
  key.value = 'changed';
  vm.runInContext('invalidateFactCorrection()', app.context);
  vm.runInContext('downloadFactCorrection()', app.context);
  assert.equal(app.exports.length, 1);
  assert.equal(app.elements.get('correction-download').disabled, true);
});

test('correction preview refuses absent or unchanged facts and cannot apply after an edit', () => {
  const app = boot();
  const key = app.context.document.getElementById('fact-key');
  const value = app.context.document.getElementById('fact-value');
  key.value = 'city'; value.value = 'Portland';
  vm.runInContext('previewFactCorrection()', app.context);
  assert.match(app.elements.get('correction-preview').textContent, /No current source/);
  assert.equal(vm.runInContext('pendingFactCorrection', app.context), null);
  app.fact('city', 'Portland');
  key.value = 'city'; value.value = 'Portland';
  vm.runInContext('previewFactCorrection()', app.context);
  assert.match(app.elements.get('correction-preview').textContent, /already current/);
  value.value = 'Denver';
  vm.runInContext('previewFactCorrection()', app.context);
  const before = JSON.stringify(app.field.claims);
  value.value = 'Rome';
  vm.runInContext('applyFactCorrection()', app.context);
  assert.equal(JSON.stringify(app.field.claims), before);
  assert.equal(app.elements.get('correction-apply').disabled, true);
  value.value = 'Denver';
  vm.runInContext('previewFactCorrection()', app.context);
  app.fact('unrelated', 'new');
  assert.equal(app.elements.get('correction-apply').disabled, true);
  vm.runInContext('applyFactCorrection()', app.context);
  assert.equal(app.field.claims.length, 2);
});

test('reviewed correction respects session-only privacy and refuses a full ledger', async () => {
  const app = boot();
  app.fact('city', 'Portland');
  const saved = JSON.stringify([...app.saved]);
  vm.runInContext('toggleSessionOnly()', app.context);
  const key = app.context.document.getElementById('fact-key');
  const value = app.context.document.getElementById('fact-value');
  key.value = 'city'; value.value = 'Denver';
  vm.runInContext('previewFactCorrection(); applyFactCorrection(); downloadFactCorrection()', app.context);
  assert.equal(JSON.stringify([...app.saved]), saved);
  assert.equal(verifyEvidenceReceipt(JSON.parse(await app.exports[0].text())).kind, 'correction');
  const full = Array.from({length: 100}, (_, index) => ({id: index + 1,
    key: index === 0 ? 'city' : `name ${index}`, value: 'Portland', time: 1700000000000,
    status: 'active'}));
  const capped = boot({aru_fact_claims: JSON.stringify(full), aru_fact_counter: '101'});
  capped.context.document.getElementById('fact-key').value = 'city';
  capped.context.document.getElementById('fact-value').value = 'Denver';
  vm.runInContext('previewFactCorrection()', capped.context);
  assert.match(capped.elements.get('correction-preview').textContent, /100-record limit/);
  assert.equal(capped.field.claims.length, 100);
});

test('correction receipts reject tampering and show the completeness limit', async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-correction.json'), 'utf8'));
  assert.equal(verifyEvidenceReceipt(fixture).superseded, 2);
  const browser = boot();
  assert.match(await chooseReceiptFile(browser, JSON.stringify(fixture)), /PASS: correction source #5; 2 prior current sources superseded/);
  const altered = structuredClone(fixture);
  altered.after_records[0].status = 'active';
  assert.throws(() => verifyEvidenceReceipt(altered), /corrected ledger does not match/);
  assert.match(await chooseReceiptFile(browser, JSON.stringify(altered)), /FAIL: The corrected ledger does not match/);
  const revisedSource = structuredClone(fixture);
  revisedSource.after_records[4].value = 'violet';
  assert.throws(() => verifyEvidenceReceipt(revisedSource), /corrected ledger does not match/);
  const stale = structuredClone(fixture);
  stale.new_source_id = 3;
  assert.throws(() => verifyEvidenceReceipt(stale), /must exceed every prior source/);
  const missing = structuredClone(fixture);
  missing.before_records = missing.before_records.filter(record => record.id !== 3);
  assert.throws(() => verifyEvidenceReceipt(missing), /corrected ledger does not match/);
  const recomputed = structuredClone(missing);
  recomputed.after_records = require('../tools/benchmark-evidence.cjs').loadModel().correct(
    recomputed.name, recomputed.value, recomputed.before_records, recomputed.new_source_id, recomputed.applied_at);
  assert.equal(verifyEvidenceReceipt(recomputed).kind, 'correction',
    'a consistent receipt does not establish that all prior records were supplied');
});

function applicableCorrectionFixture() {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-correction.json'), 'utf8'));
  // The public synthetic receipt deliberately contains raw keys and omitted optional fields;
  // a transferable receipt has the canonical records exported by an actual browser.
  fixture.before_records = fixture.before_records.map(record => ({...record,
    key: record.key.trim().replace(/\s+/g, ' '), imported: record.imported === true}));
  fixture.after_records = require('../tools/benchmark-evidence.cjs').loadModel().correct(
    fixture.name, fixture.value, fixture.before_records, fixture.new_source_id, fixture.applied_at);
  return fixture;
}

test('a second browser can review and apply a correction only to the matching prior ledger', async () => {
  const origin = boot();
  origin.fact('favorite color', 'teal');
  origin.fact('FAVORITE  COLOR', 'purple');
  origin.fact('unrelated note', 'keep private');
  const before = Object.fromEntries(origin.saved);
  origin.elements.get('fact-key').value = 'favorite color';
  origin.elements.get('fact-value').value = 'amber';
  vm.runInContext('previewFactCorrection(); applyFactCorrection(); downloadFactCorrection()', origin.context);
  const receipt = JSON.parse(await origin.exports[0].text());
  const copy = boot(before);
  const originalStorage = JSON.stringify([...copy.saved]);
  assert.match(await chooseReceiptFile(copy, JSON.stringify(receipt)), /PASS: correction source #4/);
  assert.equal(copy.elements.get('incoming-correction-preview-button').disabled, false);
  assert.equal(copy.elements.get('incoming-correction-apply').disabled, true);
  vm.runInContext('previewIncomingCorrection()', copy.context);
  const preview = copy.elements.get('incoming-correction-preview');
  assert.match(preview.children[0].textContent, /source #4.*amber.*other 1 record/);
  assert.equal(preview.children.length, 3);
  assert.match(preview.children[1].textContent, /Current source #1: teal/);
  assert.match(preview.children[2].textContent, /Current source #2: purple/);
  assert.equal(preview.children[0].innerHTML, '');
  assert.equal(JSON.stringify([...copy.saved]), originalStorage, 'review does not write');
  assert.equal(copy.elements.get('incoming-correction-apply').disabled, false);
  vm.runInContext('applyIncomingCorrection()', copy.context);
  assert.deepEqual(JSON.parse(JSON.stringify(copy.field.claims)), receipt.after_records);
  assert.equal(copy.field.claimCounter, 5);
  assert.equal(copy.field.claims[2].value, 'keep private');
  assert.equal(copy.field.coherence, 0.64);
  assert.equal(copy.field.messages.length, 0);
  assert.match(copy.elements.get('incoming-correction-preview').textContent, /Applied source #4.*Saved/);
  assert.equal(copy.elements.get('incoming-correction-apply').disabled, true);
  const reopened = boot(Object.fromEntries(copy.saved));
  reopened.context.document.getElementById('fact-key').value = 'favorite color';
  vm.runInContext('recallFact()', reopened.context);
  assert.match(reopened.elements.get('ledger-result').textContent, /amber.*Source #4/);
  assert.equal(reopened.field.claims.length, 4);
});

test('incoming correction refuses divergence, stale previews, another format, and altered receipts', async () => {
  const fixture = applicableCorrectionFixture();
  const saved = {aru_fact_claims: JSON.stringify(fixture.before_records), aru_fact_counter: '5'};
  const copy = boot(saved);
  assert.match(await chooseReceiptFile(copy, JSON.stringify(fixture)), /PASS: correction source #5/);
  vm.runInContext('previewIncomingCorrection()', copy.context);
  const original = JSON.stringify(copy.field.claims);
  copy.field.claims[0].value = 'local edit';
  vm.runInContext('applyIncomingCorrection()', copy.context);
  assert.match(copy.elements.get('incoming-correction-preview').textContent, /changed after preview/);
  assert.equal(copy.elements.get('incoming-correction-apply').disabled, true);
  assert.notEqual(JSON.stringify(copy.field.claims), original);
  assert.equal(copy.field.claims.length, 4, 'no new record was added');
  vm.runInContext('previewIncomingCorrection()', copy.context);
  assert.match(copy.elements.get('incoming-correction-preview').textContent, /differs from the receipt/);
  const wrongCounter = boot({...saved, aru_fact_counter: '6'});
  await chooseReceiptFile(wrongCounter, JSON.stringify(fixture));
  vm.runInContext('previewIncomingCorrection()', wrongCounter.context);
  assert.match(wrongCounter.elements.get('incoming-correction-preview').textContent, /next source ID differs/);
  assert.equal(wrongCounter.elements.get('incoming-correction-apply').disabled, true);
  const changed = boot(saved);
  await chooseReceiptFile(changed, JSON.stringify(fixture));
  vm.runInContext('previewIncomingCorrection()', changed.context);
  changed.fact('another name', 'another value');
  assert.equal(changed.elements.get('incoming-correction-apply').disabled, true);
  assert.equal(vm.runInContext('pendingIncomingCorrection', changed.context), null);
  vm.runInContext('applyIncomingCorrection()', changed.context);
  assert.equal(changed.field.claims.length, 5);
  const broken = structuredClone(fixture);
  broken.after_records[0].status = 'active';
  assert.match(await chooseReceiptFile(changed, JSON.stringify(broken)), /FAIL:/);
  assert.equal(changed.elements.get('incoming-correction-preview-button').disabled, true);
  const question = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-receipt.json'), 'utf8');
  assert.match(await chooseReceiptFile(changed, question), /PASS: known/);
  assert.equal(changed.elements.get('incoming-correction-preview-button').disabled, true);
});

test('reviewed incoming correction in session-only mode never writes browser storage', async () => {
  const fixture = applicableCorrectionFixture();
  const app = boot({aru_fact_claims: JSON.stringify(fixture.before_records), aru_fact_counter: '5'});
  const saved = JSON.stringify([...app.saved]);
  vm.runInContext('toggleSessionOnly()', app.context);
  await chooseReceiptFile(app, JSON.stringify(fixture));
  vm.runInContext('previewIncomingCorrection(); applyIncomingCorrection()', app.context);
  assert.equal(JSON.stringify([...app.saved]), saved);
  assert.equal(app.field.claims.length, 5);
  assert.match(app.elements.get('incoming-correction-preview').textContent, /Session-only mode/);
  const reopened = boot(Object.fromEntries(app.saved));
  assert.equal(reopened.field.claims.length, 4);
});

test('incoming correction rejects a failed snapshot write and leaves the ledger intact', async () => {
  const fixture = applicableCorrectionFixture();
  const app = boot({aru_fact_claims: JSON.stringify(fixture.before_records), aru_fact_counter: '5'});
  await chooseReceiptFile(app, JSON.stringify(fixture));
  vm.runInContext('previewIncomingCorrection()', app.context);
  const priorStorage = JSON.stringify([...app.saved]);
  const priorLedger = JSON.stringify(app.field.claims);
  const setItem = app.context.localStorage.setItem.bind(app.context.localStorage);
  let failOnce = true;
  app.context.localStorage.setItem = (key, value) => {
    if (key === 'aru_fact_ledger_v1' && failOnce) { failOnce = false; throw new Error('quota'); }
    setItem(key, value);
  };
  vm.runInContext('applyIncomingCorrection()', app.context);
  assert.match(app.elements.get('incoming-correction-preview').textContent, /Browser storage rejected/);
  assert.equal(app.elements.get('incoming-correction-apply').disabled, true);
  assert.equal(JSON.stringify(app.field.claims), priorLedger);
  assert.equal(JSON.stringify([...app.saved]), priorStorage);
  assert.equal(app.field.claimCounter, 5);
});

test('a completed single-key correction write reloads a complete ledger even before UI mutation', () => {
  const fixture = applicableCorrectionFixture();
  const prior = {aru_fact_claims: JSON.stringify(fixture.before_records), aru_fact_counter: '5'};
  const app = boot(prior);
  assert.equal(boot(Object.fromEntries(app.saved)).field.claims.length, 4, 'before the write, the old copy is intact');
  const writes = [];
  const setItem = app.context.localStorage.setItem.bind(app.context.localStorage);
  app.context.localStorage.setItem = (key, value) => { writes.push(key); setItem(key, value); };
  app.context.nextLedger = fixture.after_records;
  vm.runInContext('persistIncomingCorrection(nextLedger, 6)', app.context);
  assert.deepEqual(writes, ['aru_fact_ledger_v1']);
  assert.equal(app.field.claims.length, 4, 'the simulated page closes before its in-memory update');
  assert.equal(app.saved.has('aru_fact_claims'), false);
  assert.equal(app.saved.has('aru_fact_counter'), false);
  const reopened = boot(Object.fromEntries(app.saved));
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.field.claims)), fixture.after_records);
  assert.equal(reopened.field.claimCounter, 6);
  const snapshot = JSON.parse(app.saved.get('aru_fact_ledger_v1'));
  assert.deepEqual(snapshot, {version: 1, claims: fixture.after_records, next_source_id: 6});
});

test('the new ledger snapshot wins if cleanup of obsolete keys is interrupted', () => {
  const fixture = applicableCorrectionFixture();
  const prior = {aru_fact_claims: JSON.stringify(fixture.before_records), aru_fact_counter: '5'};
  const app = boot(prior);
  app.context.localStorage.removeItem = () => { throw new Error('interrupted cleanup'); };
  app.context.nextLedger = fixture.after_records;
  vm.runInContext('persistIncomingCorrection(nextLedger, 6)', app.context);
  assert.equal(app.saved.has('aru_fact_claims'), true);
  assert.equal(app.saved.has('aru_fact_ledger_v1'), true);
  const reopened = boot(Object.fromEntries(app.saved));
  assert.equal(reopened.field.claims.length, 5);
  assert.equal(reopened.field.claims[4].value, fixture.value);
  assert.equal(reopened.field.claimCounter, 6);
});

test('an incoming correction refuses a saved ledger changed by another tab after preview', async () => {
  const fixture = applicableCorrectionFixture();
  const app = boot({aru_fact_claims: JSON.stringify(fixture.before_records), aru_fact_counter: '5'});
  await chooseReceiptFile(app, JSON.stringify(fixture));
  vm.runInContext('previewIncomingCorrection()', app.context);
  const changed = fixture.before_records.map(record => record.id === 2
    ? {...record, value: 'changed in another tab'} : record);
  app.saved.set('aru_fact_ledger_v1', JSON.stringify({version: 1, claims: changed, next_source_id: 5}));
  vm.runInContext('applyIncomingCorrection()', app.context);
  assert.match(app.elements.get('incoming-correction-preview').textContent, /Saved ledger changed in another tab/);
  assert.equal(app.field.claims.length, 4);
  assert.equal(app.field.claims[1].value, fixture.before_records[1].value);
  assert.equal(boot(Object.fromEntries(app.saved)).field.claims[1].value, 'changed in another tab');
});

test('an older tab cannot overwrite a newer ledger while saving an unrelated message', () => {
  const sharedSaved = new Map();
  const writer = boot({}, {sharedSaved});
  const older = boot({}, {sharedSaved});
  writer.fact('color', 'teal');
  const newerSnapshot = sharedSaved.get('aru_fact_ledger_v1');
  older.input('An unrelated remembrance');
  assert.equal(sharedSaved.get('aru_fact_ledger_v1'), newerSnapshot);
  assert.match(older.elements.get('storage-status').textContent, /Saved evidence changed/);
  older.fact('city', 'Corvallis');
  assert.equal(older.field.claims.length, 0, 'the refused edit does not enter the older in-memory ledger');
  assert.equal(older.elements.get('fact-value').value, 'Corvallis', 'the draft remains for review');
  assert.equal(boot(Object.fromEntries(sharedSaved)).field.claims[0].value, 'teal');
  writer.fact('city', 'Corvallis');
  assert.equal(boot(Object.fromEntries(sharedSaved)).field.claims.length, 2);
});

test('unrelated score saves do not rewrite an unchanged ledger, even if another tab writes after the check', () => {
  const origin = boot();
  origin.fact('color', 'teal');
  const app = boot(Object.fromEntries(origin.saved));
  const prior = JSON.parse(app.saved.get('aru_fact_ledger_v1'));
  const newer = JSON.stringify({...prior, claims: [...prior.claims,
    {id: 2, key: 'city', value: 'Corvallis', time: Date.now(), status: 'active', imported: false}],
    next_source_id: 3});
  const getItem = app.context.localStorage.getItem.bind(app.context.localStorage);
  const setItem = app.context.localStorage.setItem.bind(app.context.localStorage);
  let changedBetweenCheckAndWrite = false;
  let ledgerWrites = 0;
  app.context.localStorage.getItem = key => {
    const value = getItem(key);
    if (key === 'aru_fact_ledger_v1' && !changedBetweenCheckAndWrite) {
      changedBetweenCheckAndWrite = true;
      app.saved.set(key, newer);
    }
    return value;
  };
  app.context.localStorage.setItem = (key, value) => {
    if (key === 'aru_fact_ledger_v1') ledgerWrites++;
    setItem(key, value);
  };
  app.input('A score-only message');
  assert.equal(changedBetweenCheckAndWrite, true);
  assert.equal(ledgerWrites, 0);
  assert.equal(app.saved.get('aru_fact_ledger_v1'), newer);
  assert.match(app.elements.get('storage-status').textContent, /Saved evidence changed/);
});

test('a storage notification warns a stale tab before selection or deletion', () => {
  const sharedSaved = new Map();
  const first = boot({}, {sharedSaved});
  first.fact('color', 'teal');
  const writer = boot({}, {sharedSaved});
  const older = boot({}, {sharedSaved});
  writer.fact('city', 'Corvallis');
  older.notifyStorage('aru_fact_ledger_v1');
  assert.match(older.elements.get('storage-status').textContent, /This tab will not overwrite it/);
  assert.equal(older.elements.get('ledger-sync-alert').hidden, false);
  assert.match(older.elements.get('ledger-sync-alert').textContent, /reload to see the saved ledger/);
  vm.runInContext('deleteFact(1); selectFact(1)', older.context);
  assert.equal(older.field.claims.length, 1);
  assert.equal(older.field.claims[0].status, 'active');
  assert.equal(boot(Object.fromEntries(sharedSaved)).field.claims.length, 2);
});

test('reviewed local corrections and imports refuse a newer saved ledger', async () => {
  const sharedSaved = new Map();
  const seed = boot({}, {sharedSaved});
  seed.fact('color', 'teal');
  const correctionTab = boot({}, {sharedSaved});
  correctionTab.context.document.getElementById('fact-key').value = 'color';
  correctionTab.context.document.getElementById('fact-value').value = 'amber';
  vm.runInContext('previewFactCorrection()', correctionTab.context);
  const writer = boot({}, {sharedSaved});
  writer.fact('city', 'Corvallis');
  const beforeCorrection = sharedSaved.get('aru_fact_ledger_v1');
  vm.runInContext('applyFactCorrection()', correctionTab.context);
  assert.equal(correctionTab.field.claims.length, 1);
  assert.match(correctionTab.elements.get('correction-preview').textContent, /Saved evidence changed/);
  assert.equal(sharedSaved.get('aru_fact_ledger_v1'), beforeCorrection);

  const source = boot();
  source.fact('material', 'oak');
  vm.runInContext('downloadFactLedger()', source.context);
  const fileText = await source.exports[0].text();
  const importTab = boot({}, {sharedSaved});
  importTab.context.document.getElementById('fact-import').files = [
    {size: Buffer.byteLength(fileText), text: async () => fileText}
  ];
  await vm.runInContext('previewFactImport()', importTab.context);
  writer.fact('color', 'violet');
  vm.runInContext('applyFactImport()', importTab.context);
  assert.equal(importTab.field.claims.length, 2);
  assert.match(importTab.elements.get('fact-import-preview').textContent, /Saved evidence changed/);
  assert.equal(boot(Object.fromEntries(sharedSaved)).field.claims.length, 3);
});

test('a migrated legacy ledger blocks an old tab but accepts a same-ledger save', () => {
  const original = boot();
  original.fact('color', 'teal');
  const records = JSON.parse(original.saved.get('aru_fact_ledger_v1')).claims;
  const sharedSaved = new Map([['aru_fact_claims', JSON.stringify(records)], ['aru_fact_counter', '2']]);
  const writer = boot({}, {sharedSaved});
  const older = boot({}, {sharedSaved});
  writer.fact('city', 'Corvallis');
  older.fact('material', 'oak');
  assert.match(older.elements.get('ledger-result').textContent, /Saved evidence changed/);
  assert.equal(older.field.claims.length, 1);
  assert.equal(boot(Object.fromEntries(sharedSaved)).field.claims.length, 2);

  const sameLedgerWriter = boot({}, {sharedSaved});
  const sameLedgerReader = boot({}, {sharedSaved});
  sameLedgerWriter.input('Only the simulation score changed');
  sameLedgerReader.fact('material', 'oak');
  assert.equal(boot(Object.fromEntries(sharedSaved)).field.claims.length, 3);
});

test('a later damaged saved snapshot is preserved when an old tab tries to save', () => {
  const original = boot();
  original.fact('color', 'teal');
  const old = boot(Object.fromEntries(original.saved));
  const damaged = '{"version":1,"claims":"damaged","next_source_id":2}';
  old.saved.set('aru_fact_ledger_v1', damaged);
  old.input('score change');
  assert.equal(old.saved.get('aru_fact_ledger_v1'), damaged);
  old.fact('city', 'Corvallis');
  assert.equal(old.field.claims.length, 1);
  assert.match(old.elements.get('storage-status').textContent, /Saved evidence changed/);
});

test('an applied incoming correction refreshes the guard for the next local edit', async () => {
  const fixture = applicableCorrectionFixture();
  const app = boot({aru_fact_claims: JSON.stringify(fixture.before_records), aru_fact_counter: '5'});
  await chooseReceiptFile(app, JSON.stringify(fixture));
  vm.runInContext('previewIncomingCorrection(); applyIncomingCorrection()', app.context);
  assert.equal(app.field.claims.length, 5);
  app.fact('new name', 'new value');
  assert.equal(app.field.claims.length, 6);
  assert.equal(boot(Object.fromEntries(app.saved)).field.claims.length, 6);
  assert.doesNotMatch(app.elements.get('storage-status').textContent, /Saved evidence changed/);
});

test('full-state restore refuses a saved ledger changed after its preview', async () => {
  const source = boot();
  source.fact('city', 'Salem');
  vm.runInContext('downloadState()', source.context);
  const sharedSaved = new Map();
  const older = boot({}, {sharedSaved});
  const writer = boot({}, {sharedSaved});
  await chooseStateFile(older, await source.exports[0].text());
  writer.fact('city', 'Corvallis');
  const newerSnapshot = sharedSaved.get('aru_fact_ledger_v1');
  vm.runInContext('applyStateImport()', older.context);
  assert.equal(older.window.reloaded, undefined);
  assert.match(older.elements.get('state-import-preview').textContent, /Saved evidence changed/);
  assert.equal(sharedSaved.get('aru_fact_ledger_v1'), newerSnapshot);
});

test('a recovery tab refuses to replace a damaged snapshot that another tab repaired', async () => {
  const raw = '{"version":1,"claims":"damaged","next_source_id":1}';
  const damaged = boot({aru_fact_ledger_v1: raw});
  assert.equal(damaged.elements.get('ledger-sync-alert').hidden, false);
  const backup = boot();
  backup.fact('color', 'teal');
  vm.runInContext('downloadState()', backup.context);
  await chooseStateFile(damaged, await backup.exports[0].text());
  const repaired = backup.saved.get('aru_fact_ledger_v1');
  damaged.saved.set('aru_fact_ledger_v1', repaired);
  vm.runInContext('applyStateImport(); downloadUnreadableLedger()', damaged.context);
  assert.equal(damaged.window.reloaded, undefined);
  assert.equal(damaged.saved.get('aru_fact_ledger_v1'), repaired);
  assert.equal(damaged.exports.length, 0);
  assert.equal(damaged.elements.get('ledger-recovery-download').hidden, true);
  assert.match(damaged.elements.get('storage-status').textContent, /Saved evidence changed/);
});

test('a failed ordinary ledger save reloads the prior complete snapshot', () => {
  const origin = boot();
  origin.fact('city', 'Corvallis');
  const app = boot(Object.fromEntries(origin.saved));
  const original = app.saved.get('aru_fact_ledger_v1');
  const setItem = app.context.localStorage.setItem.bind(app.context.localStorage);
  app.context.localStorage.setItem = (key, value) => {
    if (key === 'aru_fact_ledger_v1') throw new Error('quota');
    setItem(key, value);
  };
  app.fact('color', 'amber');
  assert.equal(app.field.claims.length, 2);
  assert.equal(app.field.storageAvailable, false);
  assert.equal(app.saved.get('aru_fact_ledger_v1'), original);
  const reopened = boot(Object.fromEntries(app.saved));
  assert.equal(reopened.field.claims.length, 1);
  assert.equal(reopened.field.claimCounter, 2);
});

test('a legacy ledger migrates on save, and an unreadable snapshot is preserved for recovery', async () => {
  const fixture = applicableCorrectionFixture();
  const old = {aru_fact_claims: JSON.stringify(fixture.before_records), aru_fact_counter: '5'};
  const migrated = boot(old);
  migrated.fact('another name', 'new value');
  assert.equal(migrated.saved.has('aru_fact_ledger_v1'), true);
  assert.equal(migrated.saved.has('aru_fact_claims'), false);
  assert.equal(migrated.saved.has('aru_fact_counter'), false);
  const staleLegacy = {...Object.fromEntries(migrated.saved), ...old};
  assert.equal(boot(staleLegacy).field.claims.length, 5, 'the snapshot overrides stale legacy keys');
  const raw = '{"version":1,"claims":"not an array","next_source_id":5}';
  const damaged = boot({...old, aru_fact_ledger_v1: raw});
  assert.equal(damaged.field.claims.length, 0, 'stale legacy state cannot silently replace a damaged snapshot');
  assert.match(damaged.elements.get('storage-status').textContent, /Saved ledger snapshot is unreadable/);
  assert.equal(damaged.elements.get('ledger-recovery-download').hidden, false);
  vm.runInContext('downloadUnreadableLedger()', damaged.context);
  assert.equal(JSON.parse(await damaged.exports[0].text()).raw_storage_value, raw);
  damaged.fact('ephemeral', 'not saved');
  assert.equal(damaged.saved.get('aru_fact_ledger_v1'), raw);
  const backup = boot(old);
  vm.runInContext('downloadState()', backup.context);
  await chooseStateFile(damaged, await backup.exports[0].text());
  vm.runInContext('applyStateImport()', damaged.context);
  assert.equal(damaged.window.reloaded, true);
  assert.equal(boot(Object.fromEntries(damaged.saved)).field.claims.length, 4);
});

test('full-state restore rolls back if cleanup fails after writing the new ledger snapshot', async () => {
  const source = boot();
  source.fact('new fact', 'new value');
  vm.runInContext('downloadState()', source.context);
  const old = {aru_fact_claims: JSON.stringify([{id: 1, key: 'old fact', value: 'old value',
    time: 1700000000000, status: 'active', imported: false}]), aru_fact_counter: '2'};
  const target = boot(old);
  await chooseStateFile(target, await source.exports[0].text());
  const before = JSON.stringify([...target.saved]);
  const removeItem = target.context.localStorage.removeItem.bind(target.context.localStorage);
  let fail = true;
  target.context.localStorage.removeItem = key => {
    if (key === 'aru_fact_claims' && fail) { fail = false; throw new Error('interrupted cleanup'); }
    removeItem(key);
  };
  vm.runInContext('applyStateImport()', target.context);
  assert.match(target.elements.get('state-import-preview').textContent, /Restore failed; original local state was kept/);
  assert.equal(JSON.stringify([...target.saved]), before);
  assert.equal(boot(Object.fromEntries(target.saved)).field.claims[0].value, 'old value');
});

async function chooseChainFiles(app, receipts) {
  const input = app.context.document.getElementById('chain-files');
  input.files = receipts.map(receipt => {
    const raw = JSON.stringify(receipt);
    return {size: Buffer.byteLength(raw), text: async () => raw};
  });
  await vm.runInContext('buildCorrectionChain()', app.context);
  return app.elements.get('chain-result').textContent;
}

test('a reversed file selection builds a contiguous two-step chain and applies it atomically', async () => {
  const chain = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-correction-chain.json'), 'utf8'));
  assert.deepEqual(verifyEvidenceReceipt(chain).steps, [5, 6]);
  const prior = {aru_fact_claims: JSON.stringify(chain.receipts[0].before_records), aru_fact_counter: '5'};
  const builder = boot(prior);
  const originalStorage = JSON.stringify([...builder.saved]);
  assert.match(await chooseChainFiles(builder, [...chain.receipts].reverse()), /Verified 2 consecutive corrections.*#5 → #6/);
  assert.equal(JSON.stringify([...builder.saved]), originalStorage);
  assert.equal(builder.elements.get('chain-download').disabled, false);
  vm.runInContext('downloadCorrectionChain()', builder.context);
  const portable = JSON.parse(await builder.exports[0].text());
  assert.deepEqual(portable, chain);
  const target = boot(prior);
  assert.match(await chooseReceiptFile(target, JSON.stringify(portable)), /PASS: 2 consecutive corrections; 6 resulting records/);
  assert.equal(target.elements.get('incoming-correction-apply').disabled, true);
  vm.runInContext('previewIncomingCorrection()', target.context);
  const preview = target.elements.get('incoming-correction-preview');
  assert.match(preview.children[0].textContent, /2 consecutive corrections.*source #5 to #6/);
  assert.match(preview.children[1].textContent, /Step 1.*#1 = teal.*#3 = purple.*#5 = amber/);
  assert.match(preview.children[2].textContent, /Step 2.*#2 = private example.*#6 = shared example/);
  assert.equal(preview.children[1].innerHTML, '');
  assert.equal(JSON.stringify([...target.saved]), originalStorage);
  vm.runInContext('applyIncomingCorrection()', target.context);
  assert.deepEqual(JSON.parse(JSON.stringify(target.field.claims)), chain.receipts[1].after_records);
  assert.equal(target.field.claimCounter, 7);
  assert.equal(target.field.coherence, 0.64);
  assert.equal(target.field.messages.length, 0);
  assert.match(preview.textContent, /Applied 2 reviewed corrections through source #6.*Saved/);
  const reopened = boot(Object.fromEntries(target.saved));
  assert.equal(reopened.field.claims[4].value, 'amber');
  assert.equal(reopened.field.claims[5].value, 'shared example');
  assert.equal(reopened.field.claims[1].status, 'superseded');
});

test('chain replay detects missing, forked, reordered, duplicated, and altered steps', async () => {
  const chain = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-correction-chain.json'), 'utf8'));
  const model = require('../tools/benchmark-evidence.cjs').loadModel();
  const fork = structuredClone(chain);
  fork.receipts[1].before_records[1].value = 'changed between steps';
  fork.receipts[1].after_records = model.correct(fork.receipts[1].name, fork.receipts[1].value,
    fork.receipts[1].before_records, fork.receipts[1].new_source_id, fork.receipts[1].applied_at);
  assert.throws(() => verifyEvidenceReceipt(fork), /missing, forked, duplicated, or reordered/);
  const reordered = {...chain, receipts: [...chain.receipts].reverse()};
  assert.throws(() => verifyEvidenceReceipt(reordered), /missing, forked, duplicated, or reordered/);
  const gap = structuredClone(chain);
  gap.receipts[1].new_source_id = 7;
  gap.receipts[1].after_records = model.correct(gap.receipts[1].name, gap.receipts[1].value,
    gap.receipts[1].before_records, 7, gap.receipts[1].applied_at);
  assert.throws(() => verifyEvidenceReceipt(gap), /missing, forked, duplicated, or reordered/);
  const duplicate = {...chain, receipts: [chain.receipts[0], chain.receipts[0]]};
  assert.throws(() => verifyEvidenceReceipt(duplicate), /missing, forked, duplicated, or reordered/);
  const tampered = structuredClone(chain);
  tampered.receipts[1].after_records[1].status = 'active';
  assert.throws(() => verifyEvidenceReceipt(tampered), /corrected ledger does not match/);
  assert.throws(() => verifyEvidenceReceipt({...chain, receipts: [chain.receipts[0]]}), /step count/);
  assert.throws(() => verifyEvidenceReceipt({...chain, receipts: Array(9).fill(chain.receipts[0])}), /step count/);
  const app = boot();
  assert.match(await chooseReceiptFile(app, JSON.stringify(fork)), /FAIL: Correction chain has a missing/);
  assert.equal(app.elements.get('incoming-correction-preview-button').disabled, true);
  assert.match(await chooseChainFiles(app, [chain.receipts[0], fork.receipts[1]]), /FAIL: Correction chain has a missing/);
  assert.equal(app.elements.get('chain-download').disabled, true);
  assert.equal(app.field.claims.length, 0);
});

test('chain application rejects a changed ledger and a failed snapshot write', async () => {
  const chain = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-correction-chain.json'), 'utf8'));
  const saved = {aru_fact_claims: JSON.stringify(chain.receipts[0].before_records), aru_fact_counter: '5'};
  const diverged = boot(saved);
  await chooseReceiptFile(diverged, JSON.stringify(chain));
  diverged.field.claims[1].value = 'different';
  vm.runInContext('previewIncomingCorrection()', diverged.context);
  assert.match(diverged.elements.get('incoming-correction-preview').textContent, /differs from the receipt/);
  assert.equal(diverged.elements.get('incoming-correction-apply').disabled, true);
  const changed = boot(saved);
  await chooseReceiptFile(changed, JSON.stringify(chain));
  vm.runInContext('previewIncomingCorrection()', changed.context);
  changed.fact('new name', 'extra');
  assert.equal(changed.elements.get('incoming-correction-apply').disabled, true);
  vm.runInContext('applyIncomingCorrection()', changed.context);
  assert.equal(changed.field.claims.length, 5);
  const app = boot(saved);
  await chooseReceiptFile(app, JSON.stringify(chain));
  vm.runInContext('previewIncomingCorrection()', app.context);
  const oldLedger = JSON.stringify(app.field.claims);
  const oldStorage = JSON.stringify([...app.saved]);
  const setItem = app.context.localStorage.setItem.bind(app.context.localStorage);
  let fail = true;
  app.context.localStorage.setItem = (key, value) => {
    if (key === 'aru_fact_ledger_v1' && fail) { fail = false; throw new Error('quota'); }
    setItem(key, value);
  };
  vm.runInContext('applyIncomingCorrection()', app.context);
  assert.match(app.elements.get('incoming-correction-preview').textContent, /Browser storage rejected/);
  assert.equal(JSON.stringify(app.field.claims), oldLedger);
  assert.equal(JSON.stringify([...app.saved]), oldStorage);
});

test('a chain can be applied in session-only mode without persisting any step', async () => {
  const chain = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-correction-chain.json'), 'utf8'));
  const app = boot({aru_fact_claims: JSON.stringify(chain.receipts[0].before_records), aru_fact_counter: '5'});
  const saved = JSON.stringify([...app.saved]);
  vm.runInContext('toggleSessionOnly()', app.context);
  await chooseReceiptFile(app, JSON.stringify(chain));
  vm.runInContext('previewIncomingCorrection(); applyIncomingCorrection()', app.context);
  assert.equal(app.field.claims.length, 6);
  assert.equal(JSON.stringify([...app.saved]), saved);
  assert.match(app.elements.get('incoming-correction-preview').textContent, /Session-only mode/);
  assert.equal(boot(Object.fromEntries(app.saved)).field.claims.length, 4);
});

test('changing chain files cancels an older read and invalidates an earlier review', async () => {
  const chain = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-correction-chain.json'), 'utf8'));
  const app = boot({aru_fact_claims: JSON.stringify(chain.receipts[0].before_records), aru_fact_counter: '5'});
  await chooseChainFiles(app, chain.receipts);
  vm.runInContext('previewIncomingCorrection()', app.context);
  assert.equal(app.elements.get('incoming-correction-apply').disabled, false);
  vm.runInContext('invalidateBuiltChain(); applyIncomingCorrection()', app.context);
  assert.equal(app.elements.get('incoming-correction-apply').disabled, true);
  assert.equal(app.elements.get('chain-download').disabled, true);
  assert.equal(app.field.claims.length, 4);
  const input = app.context.document.getElementById('chain-files');
  let finishFirst;
  input.files = [
    {size: 100, text: () => new Promise(resolve => { finishFirst = resolve; })},
    {size: 100, text: async () => JSON.stringify(chain.receipts[1])}
  ];
  const older = vm.runInContext('buildCorrectionChain()', app.context);
  await chooseReceiptFile(app, JSON.stringify(chain.receipts[0]));
  finishFirst(JSON.stringify(chain.receipts[0]));
  await older;
  assert.match(app.elements.get('receipt-verification').textContent, /PASS: correction source #5/);
  assert.equal(app.elements.get('chain-download').disabled, true);
  assert.equal(vm.runInContext('verifiedIncomingCorrection.format', app.context), 'aru-evidence-correction-receipt');
  input.files = [{size: 1024 * 1024 + 1, text: async () => ''}, {size: 1, text: async () => ''}];
  assert.match(await vm.runInContext('buildCorrectionChain()', app.context).then(() => app.elements.get('chain-result').textContent), /combined correction files exceed/);
  assert.equal(app.elements.get('incoming-correction-preview-button').disabled, true);
});

test('a compact packet omits prior and unrelated values, then replays against a matching browser and CLI baseline', async () => {
  const chain = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-correction-chain.json'), 'utf8'));
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-correction-packet.json'), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-ledger-baseline.json'), 'utf8'));
  const builder = boot({aru_fact_claims: JSON.stringify(baseline.records), aru_fact_counter: '5'});
  await chooseChainFiles(builder, [...chain.receipts].reverse());
  assert.equal(builder.elements.get('packet-download').disabled, false);
  await vm.runInContext('downloadCorrectionPacket()', builder.context);
  const packet = JSON.parse(await builder.exports[0].text());
  assert.deepEqual(packet, fixture, 'browser SHA-256 commitments agree with the independent Node fixture');
  const raw = JSON.stringify(packet);
  for (const privateValue of ['teal', 'purple', 'red', 'private example']) {
    assert.ok(!raw.includes(JSON.stringify(privateValue)), `packet must omit ${privateValue}`);
  }
  assert.ok(Buffer.byteLength(raw) < Buffer.byteLength(JSON.stringify(chain)) / 2);
  assert.deepEqual(verifyEvidenceReceipt(packet, undefined, baseline).steps, [5, 6]);
  assert.throws(() => verifyEvidenceReceipt(packet), /matching baseline JSON/);
  const copy = boot({aru_fact_claims: JSON.stringify(baseline.records), aru_fact_counter: '5'});
  const originalStorage = JSON.stringify([...copy.saved]);
  assert.match(await chooseReceiptFile(copy, raw), /MATCH: 2 compact corrections.*6 resulting records/);
  assert.equal(JSON.stringify([...copy.saved]), originalStorage, 'checking has no storage write');
  assert.equal(copy.elements.get('incoming-correction-apply').disabled, true);
  await vm.runInContext('previewIncomingCorrection()', copy.context);
  const preview = copy.elements.get('incoming-correction-preview');
  assert.match(preview.children[1].textContent, /#1 = teal.*#3 = purple.*#5 = amber/);
  assert.match(preview.children[2].textContent, /#2 = private example.*#6 = shared example/);
  assert.equal(preview.children[1].innerHTML, '');
  assert.equal(JSON.stringify([...copy.saved]), originalStorage, 'review has no storage write');
  await vm.runInContext('applyIncomingCorrection()', copy.context);
  assert.deepEqual(JSON.parse(JSON.stringify(copy.field.claims)), chain.receipts[1].after_records);
  assert.equal(copy.field.claimCounter, 7);
  assert.equal(copy.field.coherence, 0.64);
  assert.match(preview.textContent, /Applied 2 compact corrections.*Saved/);
  assert.equal(boot(Object.fromEntries(copy.saved)).field.claims[5].value, 'shared example');
});

test('compact replay rejects mismatched baselines, altered steps, gaps, and unreviewed application', async () => {
  const packet = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-correction-packet.json'), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-ledger-baseline.json'), 'utf8'));
  const prior = {aru_fact_claims: JSON.stringify(baseline.records), aru_fact_counter: '5'};
  const changedBaseline = structuredClone(baseline);
  changedBaseline.records[1].value = 'locally different';
  assert.throws(() => verifyEvidenceReceipt(packet, undefined, changedBaseline), /starting ledger commitment differs/);
  const diverged = boot({aru_fact_claims: JSON.stringify(changedBaseline.records), aru_fact_counter: '5'});
  assert.match(await chooseReceiptFile(diverged, JSON.stringify(packet)), /FAIL: Starting ledger commitment/);
  assert.equal(diverged.elements.get('incoming-correction-preview-button').disabled, true);
  const wrongCounter = boot({...prior, aru_fact_counter: '6'});
  assert.match(await chooseReceiptFile(wrongCounter, JSON.stringify(packet)), /FAIL: A compact correction source ID differs/);
  const variants = [];
  const revised = structuredClone(packet); revised.steps[1].value = 'invented'; variants.push(revised);
  const missing = structuredClone(packet); missing.steps[1].new_source_id = 7; variants.push(missing);
  const swapped = structuredClone(packet); swapped.steps.reverse(); variants.push(swapped);
  const altered = structuredClone(packet); altered.steps[1].after_sha256 = '0'.repeat(64); variants.push(altered);
  const extra = structuredClone(packet); extra.steps[0].hidden = 'surprise'; variants.push(extra);
  for (const variant of variants) {
    assert.throws(() => verifyEvidenceReceipt(variant, undefined, baseline));
    const app = boot(prior);
    assert.match(await chooseReceiptFile(app, JSON.stringify(variant)), /FAIL:/);
    assert.equal(app.field.claims.length, 4);
    assert.equal(app.elements.get('incoming-correction-preview-button').disabled, true);
  }
  const app = boot(prior);
  await chooseReceiptFile(app, JSON.stringify(packet));
  await vm.runInContext('previewIncomingCorrection()', app.context);
  app.fact('extra name', 'extra');
  assert.equal(app.elements.get('incoming-correction-apply').disabled, true);
  await vm.runInContext('applyIncomingCorrection()', app.context);
  assert.equal(app.field.claims.length, 5);
});

test('compact application rejects a snapshot failure and respects Session-only mode', async () => {
  const packet = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-correction-packet.json'), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-ledger-baseline.json'), 'utf8'));
  const prior = {aru_fact_claims: JSON.stringify(baseline.records), aru_fact_counter: '5'};
  const app = boot(prior);
  await chooseReceiptFile(app, JSON.stringify(packet));
  await vm.runInContext('previewIncomingCorrection()', app.context);
  const saved = JSON.stringify([...app.saved]);
  const setItem = app.context.localStorage.setItem.bind(app.context.localStorage);
  let fail = true;
  app.context.localStorage.setItem = (key, value) => {
    if (key === 'aru_fact_ledger_v1' && fail) { fail = false; throw new Error('quota'); }
    setItem(key, value);
  };
  await vm.runInContext('applyIncomingCorrection()', app.context);
  assert.match(app.elements.get('incoming-correction-preview').textContent, /Browser storage rejected/);
  assert.equal(app.field.claims.length, 4);
  assert.equal(JSON.stringify([...app.saved]), saved);
  const ephemeral = boot(prior);
  vm.runInContext('toggleSessionOnly()', ephemeral.context);
  const original = JSON.stringify([...ephemeral.saved]);
  await chooseReceiptFile(ephemeral, JSON.stringify(packet));
  await vm.runInContext('previewIncomingCorrection()', ephemeral.context);
  await vm.runInContext('applyIncomingCorrection()', ephemeral.context);
  assert.equal(ephemeral.field.claims.length, 6);
  assert.equal(JSON.stringify([...ephemeral.saved]), original);
  assert.match(ephemeral.elements.get('incoming-correction-preview').textContent, /Session-only mode/);
});

test('compact export omits an untouched private source even though commitments cover it', async () => {
  const chain = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-correction-chain.json'), 'utf8'));
  const model = require('../tools/benchmark-evidence.cjs').loadModel();
  chain.receipts[0].before_records.push({id: 5, key: 'vault code', value: 'sequoia 742',
    time: 1700000000004, status: 'active', imported: false});
  chain.receipts[0].new_source_id = 6;
  chain.receipts[0].after_records = model.correct(chain.receipts[0].name, chain.receipts[0].value,
    chain.receipts[0].before_records, 6, chain.receipts[0].applied_at);
  chain.receipts[1].before_records = structuredClone(chain.receipts[0].after_records);
  chain.receipts[1].new_source_id = 7;
  chain.receipts[1].after_records = model.correct(chain.receipts[1].name, chain.receipts[1].value,
    chain.receipts[1].before_records, 7, chain.receipts[1].applied_at);
  const app = boot();
  await chooseChainFiles(app, chain.receipts);
  assert.equal(app.elements.get('packet-download').disabled, false);
  await vm.runInContext('downloadCorrectionPacket()', app.context);
  const packet = JSON.parse(await app.exports[0].text());
  assert.ok(!JSON.stringify(packet).includes('vault code'));
  assert.ok(!JSON.stringify(packet).includes('sequoia 742'));
  const baseline = {format: 'aru-evidence-ledger-baseline', version: 1,
    records: chain.receipts[0].before_records, next_source_id: 6};
  assert.deepEqual(verifyEvidenceReceipt(packet, undefined, baseline).steps, [6, 7]);
  const target = boot({aru_fact_claims: JSON.stringify(baseline.records), aru_fact_counter: '6'});
  assert.match(await chooseReceiptFile(target, JSON.stringify(packet)), /MATCH: 2 compact corrections/);
  await vm.runInContext('previewIncomingCorrection()', target.context);
  await vm.runInContext('applyIncomingCorrection()', target.context);
  assert.equal(target.field.claims[4].value, 'sequoia 742');
  const changed = boot({aru_fact_claims: JSON.stringify(baseline.records.map(record =>
    record.id === 5 ? {...record, value: 'changed private fact'} : record)), aru_fact_counter: '6'});
  assert.match(await chooseReceiptFile(changed, JSON.stringify(packet)), /FAIL: Starting ledger commitment/);
});

test('an in-flight compact verification cannot authorize a ledger that changed during hashing', async () => {
  const packet = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-correction-packet.json'), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-ledger-baseline.json'), 'utf8'));
  let release;
  let calls = 0;
  const crypto = {subtle: {digest: (...args) => {
    if (++calls !== 1) return webcrypto.subtle.digest(...args);
    return new Promise(resolve => { release = () => webcrypto.subtle.digest(...args).then(resolve); });
  }}};
  const app = boot({aru_fact_claims: JSON.stringify(baseline.records), aru_fact_counter: '5'}, {crypto});
  const raw = JSON.stringify(packet);
  const input = app.context.document.getElementById('receipt-file');
  input.files = [{size: Buffer.byteLength(raw), text: async () => raw}];
  const checking = vm.runInContext('verifyEvidenceFile()', app.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  app.fact('extra name', 'extra value');
  release();
  await checking;
  assert.match(app.elements.get('receipt-verification').textContent, /FAIL: The local ledger changed while checking/);
  assert.equal(app.elements.get('incoming-correction-preview-button').disabled, true);
  assert.equal(app.field.claims.length, 5);
});

test('the full chain remains usable when secure browser hashing is unavailable', async () => {
  const chain = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-correction-chain.json'), 'utf8'));
  const app = boot({}, {crypto: {}});
  assert.match(await chooseChainFiles(app, chain.receipts), /Compact packet unavailable: Secure browser hashing is unavailable/);
  assert.equal(app.elements.get('chain-download').disabled, false);
  assert.equal(app.elements.get('packet-download').disabled, true);
  vm.runInContext('downloadCorrectionChain()', app.context);
  assert.deepEqual(JSON.parse(await app.exports[0].text()), chain);
});

test('evidence brief keeps sourced answers beside distinct refusals and exports a replayable snapshot', async () => {
  const app = boot();
  app.fact('favorite color', '<img src=x onerror=alert(1)>');
  app.fact('FAVORITE  COLOR', '<img src=x onerror=alert(1)>');
  app.fact('city', 'Portland');
  app.fact('city', 'Denver');
  app.fact('plan', 'old');
  vm.runInContext('selectFact(3)', app.context);
  vm.runInContext('deleteFact(3)', app.context);
  vm.runInContext('selectFact(5)', app.context);
  app.fact('plan', 'new');
  vm.runInContext('selectFact(6)', app.context);
  vm.runInContext('deleteFact(6)', app.context);
  const input = app.context.document.getElementById('brief-names');
  input.value = 'favorite color\ncity\nplan\npet';
  const before = JSON.stringify([...app.saved]);
  vm.runInContext('runEvidenceBrief()', app.context);
  const rows = app.elements.get('brief-result').children;
  assert.equal(rows.length, 4);
  assert.match(rows[0].textContent, /favorite color: <img src=x onerror=alert\(1\)>.*#1, #2/);
  assert.equal(rows[0].innerHTML, '');
  assert.match(rows[1].textContent, /city:.*historical.*#4/);
  assert.match(rows[2].textContent, /plan:.*historical.*#5/);
  assert.match(rows[3].textContent, /pet:.*missing/);
  assert.equal(JSON.stringify([...app.saved]), before);
  assert.equal(app.field.coherence, 0.64);
  assert.equal(app.field.messages.length, 0);
  vm.runInContext('downloadEvidenceBrief()', app.context);
  const receipt = JSON.parse(await app.exports[0].text());
  assert.deepEqual(receipt.results.map(item => item.answer.kind), ['known', 'historical', 'historical', 'missing']);
  assert.equal(verifyEvidenceReceipt(receipt).known, 1);
  const visitor = boot();
  assert.match(await chooseReceiptFile(visitor, JSON.stringify(receipt)), /PASS: 4 names; 1 sourced answer, 3 refusals/);
  assert.equal(visitor.saved.size, 0);
  assert.equal(visitor.field.claims.length, 0);
});

test('brief receipts detect changed citations, omitted conflicts, repeated names, and stale exports', async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-brief.json'), 'utf8'));
  assert.equal(verifyEvidenceReceipt(fixture).known, 1);
  const app = boot();
  assert.match(await chooseReceiptFile(app, JSON.stringify(fixture)), /PASS: 4 names; 1 sourced answer, 3 refusals; 6 supplied records/);
  const altered = structuredClone(fixture);
  altered.results[0].answer.sources.pop();
  assert.throws(() => verifyEvidenceReceipt(altered), /brief results or citations/);
  assert.match(await chooseReceiptFile(app, JSON.stringify(altered)), /FAIL: The brief results or citations disagree/);
  const hiddenConflict = structuredClone(fixture);
  hiddenConflict.records[3].status = 'superseded';
  assert.throws(() => verifyEvidenceReceipt(hiddenConflict), /brief results or citations/);
  const omitted = structuredClone(fixture);
  omitted.records = omitted.records.filter(record => record.id !== 4);
  omitted.results = require('../tools/benchmark-evidence.cjs').loadModel().brief(omitted.names, omitted.records);
  assert.equal(verifyEvidenceReceipt(omitted).kind, 'brief',
    'a self-consistent receipt cannot establish that no conflicting source was omitted');
  const duplicate = structuredClone(fixture);
  duplicate.names[1] = 'ＦＡＶＯＲＩＴＥ　ＣＯＬＯＲ';
  assert.throws(() => verifyEvidenceReceipt(duplicate), /duplicate brief name/);
  assert.match(await chooseReceiptFile(app, JSON.stringify(duplicate)), /FAIL: Enter each fact name only once/);
  const reordered = structuredClone(fixture);
  reordered.results.reverse();
  assert.throws(() => verifyEvidenceReceipt(reordered), /brief results or citations/);
  const extra = structuredClone(fixture);
  extra.results[0].explanation = 'invented';
  assert.throws(() => verifyEvidenceReceipt(extra), /brief results or citations/);

  const input = app.context.document.getElementById('brief-names');
  input.value = 'one\nONE';
  vm.runInContext('runEvidenceBrief()', app.context);
  assert.match(app.elements.get('brief-result').textContent, /only once/);
  assert.equal(app.elements.get('brief-download').disabled, true);
  input.value = 'one\ntwo';
  vm.runInContext('runEvidenceBrief()', app.context);
  assert.equal(app.elements.get('brief-download').disabled, false);
  input.value = 'one\nthree';
  vm.runInContext('downloadEvidenceBrief()', app.context);
  assert.equal(app.exports.length, 0);
  assert.equal(app.elements.get('brief-download').disabled, true);
  input.value = 'one\ntwo';
  vm.runInContext('runEvidenceBrief()', app.context);
  app.fact('one', 'new');
  assert.equal(app.elements.get('brief-download').disabled, true);
  vm.runInContext('downloadEvidenceBrief()', app.context);
  assert.equal(app.exports.length, 0);
});

test('constrained questions return recorded values with sources without scoring the question', () => {
  const app = boot();
  app.fact(' Favorite   Color ', 'teal');
  const savedBefore = JSON.stringify([...app.saved]);
  const question = app.context.document.getElementById('fact-question');
  question.value = 'What’s my FAVORITE  COLOR?';
  vm.runInContext('askEvidence()', app.context);
  assert.match(app.elements.get('fact-answer').textContent, /favorite color.*teal.*Source #1.*user assertion/i);
  assert.equal(app.field.coherence, 0.64);
  assert.equal(app.field.memory.length, 0);
  assert.equal(app.field.messages.length, 0);
  assert.equal(JSON.stringify([...app.saved]), savedBefore);
  assert.equal(app.field.lastTransition, null);
  question.value = 'What is my favorite color and my age?';
  vm.runInContext('askEvidence()', app.context);
  assert.match(app.elements.get('fact-answer').textContent, /No exact recorded name.*No answer given/);
});

test('main composer asks a recorded fact with a source and opens a verifiable receipt without scoring', async () => {
  const app = boot();
  app.fact('favorite color', 'teal');
  app.fact('unrelated private assertion', 'hidden');
  const before = JSON.stringify([...app.saved]);
  const input = app.context.document.getElementById('input');
  input.value = 'What is my favorite color?';
  vm.runInContext('askComposerEvidence()', app.context);
  assert.match(app.elements.get('quick-evidence-result').textContent, /teal.*Source #1.*user assertion/);
  assert.equal(app.elements.get('quick-evidence-review').disabled, false);
  assert.equal(app.field.coherence, 0.64);
  assert.equal(app.field.memory.length, 0);
  assert.equal(app.field.messages.length, 0);
  assert.equal(JSON.stringify([...app.saved]), before);
  vm.runInContext('reviewComposerEvidence()', app.context);
  assert.equal(app.elements.get('ledger').open, true);
  assert.equal(app.elements.get('fact-question').value, input.value);
  assert.equal(app.elements.get('fact-answer').textContent, app.elements.get('quick-evidence-result').textContent);
  assert.equal(app.elements.get('evidence-excerpt-download').disabled, false);
  vm.runInContext('downloadEvidenceExcerpt()', app.context);
  const receipt = JSON.parse(await app.exports[0].text());
  assert.equal(verifyEvidenceReceipt(receipt).scope, 'cited-assertions-only');
  assert.equal(JSON.stringify(receipt).includes('hidden'), false);
  assert.equal(JSON.stringify([...app.saved]), before);
});

test('composer records a reviewed assertion without scoring and can immediately recall its source', () => {
  const app = boot();
  const prompts = [];
  app.window.confirm = prompt => { prompts.push(prompt); return true; };
  const input = app.context.document.getElementById('input');
  app.context.document.getElementById('fact-key').value = 'unfinished ledger draft';
  app.context.document.getElementById('fact-value').value = 'keep me';
  input.value = '  Favorite   Color: teal  ';
  vm.runInContext('recordComposerFact()', app.context);
  assert.match(html, /onclick="recordComposerFact\(\)"/);
  assert.match(prompts[0], /Favorite Color: teal.*source #1/);
  assert.equal(input.value, '');
  assert.equal(app.elements.get('fact-key').value, 'unfinished ledger draft');
  assert.equal(app.elements.get('fact-value').value, 'keep me');
  assert.equal(app.field.claims[0].key, 'Favorite Color');
  assert.equal(app.field.claims[0].value, 'teal');
  assert.match(app.elements.get('quick-evidence-result').textContent, /Recorded source #1.*teal.*user assertion/);
  assert.equal(app.field.coherence, 0.64);
  assert.equal(app.field.memory.length, 0);
  assert.equal(app.field.messages.length, 0);
  assert.equal(app.field.lastTransition, null);
  const reopened = boot(Object.fromEntries(app.saved));
  reopened.context.document.getElementById('input').value = 'What is my favorite color?';
  vm.runInContext('askComposerEvidence()', reopened.context);
  assert.match(reopened.elements.get('quick-evidence-result').textContent, /teal.*Source #1.*user assertion/);
});

test('composer leaves draft and ledger unchanged on invalid input, cancellation, capacity, and busy state', () => {
  const app = boot();
  const input = app.context.document.getElementById('input');
  let prompts = 0;
  app.window.confirm = () => { prompts++; return false; };
  input.value = 'no separator';
  vm.runInContext('recordComposerFact()', app.context);
  assert.match(app.elements.get('quick-evidence-result').textContent, /No fact was recorded/);
  input.value = 'favorite color: teal';
  const before = JSON.stringify([...app.saved]);
  vm.runInContext('recordComposerFact()', app.context);
  assert.equal(prompts, 1);
  assert.equal(input.value, 'favorite color: teal');
  assert.equal(app.field.claims.length, 0);
  assert.equal(JSON.stringify([...app.saved]), before);
  app.field.busy = true;
  vm.runInContext('recordComposerFact()', app.context);
  assert.match(app.elements.get('quick-evidence-result').textContent, /Wait for the simulation/);
  assert.equal(prompts, 1);
  app.field.busy = false;
  app.field.claims = Array.from({length: 100}, (_, index) => ({
    id: index + 1, key: `key ${index}`, value: 'value', status: 'active'
  }));
  vm.runInContext('recordComposerFact()', app.context);
  assert.match(app.elements.get('quick-evidence-result').textContent, /100-record limit/);
  assert.equal(prompts, 1);
  assert.equal(input.value, 'favorite color: teal');
  assert.equal(app.field.claims.length, 100);
  assert.equal(JSON.stringify([...app.saved]), before);
});

test('composer warns when a second assertion conflicts and recall abstains until source selection', () => {
  const app = boot();
  app.fact('favorite color', 'teal');
  const input = app.context.document.getElementById('input');
  let prompt = '';
  app.window.confirm = message => { prompt = message; return true; };
  input.value = 'FAVORITE COLOR: amber';
  vm.runInContext('recordComposerFact()', app.context);
  assert.match(prompt, /source #2.*conflicting current values.*withhold an answer/);
  assert.match(app.elements.get('quick-evidence-result').textContent, /Conflicting current records.*No answer given/);
  input.value = 'What is my favorite color?';
  vm.runInContext('askComposerEvidence()', app.context);
  assert.match(app.elements.get('quick-evidence-result').textContent, /Conflicting current records.*No answer given/);
  vm.runInContext('selectFact(2)', app.context);
  vm.runInContext('askComposerEvidence()', app.context);
  assert.match(app.elements.get('quick-evidence-result').textContent, /amber.*Source #2/);
  assert.equal(app.field.coherence, 0.64);
  assert.equal(app.field.messages.length, 0);
});

test('composer recording follows session-only mode without writing browser storage', () => {
  const origin = boot();
  origin.fact('saved fact', 'blue');
  const app = boot(Object.fromEntries(origin.saved));
  const before = JSON.stringify([...app.saved]);
  vm.runInContext('toggleSessionOnly()', app.context);
  const input = app.context.document.getElementById('input');
  input.value = 'session fact: amber';
  vm.runInContext('recordComposerFact()', app.context);
  assert.match(app.elements.get('quick-evidence-result').textContent, /Session-only mode/);
  assert.equal(app.field.claims[1].value, 'amber');
  assert.equal(JSON.stringify([...app.saved]), before);
  input.value = 'What is my session fact?';
  vm.runInContext('askComposerEvidence()', app.context);
  assert.match(app.elements.get('quick-evidence-result').textContent, /amber.*Source #2/);
  assert.equal(boot(Object.fromEntries(app.saved)).field.claims.length, 1);
});

test('composer refuses unsupported, missing, conflicting, and ambiguous questions as text', () => {
  const app = boot();
  app.fact('favorite color', '<img src=x onerror=alert(1)>');
  const input = app.context.document.getElementById('input');
  input.value = 'Who knows my favorite color?';
  vm.runInContext('askComposerEvidence()', app.context);
  assert.match(app.elements.get('quick-evidence-result').textContent, /No answer given/);
  input.value = 'What is my missing fact?';
  vm.runInContext('askComposerEvidence()', app.context);
  assert.match(app.elements.get('quick-evidence-result').textContent, /No exact recorded name/);
  input.value = 'What is my favorite color?';
  vm.runInContext('askComposerEvidence()', app.context);
  assert.match(app.elements.get('quick-evidence-result').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(app.elements.get('quick-evidence-result').innerHTML, '');
  app.fact('favorite color', 'amber');
  vm.runInContext('askComposerEvidence()', app.context);
  assert.match(app.elements.get('quick-evidence-result').textContent, /Conflicting current records.*No answer given/);
  app.fact('my favorite color', 'green');
  vm.runInContext('askComposerEvidence()', app.context);
  assert.match(app.elements.get('quick-evidence-result').textContent, /multiple recorded names.*No answer given/);
  assert.equal(app.field.coherence, 0.64);
  assert.equal(app.field.memory.length, 0);
  assert.equal(app.field.messages.length, 0);
});

test('composer answer invalidates on question and ledger changes, and sending uses simulation only', () => {
  const app = boot();
  app.fact('favorite color', 'teal');
  const input = app.context.document.getElementById('input');
  input.value = 'What is my favorite color?';
  vm.runInContext('askComposerEvidence()', app.context);
  input.value = 'What is my other fact?';
  vm.runInContext('reviewComposerEvidence()', app.context);
  assert.equal(app.elements.get('quick-evidence-review').disabled, true);
  assert.match(app.elements.get('quick-evidence-result').textContent, /Question or ledger changed/);
  input.value = 'What is my favorite color?';
  vm.runInContext('askComposerEvidence()', app.context);
  app.fact('favorite color', 'amber');
  assert.equal(app.elements.get('quick-evidence-review').disabled, true);
  assert.equal(app.elements.get('quick-evidence-result').textContent, '');
  vm.runInContext('askComposerEvidence()', app.context);
  app.input('What is my favorite color?');
  assert.equal(app.elements.get('quick-evidence-result').textContent, '');
  assert.equal(app.elements.get('quick-evidence-review').disabled, true);
  assert.equal(app.field.messages[0].type, 'user');
  assert.notEqual(app.field.coherence, 0.64);
});

test('a question receipt replays a sourced answer using the full ledger without saving another copy', async () => {
  const app = boot();
  app.fact('favorite color', 'teal');
  app.fact('unrelated private assertion', 'hidden');
  const before = JSON.stringify([...app.saved]);
  const question = app.context.document.getElementById('fact-question');
  question.value = 'What is my favorite color?';
  vm.runInContext('askEvidence()', app.context);
  assert.equal(app.elements.get('evidence-receipt-download').disabled, false);
  vm.runInContext('downloadEvidenceReceipt()', app.context);
  const receipt = JSON.parse(await app.exports[0].text());
  assert.equal(receipt.records.length, 2, 'the receipt must disclose the full snapshot');
  assert.equal(receipt.records[1].value, 'hidden');
  assert.deepEqual(receipt.answer, {kind: 'known', value: 'teal', sources: [1]});
  assert.equal(verifyEvidenceReceipt(receipt).kind, 'known');
  assert.equal(JSON.stringify([...app.saved]), before);

  const changedValue = structuredClone(receipt);
  changedValue.records[0].value = 'amber';
  assert.throws(() => verifyEvidenceReceipt(changedValue), /recorded answer does not match/);
  const hiddenConflict = structuredClone(receipt);
  hiddenConflict.records.push({...hiddenConflict.records[0], id: 3, value: 'amber'});
  assert.throws(() => verifyEvidenceReceipt(hiddenConflict), /recorded answer does not match/);
  question.value = 'What is unrelated private assertion?';
  vm.runInContext('downloadEvidenceReceipt()', app.context);
  assert.equal(app.exports.length, 1, 'a changed question cannot export the old answer');
  assert.equal(app.elements.get('evidence-receipt-download').disabled, true);
});

test('answer excerpt includes every cited assertion and excludes unrelated private facts', async () => {
  const app = boot();
  app.fact('favorite color', 'teal');
  app.fact('FAVORITE COLOR', 'teal');
  app.fact('unrelated private assertion', 'hidden secret');
  const before = JSON.stringify([...app.saved]);
  const question = app.context.document.getElementById('fact-question');
  question.value = 'What is my favorite color?';
  vm.runInContext('askEvidence()', app.context);
  assert.equal(app.elements.get('evidence-excerpt-download').disabled, false);
  vm.runInContext('downloadEvidenceExcerpt()', app.context);
  const excerptText = await app.exports[0].text();
  const excerpt = JSON.parse(excerptText);
  assert.equal(excerpt.format, 'aru-evidence-answer-excerpt');
  assert.equal(excerpt.scope, 'cited-assertions-only');
  assert.deepEqual(excerpt.records.map(record => record.id), [1, 2]);
  assert.deepEqual(excerpt.answer.sources, [1, 2]);
  assert.doesNotMatch(excerptText, /hidden secret|unrelated private assertion/);
  assert.equal(verifyEvidenceReceipt(excerpt).scope, 'cited-assertions-only');
  assert.equal(JSON.stringify([...app.saved]), before);

  const omittedSource = structuredClone(excerpt);
  omittedSource.records.pop();
  assert.throws(() => verifyEvidenceReceipt(omittedSource), /recorded answer does not match/);
  const unrelatedRecord = structuredClone(excerpt);
  unrelatedRecord.records.push({id: 3, key: 'private', value: 'hidden', time: Date.now(), status: 'active'});
  assert.throws(() => verifyEvidenceReceipt(unrelatedRecord), /exactly its cited active assertions/);
  const supersededRecord = structuredClone(excerpt);
  supersededRecord.records.push({...supersededRecord.records[0], id: 4, status: 'superseded'});
  assert.throws(() => verifyEvidenceReceipt(supersededRecord), /exactly its cited active assertions/);

  vm.runInContext('downloadEvidenceReceipt()', app.context);
  const full = JSON.parse(await app.exports[1].text());
  assert.equal(full.records.length, 3);
  assert.equal(verifyEvidenceReceipt(full).scope, 'full-supplied-snapshot');
  const withheldConflict = structuredClone(full);
  withheldConflict.records.push({id: 4, key: 'favorite color', value: 'amber',
    time: Date.now(), status: 'active'});
  assert.equal(verifyEvidenceReceipt(excerpt).kind, 'known',
    'a valid excerpt cannot establish that no conflicting assertion was omitted');
  const model = require('../tools/benchmark-evidence.cjs').loadModel();
  assert.equal(model.resolve(question.value, withheldConflict.records).kind, 'conflict');
  question.value = 'What is another fact?';
  vm.runInContext('downloadEvidenceExcerpt()', app.context);
  assert.equal(app.exports.length, 2);
  assert.equal(app.elements.get('evidence-excerpt-download').disabled, true);
});

test('ledger edits invalidate receipts; conflict receipts replay abstention', async () => {
  const app = boot();
  const question = app.context.document.getElementById('fact-question');
  app.fact('favorite color', 'teal');
  question.value = 'What is favorite color?';
  vm.runInContext('askEvidence()', app.context);
  app.fact('favorite color', 'amber');
  assert.equal(app.elements.get('evidence-receipt-download').disabled, true);
  assert.equal(app.elements.get('evidence-excerpt-download').disabled, true);
  vm.runInContext('downloadEvidenceReceipt()', app.context);
  assert.equal(app.exports.length, 0);
  vm.runInContext('askEvidence()', app.context);
  assert.equal(app.elements.get('evidence-excerpt-download').disabled, true, 'a refusal has no cited-answer excerpt');
  vm.runInContext('downloadEvidenceReceipt()', app.context);
  const receipt = JSON.parse(await app.exports[0].text());
  assert.deepEqual(receipt.answer, {kind: 'conflict', sources: [1, 2]});
  assert.equal(verifyEvidenceReceipt(receipt).kind, 'conflict');
  vm.runInContext('selectFact(1)', app.context);
  assert.equal(app.elements.get('evidence-receipt-download').disabled, true);
  vm.runInContext('invalidateEvidenceQuestion()', app.context);
  assert.match(app.elements.get('fact-answer').textContent, /Question changed/);
});

test('receipt verifier rejects duplicate records and altered source citations', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-receipt.json'), 'utf8'));
  assert.equal(verifyEvidenceReceipt(fixture).sources[0], 1);
  const citation = structuredClone(fixture);
  citation.answer.sources = [2];
  assert.throws(() => verifyEvidenceReceipt(citation), /recorded answer does not match/);
  const duplicate = structuredClone(fixture);
  duplicate.records.push({...duplicate.records[0]});
  assert.throws(() => verifyEvidenceReceipt(duplicate), /invalid or duplicate record/);
  const excerpt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-excerpt.json'), 'utf8'));
  assert.equal(verifyEvidenceReceipt(excerpt).scope, 'cited-assertions-only');
  excerpt.scope = 'full-ledger';
  assert.throws(() => verifyEvidenceReceipt(excerpt), /unsupported excerpt scope/);
});

async function chooseReceiptFile(app, text, size = Buffer.byteLength(text)) {
  const input = app.context.document.getElementById('receipt-file');
  input.files = [{size, text: async () => text}];
  await vm.runInContext('verifyEvidenceFile()', app.context);
  return app.elements.get('receipt-verification').textContent;
}

async function compareSavedReferenceFiles(app, reference, checkpoint = null) {
  const referenceInput = app.context.document.getElementById('reference-file');
  const checkpointInput = app.context.document.getElementById('checkpoint-file');
  referenceInput.files = [{size: Buffer.byteLength(reference), text: async () => reference}];
  checkpointInput.files = checkpoint === null ? [] :
    [{size: Buffer.byteLength(checkpoint), text: async () => checkpoint}];
  vm.runInContext('invalidateReferenceComparison()', app.context);
  await vm.runInContext('compareVerifiedEvidenceToReference()', app.context);
  return app.elements.get('reference-receipt-comparison').textContent;
}

function auditFile(text, name = 'receipt.json', size = Buffer.byteLength(text)) {
  return {name, size, text: async () => text,
    arrayBuffer: async () => {
      const bytes = Buffer.from(text);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }};
}

async function auditSavedReceipts(app, reference, receipts, checkpoint = null) {
  const document = app.context.document;
  document.getElementById('reference-file').files = [auditFile(reference, 'reference.json')];
  document.getElementById('checkpoint-file').files = checkpoint === null ? [] :
    [auditFile(checkpoint, 'checkpoint.json')];
  document.getElementById('audit-receipts').files = receipts;
  vm.runInContext('invalidateReferenceComparison()', app.context);
  await vm.runInContext('runEvidenceBatchAudit()', app.context);
  return app.elements.get('audit-result');
}

async function traceSavedReferences(app, a, b, receipts, checkpointA = null, checkpointB = null) {
  const document = app.context.document;
  document.getElementById('transition-reference-a').files = [auditFile(a, 'a.json')];
  document.getElementById('transition-checkpoint-a').files = checkpointA === null ? [] :
    [auditFile(checkpointA, 'checkpoint-a.json')];
  document.getElementById('reference-file').files = [auditFile(b, 'b.json')];
  document.getElementById('checkpoint-file').files = checkpointB === null ? [] :
    [auditFile(checkpointB, 'checkpoint-b.json')];
  document.getElementById('audit-receipts').files = receipts;
  vm.runInContext('invalidateReferenceComparison()', app.context);
  await vm.runInContext('traceReferenceTransition()', app.context);
  return app.elements.get('reference-transition-result');
}

test('two-reference lens traces an omitted conflict, full-snapshot change, and unreadable receipt privately', async () => {
  const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'research', name), 'utf8');
  const a = fixture('example-evidence-reference-baseline.json');
  const checkpoint = fixture('example-evidence-ledger-checkpoint.json');
  const excerpt = fixture('example-evidence-excerpt.json');
  const full = fixture('example-evidence-receipt.json');
  const b = JSON.parse(a);
  b.records.push({...b.records[0], id: 2, value: 'secret <img onerror=alert(1)>', time: 1700000000001});
  b.next_source_id = 3;
  const app = boot();
  app.fact('private note', 'never reveal');
  const saved = JSON.stringify([...app.saved]);
  const output = await traceSavedReferences(app, a, JSON.stringify(b),
    [auditFile(excerpt), auditFile(full), auditFile('{')], checkpoint);
  assert.match(output.children[0].textContent, /3 receipts traced: 2 verdict changes, 0 unchanged, 1 could not replay.*A checkpoint matches; B checkpoint not supplied/);
  assert.match(output.children[2].children.map(item => item.textContent).join(' '), /Source #2 was added to B.*next source ID changed/);
  const cards = output.children[3].children;
  assert.deepEqual(cards.map(card => card.children[1].textContent),
    ['A: MATCH → B: DIFFER', 'A: MATCH → B: DIFFER', 'A: FAIL → B: FAIL']);
  assert.match(cards[0].children[2].textContent, /kind: known → conflict.*source IDs: #1 → #1, #2/);
  assert.match(cards[1].children[2].textContent, /full receipt requires an exact ordered snapshot/);
  assert.match(cards[2].children[2].textContent, /not valid JSON.*No reference verdict/);
  assert.match(cards[0].children[3].textContent, /Minimum added-source set.*#2.*1 subset tested.*not proof of chronology/);
  assert.match(cards[0].children[4].textContent,
    /Verdict witness: smallest added-source set.*#2.*excerpt checks its answer and cited records.*does not establish custody/);
  assert.match(cards[1].children[4].textContent,
    /Verdict witness: smallest added-source set.*#2.*full receipt checks an exact ordered snapshot/);
  assert.equal(cards[2].children.length, 3, 'a failed replay has no answer-change claim');
  assert.equal(JSON.stringify([...app.saved]), saved);
  const allText = element => [element.textContent, ...(element.children || []).flatMap(allText)];
  assert.doesNotMatch(allText(output).join(' '),
    /secret|never reveal|favorite color|<img|[0-9a-f]{64}/);
});

test('addition witness finds a minimum pair and tied alternatives but declines edits and reorders', () => {
  const app = boot();
  const examine = (question, before, after) => {
    app.context.sample = {format: 'aru-evidence-question-receipt', question};
    app.context.before = {records: before};
    app.context.after = {records: after};
    return JSON.parse(JSON.stringify(vm.runInContext(
      'referenceAddedSourceWitness(sample, before, after)', app.context)));
  };
  const record = (id, key, value) => ({id, key, value, time: 1700000000000 + id,
    status: 'active', imported: false});
  const color = record(1, 'color', 'teal');
  const amber = record(2, 'color', 'amber');
  const green = record(3, 'color', 'green');
  assert.deepEqual(examine('What is color?', [], [color, amber]),
    {status: 'witness', minimum_size: 2, sets: [[1, 2]], total_sets: 1, tested_subsets: 3});
  assert.deepEqual(examine('What is my color?', [record(1, 'my color', 'teal')],
    [record(1, 'my color', 'teal'), amber, green]),
    {status: 'witness', minimum_size: 1, sets: [[2], [3]], total_sets: 2, tested_subsets: 2});
  const manyTies = examine('What is my color?', [record(1, 'my color', 'teal')],
    [record(1, 'my color', 'teal'), ...[2, 3, 4, 5].map(id => record(id, 'color', `private ${id}`))]);
  assert.deepEqual(manyTies.sets, [[2], [3], [4]]);
  assert.equal(manyTies.total_sets, 4);
  app.context.manyTies = manyTies;
  assert.match(vm.runInContext('referenceWitnessText(manyTies)', app.context), /#2; #3; #4; 1 more/);
  assert.deepEqual(examine('What is color?', [color], [color, record(2, 'city', 'Portland')]),
    {status: 'unchanged'});
  assert.deepEqual(examine('What is color?', [color], [{...color, value: 'amber'}]),
    {status: 'unavailable', reason: 'not-addition-only'});
  assert.deepEqual(examine('What is color?', [color], []),
    {status: 'unavailable', reason: 'not-addition-only'});
  assert.deepEqual(examine('What is color?', [color, amber], [amber, color]),
    {status: 'unavailable', reason: 'not-addition-only'});
  assert.deepEqual(examine('What is color?', [], Array.from({length: 7}, (_, index) =>
    record(index + 1, 'color', 'teal'))),
    {status: 'unavailable', reason: 'too-many-additions'});
});

test('browser verdict witness distinguishes unchanged answer, ties, completion, and unavailable edits', () => {
  const app = boot();
  const record = (id, key, value) => ({id, key, value, time: 1700000000000 + id,
    status: 'active', imported: false});
  const color = record(1, 'color', 'private teal');
  const city = record(2, 'city', 'private Portland');
  const amber = record(2, 'color', 'private amber');
  const green = record(3, 'color', 'private green');
  const examine = (receipt, before, after) => {
    app.context.sample = receipt;
    app.context.before = {records: before};
    app.context.after = {records: after};
    return JSON.parse(JSON.stringify(vm.runInContext(
      'referenceVerdictAddedSourceWitness(sample, before, after)', app.context)));
  };
  const full = {format: 'aru-evidence-question-receipt', question: 'What is color?',
    records: [color]};
  assert.deepEqual(examine(full, [color], [color, city]),
    {status: 'witness', minimum_size: 1, sets: [[2]], total_sets: 1, tested_subsets: 1});
  assert.deepEqual(examine({...full, records: [color, city]}, [color], [color, city]),
    {status: 'witness', minimum_size: 1, sets: [[2]], total_sets: 1, tested_subsets: 1});
  const excerpt = {...full, format: 'aru-evidence-answer-excerpt',
    answer: {kind: 'known', value: 'private teal', sources: [1]}};
  assert.deepEqual(examine(excerpt, [color], [color, amber, green]),
    {status: 'witness', minimum_size: 1, sets: [[2], [3]], total_sets: 2, tested_subsets: 2});
  assert.deepEqual(examine(excerpt, [color], [color, city]), {status: 'unchanged'});
  assert.deepEqual(examine(full, [color], [{...color, value: 'private amber'}]),
    {status: 'unavailable', reason: 'not-addition-only'});
  assert.deepEqual(examine(full, [color], [color, ...Array.from({length: 7}, (_, i) =>
    record(i + 2, 'city', `private ${i}`))]),
    {status: 'unavailable', reason: 'too-many-additions'});
});

test('browser transitions agree with Node and independent Python on the same synthetic references', async () => {
  const fixture = name => path.join(__dirname, '..', 'research', name);
  const read = name => fs.readFileSync(fixture(name), 'utf8');
  const aName = 'example-evidence-reference-baseline.json';
  const bName = 'example-evidence-reference-conflict.json';
  const receipts = ['example-evidence-excerpt.json', 'example-evidence-receipt.json'];
  const checkpointName = 'example-evidence-ledger-checkpoint.json';
  const output = await traceSavedReferences(boot(), read(aName), read(bName),
    receipts.map(name => auditFile(read(name))), read(checkpointName));
  assert.deepEqual(output.children[3].children.map(card => card.children[1].textContent),
    ['A: MATCH → B: DIFFER', 'A: MATCH → B: DIFFER']);
  for (const [runtime, executable] of [
    ['node', process.execPath], ['python', 'python3']]) {
    const script = path.join(__dirname, '..', 'tools', runtime === 'node' ?
      'audit-evidence-batch.cjs' : 'independent-evidence-batch.py');
    const selected = receipts.map(fixture);
    const before = spawnSync(executable, [script, fixture(aName), ...selected,
      '--checkpoint', fixture(checkpointName)], {encoding: 'utf8'});
    const after = spawnSync(executable, [script, fixture(bName), ...selected], {encoding: 'utf8'});
    assert.equal(before.status, 0, `${runtime}: ${before.stderr}`);
    assert.match(before.stdout, /2 MATCH, 0 DIFFER, 0 FAIL/);
    assert.equal(after.status, 1, `${runtime}: ${after.stderr}`);
    assert.match(after.stdout, /0 MATCH, 2 DIFFER, 0 FAIL/);
  }
});

test('lens can show DIFFER to MATCH and leave an excerpt MATCH when only an unrelated source changes', async () => {
  const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'research', name), 'utf8');
  const a = fixture('example-evidence-reference-baseline.json');
  const excerpt = fixture('example-evidence-excerpt.json');
  const full = fixture('example-evidence-receipt.json');
  const changed = JSON.parse(a);
  changed.records[0].value = 'amber';
  const newExcerpt = JSON.parse(excerpt);
  newExcerpt.records[0].value = 'amber';
  newExcerpt.answer.value = 'amber';
  const app = boot();
  let output = await traceSavedReferences(app, a, JSON.stringify(changed), [auditFile(JSON.stringify(newExcerpt))]);
  assert.match(output.children[0].textContent, /1 verdict change/);
  assert.match(output.children[2].children[0].textContent, /Source #1 changed value/);
  assert.equal(output.children[3].children[0].children[1].textContent, 'A: DIFFER → B: MATCH');
  assert.match(output.children[3].children[0].children[2].textContent, /value changed \(values hidden\)/);

  const unrelated = JSON.parse(a);
  unrelated.records.push({id: 2, key: 'private', value: 'hidden', time: 1700000000001,
    status: 'active', imported: false});
  unrelated.next_source_id = 3;
  output = await traceSavedReferences(app, a, JSON.stringify(unrelated),
    [auditFile(excerpt), auditFile(full)]);
  assert.match(output.children[0].textContent, /1 verdict change, 1 unchanged/);
  assert.equal(output.children[3].children[0].children[1].textContent, 'A: MATCH → B: MATCH');
  assert.equal(output.children[3].children[1].children[1].textContent, 'A: MATCH → B: DIFFER');
  assert.match(output.children[3].children[0].children[2].textContent, /computed answer and cited sources agree/);
  assert.match(output.children[3].children[0].children[4].textContent, /Verdict unchanged under A and B/);
  assert.match(output.children[3].children[1].children[3].textContent, /Computed answer unchanged/);
  assert.match(output.children[3].children[1].children[4].textContent,
    /Verdict witness.*#2.*full receipt checks an exact ordered snapshot.*computed answer is unchanged/);

  const nextOnly = {...JSON.parse(a), next_source_id: 8};
  output = await traceSavedReferences(app, a, JSON.stringify(nextOnly), [auditFile(full)]);
  assert.match(output.children[2].children[0].textContent, /next source ID changed/);
  assert.equal(output.children[3].children[0].children[1].textContent, 'A: MATCH → B: MATCH');
  assert.doesNotMatch(output.children[3].children[0].children[2].textContent, /snapshot.*changed/);
});

test('a mismatched checkpoint stops the lens before reading receipts', async () => {
  const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'research', name), 'utf8');
  const a = fixture('example-evidence-reference-baseline.json');
  const checkpoint = JSON.parse(fixture('example-evidence-ledger-checkpoint.json'));
  const unread = {name: 'unread.json', size: 1, arrayBuffer: async () => {
    throw new Error('Receipt should not be opened');
  }};
  const app = boot();
  const output = await traceSavedReferences(app, a, a, [unread],
    JSON.stringify({...checkpoint, sha256: '0'.repeat(64)}));
  assert.match(output.textContent, /DIFFER: Reference A differs from its selected checkpoint.*No receipts were traced/);
  assert.equal(output.children.length, 0);
  await traceSavedReferences(app, a, '{', [unread]);
  assert.match(output.textContent, /FAIL: Reference B is not valid JSON/);
  assert.equal(output.children.length, 0);
  await traceSavedReferences(app, a, a, [unread], null,
    JSON.stringify({...checkpoint, sha256: '0'.repeat(64)}));
  assert.match(output.textContent, /DIFFER: Reference B differs from its selected checkpoint.*No receipts were traced/);
  assert.equal(output.children.length, 0);
  await traceSavedReferences(app, a, a, Array(5).fill({name: 'large.json', size: 900000,
    arrayBuffer: async () => { throw new Error('Receipt should not be opened'); }}));
  assert.match(output.textContent, /FAIL: Selected receipts exceed the 4 MiB combined limit/);
  assert.equal(output.children.length, 0);
});

test('a slower reference read cannot restore stale trace results after a new selection', async () => {
  const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'research', name), 'utf8');
  const a = fixture('example-evidence-reference-baseline.json');
  const excerpt = fixture('example-evidence-excerpt.json');
  const app = boot();
  const document = app.context.document;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  document.getElementById('transition-reference-a').files = [{name: 'slow.json', size: Buffer.byteLength(a),
    arrayBuffer: async () => { await waiting; return auditFile(a).arrayBuffer(); }}];
  document.getElementById('transition-checkpoint-a').files = [];
  document.getElementById('reference-file').files = [auditFile(a)];
  document.getElementById('checkpoint-file').files = [];
  document.getElementById('audit-receipts').files = [auditFile(excerpt)];
  const tracing = vm.runInContext('traceReferenceTransition()', app.context);
  await new Promise(resolve => setImmediate(resolve));
  document.getElementById('transition-reference-a').files = [auditFile('{')];
  vm.runInContext('invalidateReferenceTransition()', app.context);
  release();
  await tracing;
  const output = app.elements.get('reference-transition-result');
  assert.match(output.textContent, /File selection changed/);
  assert.equal(output.children.length, 0);
  await vm.runInContext('traceReferenceTransition()', app.context);
  assert.match(output.textContent, /FAIL: Reference A is not valid JSON/);
});

test('browser downloads and replays a strict paired capture without confusing consistency with verdicts', async () => {
  const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'research', name), 'utf8');
  const a = fixture('example-evidence-reference-baseline.json');
  const b = fixture('example-evidence-reference-conflict.json');
  const checkpoint = fixture('example-evidence-ledger-checkpoint.json');
  const excerpt = fixture('example-evidence-excerpt.json');
  const full = fixture('example-evidence-receipt.json');
  const app = boot();
  app.fact('private note', 'never disclose');
  const savedState = JSON.stringify([...app.saved]);
  const files = [auditFile(excerpt), auditFile(full), auditFile('{')];
  await traceSavedReferences(app, a, b, files, checkpoint);
  assert.equal(app.elements.get('transition-capture-download').disabled, false);
  vm.runInContext('downloadReferenceTransitionCapture()', app.context);
  const capture = JSON.parse(await app.exports[0].text());
  assert.deepEqual(Object.keys(capture), ['format', 'version', 'capture_a', 'capture_b', 'changed_receipts']);
  assert.equal(capture.version, 2);
  assert.match(capture.capture_a.normalization_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(capture.changed_receipts, [1, 2]);
  assert.deepEqual(capture.capture_a.totals, {match: 2, differ: 0, fail: 1, identical_copies: 0});
  assert.deepEqual(capture.capture_b.totals, {match: 0, differ: 2, fail: 1, identical_copies: 0});
  assert.equal(capture.capture_a.browser_script_sha256, createHash('sha256').update(source).digest('hex'));
  assert.equal(capture.capture_a.browser_script_sha256, capture.capture_b.browser_script_sha256);
  assert.doesNotMatch(JSON.stringify(capture), /favorite color|teal|amber|never disclose|private note/);
  assert.equal(JSON.stringify([...app.saved]), savedState);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-browser-transition-'));
  try {
    const write = (name, data) => { const file = path.join(dir, name); fs.writeFileSync(file, data); return file; };
    const selected = [write('excerpt.json', excerpt), write('full.json', full), write('malformed.json', '{')];
    const args = [write('a.json', a), ...selected, '--checkpoint', write('a-checkpoint.json', checkpoint),
      '--reference-b', write('b.json', b), '--check-transition', write('capture.json', JSON.stringify(capture))];
    for (const [executable, script] of [
      [process.execPath, 'audit-evidence-batch.cjs'], ['python3', 'independent-evidence-batch.py']]) {
      const replay = spawnSync(executable, [path.join(__dirname, '..', 'tools', script), ...args],
        {encoding: 'utf8'});
      assert.equal(replay.status, 0, replay.stderr);
      assert.match(replay.stdout, /TRANSITION CAPTURE MATCH/);
      assert.match(replay.stdout, /1 FAIL/);
    }
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }

  const input = app.context.document.getElementById('transition-capture-file');
  const output = app.elements.get('transition-capture-verification');
  const compare = async value => {
    input.files = [auditFile(typeof value === 'string' ? value : JSON.stringify(value))];
    vm.runInContext('invalidateReferenceTransitionReplay()', app.context);
    await vm.runInContext('verifySavedReferenceTransition()', app.context);
    return output.textContent;
  };
  assert.match(await compare(capture), /TRANSITION CAPTURE MATCH: 2 verdict changes.*A: 2 MATCH, 0 DIFFER, 1 FAIL.*B: 0 MATCH, 2 DIFFER, 1 FAIL.*including any DIFFER or FAIL/);
  const olderSide = side => { const {normalization_sha256, ...old} = side; return {...old, version: 2}; };
  assert.match(await compare({...capture, version: 1,
    capture_a: olderSide(capture.capture_a), capture_b: olderSide(capture.capture_b)}),
  /TRANSITION CAPTURE MATCH:.*Older capture: browser runtime was not recorded/);
  assert.match(await compare({...capture, changed_receipts: []}), /DIFFER: The saved transition capture does not reproduce/);
  assert.match(await compare({...capture, capture_b: {...capture.capture_b,
    receipts: [{...capture.capture_b.receipts[0], verdict: 'MATCH'}, ...capture.capture_b.receipts.slice(1)]}}), /DIFFER:/);
  assert.match(await compare({...capture, capture_a: {...capture.capture_a,
    normalization_sha256: '0'.repeat(64)}}), /DIFFER:/);
  assert.match(await compare({...capture, extra: 'never disclose'}), /DIFFER:/);
  assert.match(await compare({...capture, capture_a: {...capture.capture_a, version: 1}}), /DIFFER:/);
  assert.match(await compare('{'), /FAIL: Saved transition capture is not valid JSON/);
  assert.match(await compare({...capture, version: 3}), /FAIL: Unsupported transition capture format or version/);
  assert.doesNotMatch(output.textContent, /never disclose/);
  assert.equal(JSON.stringify([...app.saved]), savedState);

  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  input.files = [{name: 'slow.json', size: 1, arrayBuffer: async () => {
    await waiting; return auditFile(JSON.stringify(capture)).arrayBuffer();
  }}];
  vm.runInContext('invalidateReferenceTransitionReplay()', app.context);
  const checking = vm.runInContext('verifySavedReferenceTransition()', app.context);
  await new Promise(resolve => setImmediate(resolve));
  input.files = [auditFile(JSON.stringify(capture))];
  vm.runInContext('invalidateReferenceTransitionReplay()', app.context);
  release();
  await checking;
  assert.match(output.textContent, /Saved transition capture selection changed/);
  assert.match(await compare(capture), /TRANSITION CAPTURE MATCH/);

  app.context.document.getElementById('audit-receipts').files = [auditFile(excerpt)];
  vm.runInContext('invalidateEvidenceBatchAudit()', app.context);
  assert.equal(app.elements.get('transition-capture-download').disabled, true);
  assert.equal(app.elements.get('transition-capture-verify').disabled, true);
  vm.runInContext('downloadReferenceTransitionCapture()', app.context);
  assert.equal(app.exports.length, 1, 'old report cannot be downloaded after a new selection');
});

test('browser refuses ambiguous JSON before a receipt can be trusted or a reference traced', async () => {
  const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'research', name), 'utf8');
  const reference = fixture('example-evidence-reference-baseline.json');
  const receipt = fixture('example-evidence-receipt.json');
  const ambiguous = receipt.replace('"version": 1,', '"\\u0076ersion": 0, "version": 1,');
  assert.deepEqual(JSON.parse(ambiguous), JSON.parse(receipt));
  const app = boot();
  const saved = JSON.stringify([...app.saved]);
  assert.match(await chooseReceiptFile(app, ambiguous), /FAIL: File has duplicate JSON object names/);
  const result = await auditSavedReceipts(app, reference, [auditFile(ambiguous)]);
  assert.match(result.children[0].textContent, /0 MATCH, 0 DIFFER, 1 FAIL/);
  assert.match(result.children[1].children[0].children[1].children[0].children[3].textContent,
    /duplicate JSON object name/);
  const trace = await traceSavedReferences(app, reference, reference, [auditFile(ambiguous)]);
  assert.match(trace.children[0].textContent, /1 could not replay/);
  assert.match(trace.children.at(-1).children[0].children[2].textContent, /repeated object names/);
  const ambiguousReference = reference.replace('"next_source_id": 2',
    '"next_source_id": 9, "next_source_id": 2');
  const stopped = await traceSavedReferences(app, ambiguousReference, reference, [auditFile(receipt)]);
  assert.match(stopped.textContent, /FAIL: Reference A has a duplicate JSON object name/);
  assert.equal(stopped.children.length, 0);
  assert.equal(JSON.stringify([...app.saved]), saved);
});

test('transition capture distinguishes identical text from identical bytes, including a UTF-8 BOM', async () => {
  const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'research', name), 'utf8');
  const reference = fixture('example-evidence-reference-baseline.json');
  const receipt = fixture('example-evidence-excerpt.json');
  const app = boot();
  await traceSavedReferences(app, reference, reference,
    [auditFile(receipt), auditFile('\uFEFF' + receipt), auditFile(receipt)]);
  vm.runInContext('downloadReferenceTransitionCapture()', app.context);
  const capture = JSON.parse(await app.exports[0].text());
  assert.deepEqual(capture.capture_a.receipts.map(row => row.duplicate_of), [null, null, 1]);
  assert.deepEqual(capture.capture_b.receipts.map(row => row.verdict), ['MATCH', 'MATCH', 'MATCH']);
  assert.equal(capture.capture_a.totals.identical_copies, 1);
  assert.notEqual(capture.capture_a.receipts[0].sha256, capture.capture_a.receipts[1].sha256);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-transition-bom-'));
  try {
    const save = (name, data) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, data);
      return file;
    };
    const baseline = save('reference.json', reference);
    const files = [save('plain.json', receipt), save('bom.json', '\uFEFF' + receipt),
      save('repeat.json', receipt)];
    const saved = save('transition.json', JSON.stringify(capture));
    for (const [executable, script] of [[process.execPath, 'audit-evidence-batch.cjs'],
      ['python3', 'independent-evidence-batch.py']]) {
      const replay = spawnSync(executable, [path.join(__dirname, '..', 'tools', script),
        baseline, ...files, '--reference-b', baseline, '--check-transition', saved],
      {encoding: 'utf8'});
      assert.equal(replay.status, 0, `${script}: ${replay.stderr}`);
      assert.match(replay.stdout, /A: 3 MATCH, 0 DIFFER, 0 FAIL.*B: 3 MATCH, 0 DIFFER, 0 FAIL/s);
    }
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('browser private pair replays in page and both independent CLIs without publishing raw hashes', async () => {
  const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'research', name), 'utf8');
  const a = fixture('example-evidence-reference-baseline.json');
  const b = fixture('example-evidence-reference-conflict.json');
  const checkpoint = fixture('example-evidence-ledger-checkpoint.json');
  const excerpt = fixture('example-evidence-excerpt.json');
  const receipt = fixture('example-evidence-receipt.json');
  const app = boot();
  const files = [auditFile(excerpt), auditFile(receipt), auditFile('{')];
  await traceSavedReferences(app, a, b, files, checkpoint);
  assert.equal(app.elements.get('sealed-prepare').disabled, false);
  await vm.runInContext('prepareSealedTransition()', app.context);
  assert.equal(app.elements.get('sealed-key-download').disabled, false);
  vm.runInContext('downloadSealedTransitionCapture()', app.context);
  vm.runInContext('downloadSealedTransitionKey()', app.context);
  const capture = JSON.parse(await app.exports[0].text());
  const opening = JSON.parse(await app.exports[1].text());
  assert.equal(capture.format, 'aru-evidence-sealed-reference-transition-capture');
  assert.equal(capture.version, 2);
  assert.match(capture.normalization_a_commitment, /^[0-9a-f]{64}$/);
  assert.match(opening.key_hex, /^[0-9a-f]{64}$/);
  assert.deepEqual(capture.changed_receipts, [1, 2]);
  assert.equal(capture.totals_b.fail, 1);
  assert.doesNotMatch(JSON.stringify(capture), new RegExp(createHash('sha256').update(a).digest('hex')));
  assert.doesNotMatch(JSON.stringify(capture), /favorite color|teal|amber|key_hex/);
  assert.equal(Object.hasOwn(capture, 'reference_sha256'), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-browser-private-'));
  try {
    const save = (name, data) => {
      const file = path.join(dir, name); fs.writeFileSync(file, data); return file;
    };
    const originals = [save('excerpt.json', excerpt), save('receipt.json', receipt), save('malformed.json', '{')];
    const flags = [save('a.json', a), ...originals, '--checkpoint', save('checkpoint.json', checkpoint),
      '--reference-b', save('b.json', b), '--check-sealed', save('capture.json', JSON.stringify(capture)),
      '--opening-key', save('key.json', JSON.stringify(opening))];
    for (const [executable, script] of [[process.execPath, 'audit-evidence-batch.cjs'],
      ['python3', 'independent-evidence-batch.py']]) {
      const result = spawnSync(executable, [path.join(__dirname, '..', 'tools', script), ...flags],
        {encoding: 'utf8'});
      assert.equal(result.status, 0, `${script}: ${result.stderr}`);
      assert.match(result.stdout, /SEALED TRANSITION MATCH/);
      assert.match(result.stdout, /1 FAIL/);
    }
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  const captureInput = app.context.document.getElementById('sealed-capture-file');
  const keyInput = app.context.document.getElementById('sealed-key-file');
  const output = app.context.document.getElementById('sealed-verification');
  captureInput.files = [auditFile(JSON.stringify(capture))];
  keyInput.files = [auditFile(JSON.stringify(opening))];
  vm.runInContext('invalidateSealedReplay()', app.context);
  await vm.runInContext('verifySealedTransition()', app.context);
  assert.match(output.textContent, /PRIVATE CAPTURE MATCH: 2 verdict changes.*1 FAIL.*does not prove origin/);
  const {normalization_a_commitment, normalization_b_commitment, ...oldPrivate} = capture;
  captureInput.files = [auditFile(JSON.stringify({...oldPrivate, version: 1}))];
  vm.runInContext('invalidateSealedReplay()', app.context);
  await vm.runInContext('verifySealedTransition()', app.context);
  assert.match(output.textContent, /PRIVATE CAPTURE MATCH:.*Older private capture: browser runtime was not recorded/);
  captureInput.files = [auditFile(JSON.stringify(capture))];
  vm.runInContext('invalidateSealedReplay()', app.context);
  await vm.runInContext('verifySealedTransition()', app.context);
  assert.match(output.textContent, /PRIVATE CAPTURE MATCH/);
  keyInput.files = [auditFile(JSON.stringify({...opening, key_hex: 'f'.repeat(64)}))];
  vm.runInContext('invalidateSealedReplay()', app.context);
  await vm.runInContext('verifySealedTransition()', app.context);
  assert.match(output.textContent, /DIFFER: Private capture or opening key/);
  keyInput.files = [auditFile(JSON.stringify({...opening, key_hex: '00'}))];
  vm.runInContext('invalidateSealedReplay()', app.context);
  await vm.runInContext('verifySealedTransition()', app.context);
  assert.match(output.textContent, /FAIL: Opening key must be the exact version 1 file/);
  keyInput.files = [auditFile(JSON.stringify(opening))];
  captureInput.files = [auditFile(JSON.stringify({...capture, browser_script_sha256: '0'.repeat(64)}))];
  vm.runInContext('invalidateSealedReplay()', app.context);
  await vm.runInContext('verifySealedTransition()', app.context);
  assert.match(output.textContent, /DIFFER:/);
  captureInput.files = [auditFile(JSON.stringify({...capture, normalization_a_commitment: '0'.repeat(64)}))];
  vm.runInContext('invalidateSealedReplay()', app.context);
  await vm.runInContext('verifySealedTransition()', app.context);
  assert.match(output.textContent, /DIFFER:/);
  captureInput.files = [auditFile(JSON.stringify(capture))];
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  keyInput.files = [{size: 1, arrayBuffer: async () => {
    await waiting; return auditFile(JSON.stringify(opening)).arrayBuffer();
  }}];
  vm.runInContext('invalidateSealedReplay()', app.context);
  const oldCheck = vm.runInContext('verifySealedTransition()', app.context);
  await new Promise(resolve => setImmediate(resolve));
  keyInput.files = [auditFile(JSON.stringify(opening))];
  vm.runInContext('invalidateSealedReplay()', app.context);
  release();
  await oldCheck;
  assert.match(output.textContent, /selection changed/);
  await vm.runInContext('verifySealedTransition()', app.context);
  assert.match(output.textContent, /PRIVATE CAPTURE MATCH/);
  app.context.document.getElementById('audit-receipts').files = [auditFile(excerpt)];
  vm.runInContext('invalidateEvidenceBatchAudit()', app.context);
  assert.equal(app.elements.get('sealed-capture-download').disabled, true);
  assert.equal(app.elements.get('sealed-verify').disabled, true);
  vm.runInContext('downloadSealedTransitionKey()', app.context);
  assert.equal(app.exports.length, 2);
});

test('transition trace remains visible if a receipt cannot be captured or browser hashing is unavailable', async () => {
  const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'research', name), 'utf8');
  const a = fixture('example-evidence-reference-baseline.json');
  const excerpt = fixture('example-evidence-excerpt.json');
  const invalid = boot();
  const unread = {name: 'bad.json', size: 1, arrayBuffer: async () => Uint8Array.from([0xff]).buffer};
  const output = await traceSavedReferences(invalid, a, a, [unread]);
  assert.match(output.children[0].textContent, /1 could not replay/);
  assert.match(invalid.elements.get('transition-capture-status').textContent, /every selected receipt must be readable UTF-8/);
  assert.equal(invalid.elements.get('transition-capture-download').disabled, true);

  const noHash = boot({}, {crypto: {}});
  const traced = await traceSavedReferences(noHash, a, a, [auditFile(excerpt)]);
  assert.match(traced.children[0].textContent, /0 verdict changes, 1 unchanged/);
  assert.match(noHash.elements.get('transition-capture-status').textContent, /secure hashing/);
  assert.equal(noHash.elements.get('transition-capture-download').disabled, true);
});

test('batch audit checks each receipt against one saved reference and flags repeated text', async () => {
  const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'research', name), 'utf8');
  const excerpt = fixture('example-evidence-excerpt.json');
  const full = fixture('example-evidence-receipt.json');
  const reference = fixture('example-evidence-reference-baseline.json');
  const checkpoint = fixture('example-evidence-ledger-checkpoint.json');
  const changed = JSON.parse(excerpt);
  changed.records[0] = {...changed.records[0], id: 2, value: 'amber'};
  changed.answer = {...changed.answer, value: 'amber', sources: [2]};
  const brief = {format: 'aru-evidence-brief-receipt', version: 1,
    model_revision: 'aru-evidence-briefs-1', names: ['favorite color', 'pet'],
    records: JSON.parse(reference).records,
    results: [{name: 'favorite color', answer: JSON.parse(excerpt).answer},
      {name: 'pet', answer: {kind: 'missing'}}]};
  const app = boot();
  app.fact('private note', 'never enter audit');
  const saved = JSON.stringify([...app.saved]);
  const output = await auditSavedReceipts(app, reference, [
    auditFile(excerpt, '<img src=x onerror=alert(1)>.json'),
    auditFile(full, 'full.json'),
    auditFile(JSON.stringify(brief), 'brief.json'),
    auditFile(JSON.stringify(changed), 'changed.json'),
    auditFile('{', 'broken.json'),
    auditFile(excerpt, 'same-again.json')
  ], checkpoint);
  assert.match(output.children[0].textContent, /6 selected: 4 MATCH, 1 DIFFER, 1 FAIL; 1 identical-byte repeat.*Checkpoint agrees/);
  const rows = output.children[1].children[0].children[1].children;
  assert.deepEqual(rows.map(row => row.children[2].textContent),
    ['MATCH', 'MATCH', 'MATCH', 'DIFFER', 'FAIL', 'MATCH']);
  assert.match(rows[3].children[3].textContent, /different answer or citations/);
  assert.match(rows[4].children[3].textContent, /not valid JSON/);
  assert.match(rows[5].children[3].textContent, /Identical bytes to #1; not an independent file/);
  assert.equal(rows[0].children[1].textContent, '<img src=x onerror=alert(1)>.json');
  assert.equal(rows[0].children[1].innerHTML, '', 'untrusted filename is assigned as text');
  assert.equal(JSON.stringify([...app.saved]), saved);
  assert.doesNotMatch(JSON.stringify(rows.map(row => row.children.map(cell => cell.textContent))), /never enter audit/);
  await vm.runInContext('runEvidenceBatchAudit()', app.context);
  assert.equal(output.children.length, 2, 'repeat runs replace old results');
});

test('batch audit rejects a changed checkpoint before checking any receipt', async () => {
  const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'research', name), 'utf8');
  const reference = fixture('example-evidence-reference-baseline.json');
  const excerpt = fixture('example-evidence-excerpt.json');
  const checkpoint = JSON.parse(fixture('example-evidence-ledger-checkpoint.json'));
  const app = boot();
  const unread = {name: 'unread.json', size: 1, arrayBuffer: async () => {
    throw new Error('Receipt should not be opened');
  }};
  const output = await auditSavedReceipts(app, reference, [unread],
    JSON.stringify({...checkpoint, sha256: '0'.repeat(64)}));
  assert.match(output.textContent, /DIFFER: The reference ledger differs.*No receipts were audited/);
  assert.equal(output.children.length, 0);
  await auditSavedReceipts(app, '{', [auditFile(excerpt)]);
  assert.match(output.textContent, /FAIL: Reference ledger is not valid JSON/);
  await auditSavedReceipts(app, reference, [auditFile(excerpt)], 'null');
  assert.match(output.textContent, /FAIL: Unsupported checkpoint/);
});

test('batch audit distinguishes an omitted conflict from a receipt that fails replay', async () => {
  const excerpt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research',
    'example-evidence-excerpt.json'), 'utf8'));
  const conflict = {...excerpt.records[0], id: 2, value: 'amber', time: 1700000000001};
  const reference = JSON.stringify({format: 'aru-evidence-ledger-baseline', version: 1,
    records: [...excerpt.records, conflict], next_source_id: 3});
  const tampered = {...excerpt, answer: {...excerpt.answer, value: 'purple'}};
  const output = await auditSavedReceipts(boot(), reference, [
    auditFile(JSON.stringify(excerpt), 'omitted.json'),
    auditFile(JSON.stringify(tampered), 'tampered.json')
  ]);
  assert.match(output.children[0].textContent, /0 MATCH, 1 DIFFER, 1 FAIL.*No checkpoint supplied/);
  const rows = output.children[1].children[0].children[1].children;
  assert.match(rows[0].children[3].textContent, /different answer or citations; the excerpt may omit a source/);
  assert.match(rows[1].children[3].textContent, /recorded answer or citations disagree/);
});

test('batch audit bounds file count and size and reports unsupported or oversized files separately', async () => {
  const reference = fs.readFileSync(path.join(__dirname, '..', 'research',
    'example-evidence-reference-baseline.json'), 'utf8');
  const app = boot();
  let output = await auditSavedReceipts(app, reference, []);
  assert.match(output.textContent, /Choose 1–20/);
  output = await auditSavedReceipts(app, reference, Array.from({length: 21}, () => auditFile('{}')));
  assert.match(output.textContent, /Choose 1–20/);
  output = await auditSavedReceipts(app, reference, Array.from({length: 5}, () => auditFile('{}', 'big', 1024 * 1024)));
  assert.match(output.textContent, /4 MiB combined limit/);
  const oversized = auditFile('{}', 'oversized.json', 1024 * 1024 + 1);
  const correction = auditFile(JSON.stringify({format: 'aru-evidence-correction-receipt'}), 'correction.json');
  output = await auditSavedReceipts(app, reference, [oversized, correction]);
  assert.match(output.children[0].textContent, /0 MATCH, 0 DIFFER, 2 FAIL/);
  const rows = output.children[1].children[0].children[1].children;
  assert.match(rows[0].children[3].textContent, /exceeds the 1 MiB limit/);
  assert.match(rows[1].children[3].textContent, /Only question, excerpt, or brief/);
});

test('a slow batch audit cannot publish stale results after file selection changes', async () => {
  const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'research', name), 'utf8');
  const reference = fixture('example-evidence-reference-baseline.json');
  const excerpt = fixture('example-evidence-excerpt.json');
  const app = boot();
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const input = app.context.document.getElementById('audit-receipts');
  app.context.document.getElementById('reference-file').files = [auditFile(reference)];
  app.context.document.getElementById('checkpoint-file').files = [];
  input.files = [{name: 'slow.json', size: Buffer.byteLength(excerpt), arrayBuffer: async () => {
    await waiting; return auditFile(excerpt).arrayBuffer();
  }}];
  const checking = vm.runInContext('runEvidenceBatchAudit()', app.context);
  await new Promise(resolve => setImmediate(resolve));
  input.files = [auditFile(excerpt, 'new.json')];
  vm.runInContext('invalidateEvidenceBatchAudit()', app.context);
  release();
  await checking;
  assert.match(app.elements.get('audit-result').textContent, /Receipt selection changed/);
  assert.equal(app.elements.get('audit-result').children.length, 0);
  await vm.runInContext('runEvidenceBatchAudit()', app.context);
  assert.match(app.elements.get('audit-result').children[0].textContent, /1 MATCH/);
  vm.runInContext('invalidateReferenceComparison()', app.context);
  assert.match(app.elements.get('audit-result').textContent, /Reference or checkpoint selection changed/);
});

test('browser capture is byte-bound and the CLI reproduces mixed outcomes without private values', async () => {
  const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'research', name), 'utf8');
  const reference = fixture('example-evidence-reference-baseline.json');
  const checkpoint = fixture('example-evidence-ledger-checkpoint.json');
  const excerpt = fixture('example-evidence-excerpt.json');
  const altered = JSON.parse(excerpt);
  altered.records[0] = {...altered.records[0], value: 'amber'};
  altered.answer = {...altered.answer, value: 'amber'};
  const receiptTexts = [excerpt, JSON.stringify(altered), '{', excerpt];
  const app = boot();
  app.fact('private note', 'never expose this');
  const before = JSON.stringify([...app.saved]);
  await auditSavedReceipts(app, reference, receiptTexts.map((text, index) =>
    auditFile(text, `receipt-${index + 1}.json`)), checkpoint);
  assert.equal(app.elements.get('audit-capture-download').disabled, false);
  assert.match(app.elements.get('audit-capture-status').textContent, /Capture ready/);
  vm.runInContext('downloadEvidenceBatchCapture()', app.context);
  const capture = JSON.parse(await app.exports[0].text());
  assert.equal(capture.format, 'aru-evidence-browser-batch-capture');
  assert.equal(capture.version, 3);
  assert.match(capture.normalization_sha256, /^[0-9a-f]{64}$/);
  assert.equal(capture.browser_script_sha256,
    createHash('sha256').update(source).digest('hex'));
  assert.deepEqual(capture.receipts.map(row => [row.verdict, row.duplicate_of]),
    [['MATCH', null], ['DIFFER', null], ['FAIL', null], ['MATCH', 1]]);
  assert.deepEqual(capture.totals, {match: 2, differ: 1, fail: 1, identical_copies: 1});
  assert.equal(JSON.stringify([...app.saved]), before);
  assert.doesNotMatch(JSON.stringify(capture), /private note|never expose|favorite color|teal|receipt-1/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-browser-capture-'));
  try {
    const write = (name, text) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, text);
      return file;
    };
    const refFile = write('reference.json', reference);
    const checkpointFile = write('checkpoint.json', checkpoint);
    const receiptFiles = receiptTexts.map((text, index) => write(`receipt-${index}.json`, text));
    const captureFile = write('capture.json', JSON.stringify(capture));
    const cli = path.join(__dirname, '..', 'tools', 'audit-evidence-batch.cjs');
    const args = [cli, refFile, ...receiptFiles, '--checkpoint', checkpointFile,
      '--check-capture', captureFile];
    const pass = spawnSync(process.execPath, args, {encoding: 'utf8'});
    assert.equal(pass.status, 0, pass.stderr);
    assert.match(pass.stdout, /CAPTURE MATCH/);
    fs.appendFileSync(receiptFiles[0], '\n');
    const changed = spawnSync(process.execPath, args, {encoding: 'utf8'});
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /Browser capture differs/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }

  app.context.document.getElementById('audit-receipts').files = [auditFile(excerpt)];
  vm.runInContext('downloadEvidenceBatchCapture()', app.context);
  assert.equal(app.exports.length, 1, 'a changed selection cannot download the older capture');
  assert.equal(app.elements.get('audit-capture-download').disabled, true);
});

test('browser replays saved v2 and v1 captures and exposes byte, script, and structure differences', async () => {
  const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'research', name), 'utf8');
  const reference = fixture('example-evidence-reference-baseline.json');
  const checkpoint = fixture('example-evidence-ledger-checkpoint.json');
  const excerpt = fixture('example-evidence-excerpt.json');
  const app = boot();
  app.fact('private note', 'never show this');
  const before = JSON.stringify([...app.saved]);
  await auditSavedReceipts(app, reference, [auditFile(excerpt), auditFile('{')], checkpoint);
  vm.runInContext('downloadEvidenceBatchCapture()', app.context);
  const capture = JSON.parse(await app.exports[0].text());
  const input = app.context.document.getElementById('audit-capture-file');
  const output = app.elements.get('audit-capture-verification');
  const compare = async value => {
    input.files = [auditFile(typeof value === 'string' ? value : JSON.stringify(value), 'saved.json')];
    vm.runInContext('invalidateEvidenceBatchCaptureReplay()', app.context);
    await vm.runInContext('verifySavedBatchCapture()', app.context);
    return output.textContent;
  };
  assert.match(await compare(capture), /CAPTURE MATCH: Saved capture reproduced.*1 MATCH, 0 DIFFER, 1 FAIL.*runtime profile agree.*audit contains DIFFER or FAIL results/);
  assert.match(await compare({totals: capture.totals, receipts: capture.receipts,
    checkpoint_sha256: capture.checkpoint_sha256, reference_sha256: capture.reference_sha256,
    browser_script_sha256: capture.browser_script_sha256, version: 2, format: capture.format}),
    /CAPTURE MATCH: Saved capture reproduced/);
  const {browser_script_sha256, normalization_sha256, ...old} = capture;
  assert.match(await compare({...old, version: 1}), /CAPTURE MATCH:.*Legacy v1 capture has no browser script fingerprint/);
  assert.match(await compare({...capture, browser_script_sha256: '0'.repeat(64)}),
    /DIFFER:.*browser verifier script fingerprint differs/);
  assert.match(await compare({...capture, normalization_sha256: '0'.repeat(64)}),
    /DIFFER:.*evidence names normalize differently/);
  assert.match(await compare({...capture, reference_sha256: '0'.repeat(64)}),
    /DIFFER:.*Reference file bytes differ/);
  assert.match(await compare({...capture, receipts: [{...capture.receipts[0], verdict: 'DIFFER'}, capture.receipts[1]]}),
    /DIFFER:.*verdict differs/);
  assert.match(await compare({...capture, private_value: 'never show this'}), /DIFFER:.*structure/);
  assert.match(await compare({...old, version: 1, browser_script_sha256}), /DIFFER:.*structure/);
  const altered = {...capture, private_value: 'never show this', reference_sha256: '0'.repeat(64),
    receipts: [{...capture.receipts[1], index: 1, verdict: '<img onerror=alert(1)>'},
      {...capture.receipts[0], index: 2}],
    totals: {...capture.totals, fail: 0}};
  assert.match(await compare(altered), /DIFFER: \d+ capture mismatches.*structure differs/);
  const findings = output.children[0].children.map(item => item.textContent);
  assert.ok(findings.some(item => /Receipt #1 file bytes differ/.test(item)));
  assert.ok(findings.some(item => /Receipt #1 verdict differs.*current audit reports MATCH/.test(item)));
  assert.ok(findings.some(item => /Recorded FAIL total differs/.test(item)));
  assert.doesNotMatch(findings.join(' '), /favorite color|teal|private note|never show this|<img|[0-9a-f]{64}/);
  assert.match(await compare(capture), /CAPTURE MATCH:/);
  assert.equal(output.children.length, 0, 'a new comparison clears older mismatch details');
  assert.match(await compare('{'), /FAIL: Saved capture is not valid JSON/);
  assert.match(await compare({...capture, version: 4}), /FAIL: Unsupported saved capture format or version/);
  assert.equal(JSON.stringify([...app.saved]), before);
  assert.doesNotMatch(output.textContent, /never show this/);

  input.files = [auditFile(JSON.stringify(capture), 'saved.json')];
  vm.runInContext('invalidateEvidenceBatchCaptureReplay()', app.context);
  app.context.document.getElementById('audit-receipts').files = [auditFile(excerpt + '\n')];
  vm.runInContext('invalidateEvidenceBatchAudit()', app.context);
  assert.equal(app.elements.get('audit-capture-verify').disabled, true);
  await vm.runInContext('runEvidenceBatchAudit()', app.context);
  assert.equal(app.elements.get('audit-capture-verify').disabled, false);
  await vm.runInContext('verifySavedBatchCapture()', app.context);
  assert.match(output.textContent, /DIFFER:.*number of selected receipts differs/);
  assert.match(output.children[0].children.map(item => item.textContent).join(' '),
    /Receipt #1 file bytes differ/);
});

test('browser capture replay refuses unreadable files and ignores a stale read', async () => {
  const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'research', name), 'utf8');
  const app = boot();
  await auditSavedReceipts(app, fixture('example-evidence-reference-baseline.json'),
    [auditFile(fixture('example-evidence-excerpt.json'))]);
  vm.runInContext('downloadEvidenceBatchCapture()', app.context);
  const capture = await app.exports[0].text();
  const input = app.context.document.getElementById('audit-capture-file');
  const output = app.elements.get('audit-capture-verification');
  const inspect = async file => {
    input.files = [file];
    vm.runInContext('invalidateEvidenceBatchCaptureReplay()', app.context);
    await vm.runInContext('verifySavedBatchCapture()', app.context);
    return output.textContent;
  };
  assert.match(await inspect(auditFile(capture, 'oversized.json', 1024 * 1024 + 1)),
    /FAIL: Saved capture exceeds the 1 MiB limit/);
  const badEncoding = {name: 'bad.json', size: 1,
    arrayBuffer: async () => Uint8Array.from([0xff]).buffer};
  assert.match(await inspect(badEncoding), /FAIL: Saved capture is not valid UTF-8/);

  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  input.files = [{name: 'slow.json', size: Buffer.byteLength(capture), arrayBuffer: async () => {
    await waiting; return auditFile(capture).arrayBuffer();
  }}];
  vm.runInContext('invalidateEvidenceBatchCaptureReplay()', app.context);
  const checking = vm.runInContext('verifySavedBatchCapture()', app.context);
  await new Promise(resolve => setImmediate(resolve));
  input.files = [auditFile(capture, 'new.json')];
  vm.runInContext('invalidateEvidenceBatchCaptureReplay()', app.context);
  release();
  await checking;
  assert.match(output.textContent, /Saved capture selection changed/);
  await vm.runInContext('verifySavedBatchCapture()', app.context);
  assert.match(output.textContent, /CAPTURE MATCH: Saved capture reproduced/);
  vm.runInContext('invalidateReferenceComparison()', app.context);
  assert.equal(app.elements.get('audit-capture-verify').disabled, true);
  assert.match(output.textContent, /Audit the selected files again/);
});

test('capture requires readable UTF-8 files and secure hashing while audit remains read-only', async () => {
  const reference = fs.readFileSync(path.join(__dirname, '..', 'research',
    'example-evidence-reference-baseline.json'), 'utf8');
  const excerpt = fs.readFileSync(path.join(__dirname, '..', 'research',
    'example-evidence-excerpt.json'), 'utf8');
  const noHash = boot({}, {crypto: {}});
  await auditSavedReceipts(noHash, reference, [auditFile(excerpt)]);
  assert.match(noHash.elements.get('audit-result').children[0].textContent, /1 MATCH/);
  assert.equal(noHash.elements.get('audit-capture-download').disabled, true);
  assert.match(noHash.elements.get('audit-capture-status').textContent, /secure browser hashing is required/);

  const noScript = boot({}, {scriptSource: null});
  await auditSavedReceipts(noScript, reference, [auditFile(excerpt)]);
  assert.match(noScript.elements.get('audit-result').children[0].textContent, /1 MATCH/);
  assert.equal(noScript.elements.get('audit-capture-download').disabled, true);
  assert.match(noScript.elements.get('audit-capture-status').textContent,
    /loaded browser verifier source could not be read/);

  const invalid = boot();
  const file = {name: 'invalid.json', size: 2,
    arrayBuffer: async () => Uint8Array.from([0xff, 0xfe]).buffer};
  await auditSavedReceipts(invalid, reference, [file]);
  assert.match(invalid.elements.get('audit-result').children[0].textContent, /1 FAIL/);
  assert.match(invalid.elements.get('audit-result').children[1].children[0].children[1].children[0].children[3].textContent,
    /not valid UTF-8/);
  assert.equal(invalid.elements.get('audit-capture-download').disabled, true);
  assert.match(invalid.elements.get('audit-capture-status').textContent, /every selected file must be readable/);
});

test('a selection changed during browser capture hashing cannot enable a stale download', async () => {
  const reference = fs.readFileSync(path.join(__dirname, '..', 'research',
    'example-evidence-reference-baseline.json'), 'utf8');
  const excerpt = fs.readFileSync(path.join(__dirname, '..', 'research',
    'example-evidence-excerpt.json'), 'utf8');
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const crypto = {subtle: {digest: async (...args) => {
    await waiting;
    return webcrypto.subtle.digest(...args);
  }}};
  const app = boot({}, {crypto});
  const document = app.context.document;
  document.getElementById('reference-file').files = [auditFile(reference)];
  document.getElementById('checkpoint-file').files = [];
  document.getElementById('audit-receipts').files = [auditFile(excerpt)];
  const checking = vm.runInContext('runEvidenceBatchAudit()', app.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(app.elements.get('audit-result').children[0].textContent, /1 MATCH/);
  document.getElementById('audit-receipts').files = [auditFile(excerpt, 'new.json')];
  vm.runInContext('invalidateEvidenceBatchAudit()', app.context);
  release();
  await checking;
  assert.equal(app.elements.get('audit-capture-download').disabled, true);
  assert.equal(app.exports.length, 0);
  assert.match(app.elements.get('audit-result').textContent, /Receipt selection changed/);
});

test('a reference ledger detects an omitted conflict that a self-consistent excerpt cannot', async () => {
  const excerpt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-excerpt.json'), 'utf8'));
  const reference = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-reference-baseline.json'), 'utf8'));
  const unrelated = {id: 2, key: 'unrelated note', value: 'private example', time: 1700000000001,
    status: 'active', imported: false};
  const local = boot({aru_fact_claims: JSON.stringify([...reference.records, unrelated]), aru_fact_counter: '3'});
  const before = JSON.stringify([...local.saved]);
  assert.match(await chooseReceiptFile(local, JSON.stringify(excerpt)), /PASS: known/);
  assert.equal(local.elements.get('local-receipt-check').disabled, false);
  vm.runInContext('compareVerifiedEvidenceToLocal()', local.context);
  assert.match(local.elements.get('local-receipt-comparison').textContent, /MATCH: The answer and all 1 cited record/);
  assert.equal(JSON.stringify([...local.saved]), before, 'the comparison is read-only');

  const otherSource = {...unrelated, id: 3, key: 'favorite color', value: 'amber', time: 1700000000002};
  local.fact(otherSource.key, otherSource.value);
  assert.equal(verifyEvidenceReceipt(excerpt).kind, 'known', 'the excerpt still passes internal replay');
  vm.runInContext('compareVerifiedEvidenceToLocal()', local.context);
  assert.match(local.elements.get('local-receipt-comparison').textContent, /DIFFER: This browser gives a different answer/);
  const conflicted = {...reference, records: [...reference.records, unrelated, otherSource], next_source_id: 4};
  assert.throws(() => verifyEvidenceReceipt(excerpt, undefined, conflicted), /reference ledger gives a different answer/);
  assert.equal(verifyEvidenceReceipt(excerpt, undefined, {...reference, records: [...reference.records, unrelated], next_source_id: 3}).reference_scope,
    'answer-and-cited-records');
});

test('reference comparison checks cited record identity and exact full snapshots', async () => {
  const excerpt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-excerpt.json'), 'utf8'));
  const full = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-receipt.json'), 'utf8'));
  const reference = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-reference-baseline.json'), 'utf8'));
  const app = boot({aru_fact_claims: JSON.stringify(reference.records), aru_fact_counter: '2'});
  assert.match(await chooseReceiptFile(app, JSON.stringify(full)), /PASS: known/);
  vm.runInContext('compareVerifiedEvidenceToLocal()', app.context);
  assert.match(app.elements.get('local-receipt-comparison').textContent, /MATCH: All 1 supplied records exactly match/);
  assert.equal(verifyEvidenceReceipt(full, undefined, reference).reference_scope, 'exact-full-snapshot');

  const changedTime = structuredClone(excerpt);
  changedTime.records[0].time++;
  assert.match(await chooseReceiptFile(app, JSON.stringify(changedTime)), /PASS: known/);
  vm.runInContext('compareVerifiedEvidenceToLocal()', app.context);
  assert.match(app.elements.get('local-receipt-comparison').textContent, /DIFFER: A cited source/);
  assert.throws(() => verifyEvidenceReceipt(changedTime, undefined, reference), /cited source #1 differs/);

  app.fact('unrelated', 'another value');
  assert.match(await chooseReceiptFile(app, JSON.stringify(full)), /PASS: known/);
  vm.runInContext('compareVerifiedEvidenceToLocal()', app.context);
  assert.match(app.elements.get('local-receipt-comparison').textContent, /DIFFER: The supplied full snapshot/);
  assert.throws(() => verifyEvidenceReceipt(full, undefined,
    {...reference, records: app.field.claims, next_source_id: 3}), /supplied full snapshot differs/);
  assert.throws(() => verifyEvidenceReceipt(full, undefined,
    {...reference, next_source_id: 1}), /next source ID must exceed/);
  assert.throws(() => verifyEvidenceReceipt(full, undefined,
    {...reference, records: [...reference.records, {...reference.records[0]}], next_source_id: 2}),
    /invalid or duplicate baseline source/);
  assert.match(await chooseReceiptFile(app, '{}'), /FAIL: Unsupported format/);
  assert.equal(app.elements.get('local-receipt-check').disabled, true);
});

test('reference comparison separates unrelated and historical records from omitted answer-changing records', async () => {
  const excerpt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-excerpt.json'), 'utf8'));
  const source = {id: 2, key: 'favorite color', value: 'teal', time: 1700000000001,
    status: 'active', imported: false};
  const cases = [
    {label: 'unrelated', record: {...source, key: 'unrelated'}, match: true},
    {label: 'historical', record: {...source, value: 'amber', status: 'superseded'}, match: true},
    {label: 'additional citation', record: source, match: false},
    {label: 'conflict', record: {...source, value: 'amber'}, match: false},
    {label: 'ambiguous name', record: {...source, key: 'my favorite color'}, match: false}
  ];
  for (const item of cases) {
    const records = [excerpt.records[0], item.record];
    const baseline = {format: 'aru-evidence-ledger-baseline', version: 1, records, next_source_id: 3};
    const app = boot({aru_fact_claims: JSON.stringify(records), aru_fact_counter: '3'});
    assert.match(await chooseReceiptFile(app, JSON.stringify(excerpt)), /PASS: known/, item.label);
    vm.runInContext('compareVerifiedEvidenceToLocal()', app.context);
    assert.match(app.elements.get('local-receipt-comparison').textContent,
      item.match ? /^MATCH:/ : /^DIFFER:/, item.label);
    if (item.match) assert.equal(verifyEvidenceReceipt(excerpt, undefined, baseline).reference_match, true, item.label);
    else assert.throws(() => verifyEvidenceReceipt(excerpt, undefined, baseline), /different answer or citations/, item.label);
  }
});

test('a verified brief cross-checks its whole ledger without changing local state', async () => {
  const origin = boot();
  origin.fact('color', 'teal');
  origin.fact('city', 'Portland');
  origin.context.document.getElementById('brief-names').value = 'color\ncity';
  vm.runInContext('runEvidenceBrief(); downloadEvidenceBrief()', origin.context);
  const receipt = JSON.parse(await origin.exports[0].text());
  const copy = boot(Object.fromEntries(origin.saved));
  const before = JSON.stringify([...copy.saved]);
  assert.match(await chooseReceiptFile(copy, JSON.stringify(receipt)), /PASS: 2 names/);
  vm.runInContext('compareVerifiedEvidenceToLocal()', copy.context);
  assert.match(copy.elements.get('local-receipt-comparison').textContent, /MATCH: All 2 supplied records/);
  assert.equal(JSON.stringify([...copy.saved]), before);
  const baseline = {format: 'aru-evidence-ledger-baseline', version: 1,
    records: receipt.records, next_source_id: 3};
  assert.equal(verifyEvidenceReceipt(receipt, undefined, baseline).reference_match, true);
  copy.fact('new fact', 'value');
  vm.runInContext('compareVerifiedEvidenceToLocal()', copy.context);
  assert.match(copy.elements.get('local-receipt-comparison').textContent, /DIFFER: The supplied full snapshot/);
});

test('the CLI accepts a matching reference and rejects an omitted local conflict', () => {
  const tool = path.join(__dirname, '..', 'tools', 'verify-evidence-receipt.cjs');
  const excerpt = path.join(__dirname, '..', 'research', 'example-evidence-excerpt.json');
  const matching = path.join(__dirname, '..', 'research', 'example-evidence-reference-baseline.json');
  const conflicted = path.join(__dirname, '..', 'research', 'example-evidence-ledger-baseline.json');
  const pass = spawnSync(process.execPath, [tool, excerpt, matching], {encoding: 'utf8'});
  assert.equal(pass.status, 0);
  assert.match(pass.stdout, /MATCH: known.*reference answer-and-cited-records/);
  const fail = spawnSync(process.execPath, [tool, excerpt, conflicted], {encoding: 'utf8'});
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /reference ledger gives a different answer or citations/);
});

test('reference export is directly usable by the verifier and preserves the next source ID', async () => {
  const reference = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-reference-baseline.json'), 'utf8'));
  const excerpt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-excerpt.json'), 'utf8'));
  const app = boot({aru_fact_claims: JSON.stringify(reference.records), aru_fact_counter: '9'});
  const before = JSON.stringify([...app.saved]);
  vm.runInContext('downloadReferenceLedger()', app.context);
  const exported = JSON.parse(await app.exports[0].text());
  assert.deepEqual(exported, {...reference, next_source_id: 9});
  assert.equal(verifyEvidenceReceipt(excerpt, undefined, exported).reference_match, true);
  assert.equal(JSON.stringify([...app.saved]), before, 'export does not change browser storage');
  assert.match(app.elements.get('reference-export-result').textContent, /full private ledger/);
});

test('browser and CLI agree on a prior checkpoint, including the next ID and optional field presence', async () => {
  const reference = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-reference-baseline.json'), 'utf8'));
  const excerpt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-excerpt.json'), 'utf8'));
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-ledger-checkpoint.json'), 'utf8'));
  const app = boot({aru_fact_claims: JSON.stringify(reference.records), aru_fact_counter: '2'});
  const before = JSON.stringify([...app.saved]);
  await vm.runInContext('downloadLedgerCheckpoint()', app.context);
  const downloaded = JSON.parse(await app.exports[0].text());
  assert.deepEqual(downloaded, fixture);
  assert.equal(JSON.stringify([...app.saved]), before);
  assert.equal(JSON.stringify(downloaded).includes('teal'), false, 'checkpoint omits ledger values');
  assert.equal(verifyLedgerCheckpoint(reference, downloaded), true);
  assert.equal(verifyEvidenceReceipt(excerpt, undefined, reference, downloaded).reference_match, true);
  for (const changed of [
    {...reference, next_source_id: 3},
    {...reference, records: [{...reference.records[0], value: 'amber'}]},
    {...reference, records: [{...reference.records[0], time: reference.records[0].time + 1}]},
    {...reference, records: [{...reference.records[0], imported: true}]},
    {...reference, records: [{...reference.records[0], status: 'superseded'}]},
    {...reference, records: [{id: 2, ...Object.fromEntries(Object.entries(reference.records[0]).filter(([key]) => key !== 'id'))}], next_source_id: 3}
  ]) assert.throws(() => verifyLedgerCheckpoint(changed, downloaded), /checkpoint differs/);
  const absentFlag = {...reference, records: [Object.fromEntries(Object.entries(reference.records[0]).filter(([key]) => key !== 'imported'))]};
  assert.throws(() => verifyLedgerCheckpoint(absentFlag, downloaded), /checkpoint differs/);
  assert.throws(() => verifyLedgerCheckpoint(reference, {...downloaded, sha256: '0'.repeat(64)}), /checkpoint differs/);
  assert.throws(() => verifyLedgerCheckpoint(reference, {...downloaded, extra: 1}), /unsupported checkpoint/);
  assert.throws(() => verifyLedgerCheckpoint({...reference, next_source_id: 1}, downloaded), /next source ID must exceed/);
});

test('a forged matching receipt and reference cannot match a previously held checkpoint', () => {
  const tool = path.join(__dirname, '..', 'tools', 'verify-evidence-receipt.cjs');
  const excerptPath = path.join(__dirname, '..', 'research', 'example-evidence-excerpt.json');
  const referencePath = path.join(__dirname, '..', 'research', 'example-evidence-reference-baseline.json');
  const checkpointPath = path.join(__dirname, '..', 'research', 'example-evidence-ledger-checkpoint.json');
  const pass = spawnSync(process.execPath, [tool, excerptPath, referencePath, checkpointPath], {encoding: 'utf8'});
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /MATCH: known.*reference answer-and-cited-records/);
  assert.match(pass.stdout, /CHECKPOINT MATCH:/);

  const excerpt = JSON.parse(fs.readFileSync(excerptPath, 'utf8'));
  const reference = JSON.parse(fs.readFileSync(referencePath, 'utf8'));
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  const forged = structuredClone(excerpt);
  forged.records[0].value = 'amber';
  forged.answer.value = 'amber';
  const forgedReference = {...reference, records: forged.records};
  assert.equal(verifyEvidenceReceipt(forged, undefined, forgedReference).reference_match, true);
  assert.throws(() => verifyEvidenceReceipt(forged, undefined, forgedReference, checkpoint), /checkpoint differs/);
  const fail = spawnSync(process.execPath, [tool, excerptPath, referencePath,
    path.join(__dirname, '..', 'research', 'example-evidence-reference-baseline.json')], {encoding: 'utf8'});
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /unsupported checkpoint/);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-checkpoint-'));
  try {
    const nullFile = path.join(temp, 'null.json');
    fs.writeFileSync(nullFile, 'null\n');
    const nullCheckpoint = spawnSync(process.execPath,
      [tool, excerptPath, referencePath, nullFile], {encoding: 'utf8'});
    assert.equal(nullCheckpoint.status, 1, 'a supplied null checkpoint cannot silently skip the check');
    assert.match(nullCheckpoint.stderr, /unsupported checkpoint/);
  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
});

test('reference and checkpoint exports refuse stale snapshots and changed state during hashing', async () => {
  const sharedSaved = new Map();
  const seed = boot({}, {sharedSaved});
  seed.fact('color', 'teal');
  const old = boot({}, {sharedSaved});
  const writer = boot({}, {sharedSaved});
  writer.fact('city', 'Corvallis');
  vm.runInContext('downloadReferenceLedger()', old.context);
  await vm.runInContext('downloadLedgerCheckpoint()', old.context);
  assert.equal(old.exports.length, 0);
  assert.match(old.elements.get('reference-export-result').textContent, /saved ledger is unreadable or changed/);

  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const crypto = {subtle: {digest: async (...args) => { await waiting; return webcrypto.subtle.digest(...args); }}};
  const app = boot({}, {crypto});
  app.fact('color', 'teal');
  const checking = vm.runInContext('downloadLedgerCheckpoint()', app.context);
  app.fact('color', 'amber');
  release();
  await checking;
  assert.equal(app.exports.length, 0);
  assert.match(app.elements.get('reference-export-result').textContent, /ledger changed while hashing/);
  const noHash = boot({}, {crypto: {}});
  await vm.runInContext('downloadLedgerCheckpoint()', noHash.context);
  assert.equal(noHash.exports.length, 0);
  assert.match(noHash.elements.get('reference-export-result').textContent, /Secure browser hashing is unavailable/);
});

test('browser checks a saved reference and checkpoint without importing or exposing unrelated records', async () => {
  const excerpt = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-excerpt.json'), 'utf8');
  const reference = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-reference-baseline.json'), 'utf8');
  const checkpoint = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-ledger-checkpoint.json'), 'utf8');
  const app = boot();
  app.fact('private note', 'do not overwrite');
  const before = JSON.stringify([...app.saved]);
  assert.match(await chooseReceiptFile(app, excerpt), /PASS: known/);
  assert.equal(app.elements.get('reference-receipt-check').disabled, false);
  assert.match(await compareSavedReferenceFiles(app, reference, checkpoint),
    /MATCH: Checkpoint agrees with the reference. The answer and all 1 cited record/);
  assert.equal(JSON.stringify([...app.saved]), before, 'saved reference comparison is read-only');
  assert.equal(app.field.claims.length, 1);
  assert.equal(app.field.claims[0].key, 'private note');
  assert.doesNotMatch(app.elements.get('reference-receipt-comparison').textContent, /do not overwrite/);
  assert.match(await compareSavedReferenceFiles(app, reference), /MATCH: No checkpoint supplied/);

  const full = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-receipt.json'), 'utf8');
  assert.match(await chooseReceiptFile(app, full), /PASS: known/);
  assert.match(await compareSavedReferenceFiles(app, reference, checkpoint),
    /MATCH: Checkpoint agrees with the reference. All 1 supplied records exactly match/);
  const brief = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-brief.json'), 'utf8');
  assert.match(await chooseReceiptFile(app, brief), /PASS: 4 names/);
  assert.match(await compareSavedReferenceFiles(app, reference, checkpoint),
    /DIFFER: Checkpoint agrees with the reference. The supplied full snapshot differs/);
  const briefRecords = JSON.parse(brief).records;
  const briefReference = {format: 'aru-evidence-ledger-baseline', version: 1,
    records: briefRecords, next_source_id: 7};
  assert.match(await compareSavedReferenceFiles(app, JSON.stringify(briefReference)),
    /MATCH: No checkpoint supplied. All 6 supplied records exactly match/);
  assert.match(await compareSavedReferenceFiles(app, JSON.stringify({...briefReference,
    records: [...briefRecords].reverse()})), /DIFFER: No checkpoint supplied. The supplied full snapshot differs/);
  assert.equal(JSON.stringify([...app.saved]), before);
});

test('saved checkpoint exposes a forged matching pair and reference exposes omitted conflicts', async () => {
  const excerpt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-excerpt.json'), 'utf8'));
  const reference = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-reference-baseline.json'), 'utf8'));
  const checkpoint = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-ledger-checkpoint.json'), 'utf8');
  const app = boot();
  const forged = structuredClone(excerpt);
  forged.records[0].value = 'amber';
  forged.answer.value = 'amber';
  const forgedReference = {...reference, records: forged.records};
  assert.match(await chooseReceiptFile(app, JSON.stringify(forged)), /PASS: known/);
  assert.match(await compareSavedReferenceFiles(app, JSON.stringify(forgedReference)), /MATCH: No checkpoint supplied/);
  assert.match(await compareSavedReferenceFiles(app, JSON.stringify(forgedReference), checkpoint),
    /DIFFER: The reference ledger differs from the selected checkpoint/);

  const conflicted = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-ledger-baseline.json'), 'utf8'));
  assert.match(await chooseReceiptFile(app, JSON.stringify(excerpt)), /PASS: known/);
  assert.match(await compareSavedReferenceFiles(app, JSON.stringify(conflicted)),
    /DIFFER: No checkpoint supplied. The reference ledger gives a different answer or citations/);
  assert.match(await compareSavedReferenceFiles(app, JSON.stringify(reference), checkpoint), /MATCH: Checkpoint agrees/);
  assert.match(await compareSavedReferenceFiles(app, JSON.stringify({...reference,
    records: [{...reference.records[0], time: reference.records[0].time + 1}]})),
    /DIFFER: No checkpoint supplied. A cited source differs/);
});

test('saved reference comparison rejects malformed files, large files, and unsupported receipts', async () => {
  const excerpt = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-excerpt.json'), 'utf8');
  const reference = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-reference-baseline.json'), 'utf8'));
  const checkpoint = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-ledger-checkpoint.json'), 'utf8'));
  const app = boot();
  assert.match(await chooseReceiptFile(app, excerpt), /PASS:/);
  assert.match(await compareSavedReferenceFiles(app, '{'), /FAIL: Reference ledger is not valid JSON/);
  assert.match(await compareSavedReferenceFiles(app, 'null'), /FAIL: Choose a reference ledger export/);
  assert.match(await compareSavedReferenceFiles(app, JSON.stringify({...reference, next_source_id: 1})),
    /FAIL: Reference next source ID must exceed/);
  assert.match(await compareSavedReferenceFiles(app, JSON.stringify({...reference,
    records: [...reference.records, {...reference.records[0]}]})), /FAIL: Invalid or duplicate reference/);
  assert.match(await compareSavedReferenceFiles(app, JSON.stringify(reference), 'null'),
    /FAIL: Unsupported checkpoint format/);
  assert.match(await compareSavedReferenceFiles(app, JSON.stringify(reference), JSON.stringify({...checkpoint, extra: 1})),
    /FAIL: Unsupported checkpoint format/);
  assert.match(await compareSavedReferenceFiles(app, JSON.stringify(reference), '{'),
    /FAIL: Checkpoint is not valid JSON/);
  const input = app.context.document.getElementById('reference-file');
  input.files = [{size: 1024 * 1024 + 1, text: async () => JSON.stringify(reference)}];
  await vm.runInContext('compareVerifiedEvidenceToReference()', app.context);
  assert.match(app.elements.get('reference-receipt-comparison').textContent, /FAIL: Reference ledger exceeds the 1 MiB limit/);
  assert.equal(app.field.claims.length, 0);
  assert.equal(app.saved.size, 0);
  const correction = applicableCorrectionFixture();
  assert.match(await chooseReceiptFile(app, JSON.stringify(correction)), /PASS: correction/);
  assert.equal(app.elements.get('reference-receipt-check').disabled, true);
  await vm.runInContext('compareVerifiedEvidenceToReference()', app.context);
  assert.match(app.elements.get('reference-receipt-comparison').textContent, /Verify a question, excerpt, or brief first/);
});

test('a slow saved reference comparison cannot replace a newer selection or receipt', async () => {
  const excerpt = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-excerpt.json'), 'utf8');
  const reference = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-reference-baseline.json'), 'utf8');
  const checkpoint = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-ledger-checkpoint.json'), 'utf8');
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const crypto = {subtle: {digest: async (...args) => { await waiting; return webcrypto.subtle.digest(...args); }}};
  const app = boot({}, {crypto});
  await chooseReceiptFile(app, excerpt);
  app.context.document.getElementById('reference-file').files =
    [{size: Buffer.byteLength(reference), text: async () => reference}];
  app.context.document.getElementById('checkpoint-file').files =
    [{size: Buffer.byteLength(checkpoint), text: async () => checkpoint}];
  const checking = vm.runInContext('compareVerifiedEvidenceToReference()', app.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(await compareSavedReferenceFiles(app, reference), /MATCH: No checkpoint supplied/);
  release();
  await checking;
  assert.match(app.elements.get('reference-receipt-comparison').textContent, /MATCH: No checkpoint supplied/);
  assert.match(await chooseReceiptFile(app, '{}'), /FAIL:/);
  assert.equal(app.elements.get('reference-receipt-check').disabled, true);
  assert.match(app.elements.get('reference-receipt-comparison').textContent, /Verify a question, excerpt, or brief/);
});

test('the five-case trust lab computes replay, reference, and checkpoint outcomes without user data', async () => {
  const app = boot();
  app.fact('private note', 'do not use in demo');
  const before = JSON.stringify([...app.saved]);
  const records = JSON.stringify(app.field.claims);
  await vm.runInContext('runEvidenceTrustLab()', app.context);
  const output = app.elements.get('trust-lab-result');
  assert.equal(app.elements.get('receipt-verifier').open, true);
  assert.match(output.children[0].textContent, /5\/5 fixed scenarios behaved as predicted/);
  const rows = output.children[1].children[0].children[1].children;
  assert.deepEqual(rows.map(row => row.children.map(cell => cell.textContent)), [
    ['Original answer', 'PASS', 'MATCH', 'MATCH', 'ACCEPT'],
    ['Omitted current conflict', 'PASS', 'DIFFER', 'MATCH', 'REJECT'],
    ['Receipt and reference changed together', 'PASS', 'MATCH', 'DIFFER', 'REJECT'],
    ['Older superseded assertion', 'PASS', 'MATCH', 'MATCH', 'ACCEPT'],
    ['Answer edited without its source', 'FAIL', 'SKIP', 'MATCH', 'REJECT']
  ]);
  assert.equal(JSON.stringify([...app.saved]), before);
  assert.equal(JSON.stringify(app.field.claims), records);
  assert.doesNotMatch(JSON.stringify(rows.map(row => row.children.map(cell => cell.textContent))), /do not use in demo/);
  await vm.runInContext('runEvidenceTrustLab()', app.context);
  assert.equal(app.elements.get('trust-lab-result').children.length, 2, 'repeat runs replace rather than append results');
});

test('the trust lab flags a broken reference rule and handles unavailable hashing', async () => {
  const faulty = boot();
  vm.runInContext('compareEvidenceToReference = () => ({match: true, detail: "broken"})', faulty.context);
  await vm.runInContext('runEvidenceTrustLab()', faulty.context);
  assert.match(faulty.elements.get('trust-lab-result').children[0].textContent,
    /4\/5 fixed scenarios behaved as predicted/);
  const noCrypto = boot({}, {crypto: {}});
  await vm.runInContext('runEvidenceTrustLab()', noCrypto.context);
  assert.match(noCrypto.elements.get('trust-lab-result').textContent,
    /Could not run the challenge: Secure browser hashing is unavailable/);
  assert.equal(noCrypto.saved.size, 0);
});

test('local cross-check refuses a tab whose saved reference changed after file verification', async () => {
  const reference = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-reference-baseline.json'), 'utf8'));
  const excerpt = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-excerpt.json'), 'utf8');
  const app = boot({aru_fact_claims: JSON.stringify(reference.records), aru_fact_counter: '2'});
  assert.match(await chooseReceiptFile(app, excerpt), /PASS: known/);
  app.saved.set('aru_fact_ledger_v1', JSON.stringify({version: 1,
    claims: [...reference.records, {id: 2, key: 'favorite color', value: 'amber',
      time: 1700000000001, status: 'active', imported: false}], next_source_id: 3}));
  vm.runInContext('compareVerifiedEvidenceToLocal()', app.context);
  assert.match(app.elements.get('local-receipt-comparison').textContent, /saved ledger is unreadable or changed/);
  assert.match(app.elements.get('ledger-sync-alert').textContent, /Saved evidence changed/);
  assert.equal(boot(Object.fromEntries(app.saved)).field.claims.length, 2);

  const correction = applicableCorrectionFixture();
  assert.match(await chooseReceiptFile(app, JSON.stringify(correction)), /PASS: correction/);
  assert.equal(app.elements.get('local-receipt-check').disabled, true);
});

test('browser checks shared full receipts and excerpts without importing or saving them', async () => {
  const app = boot({unrelated_key: 'keep'});
  app.fact('private local fact', 'do not overwrite');
  const before = JSON.stringify([...app.saved]);
  const local = JSON.stringify(app.field.claims);
  for (const name of ['example-evidence-receipt.json', 'example-evidence-excerpt.json']) {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'research', name), 'utf8');
    const result = await chooseReceiptFile(app, raw);
    assert.match(result, /PASS: known; 1 supplied records; source IDs: #1/);
    assert.match(result, /Question:.*Recorded answer:/);
    assert.equal(verifyEvidenceReceipt(JSON.parse(raw)).kind, 'known');
  }
  const markup = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-excerpt.json'), 'utf8'));
  markup.records[0].value = '<img src=x onerror=alert(1)>';
  markup.answer.value = markup.records[0].value;
  assert.match(await chooseReceiptFile(app, JSON.stringify(markup)), /Recorded answer: “<img src=x onerror=alert\(1\)>”/);
  assert.equal(app.elements.get('receipt-verification').innerHTML, '');
  assert.match(app.elements.get('receipt-verification').textContent, /scope: cited assertions only/);
  assert.equal(JSON.stringify(app.field.claims), local);
  assert.equal(JSON.stringify([...app.saved]), before);
  assert.equal(app.field.coherence, 0.64);
  assert.equal(app.field.messages.length, 0);
});

test('browser verifies a conflict refusal from another ledger using the same result as the CLI', async () => {
  const origin = boot();
  origin.fact('favorite color', 'teal');
  origin.fact('favorite color', 'amber');
  origin.context.document.getElementById('fact-question').value = 'What is my favorite color?';
  vm.runInContext('askEvidence()', origin.context);
  vm.runInContext('downloadEvidenceReceipt()', origin.context);
  const raw = await origin.exports[0].text();
  const visitor = boot();
  assert.equal(verifyEvidenceReceipt(JSON.parse(raw)).kind, 'conflict');
  assert.match(await chooseReceiptFile(visitor, raw), /PASS: conflict; 2 supplied records; source IDs: #1, #2.*No answer \(conflict\)/);
  assert.equal(visitor.field.claims.length, 0);
  assert.equal(visitor.saved.size, 0);
});

test('browser and CLI verifiers agree across every labeled evidence challenge case', () => {
  const challenge = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'evidence-challenge.json'), 'utf8'));
  const app = boot();
  const model = require('../tools/benchmark-evidence.cjs').loadModel();
  for (const item of challenge.cases) {
    const receipt = {format: 'aru-evidence-question-receipt', version: 1,
      model_revision: 'aru-evidence-questions-1', question: item.question,
      records: item.claims, answer: model.resolve(item.question, item.claims)};
    assert.equal(receipt.answer.kind, item.expected.kind, item.id);
    assert.equal(verifyEvidenceReceipt(receipt).kind, item.expected.kind, item.id);
    app.context.receiptToCheck = receipt;
    assert.equal(vm.runInContext('verifyEvidenceBundle(receiptToCheck).answer.kind', app.context), item.expected.kind, item.id);
  }
});

test('browser verifier refuses altered citations, duplicate or extra excerpt sources, invalid JSON and oversized files', async () => {
  const app = boot();
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-evidence-excerpt.json'), 'utf8'));
  const altered = structuredClone(fixture);
  altered.answer.sources = [999];
  assert.match(await chooseReceiptFile(app, JSON.stringify(altered)), /FAIL:.*citations disagree/);
  const wrongRevision = structuredClone(fixture);
  wrongRevision.model_revision = 'future-model';
  assert.match(await chooseReceiptFile(app, JSON.stringify(wrongRevision)), /FAIL: Unsupported format, model revision/);
  const duplicate = structuredClone(fixture);
  duplicate.records.push({...duplicate.records[0]});
  assert.match(await chooseReceiptFile(app, JSON.stringify(duplicate)), /FAIL: Invalid or duplicate/);
  const extra = structuredClone(fixture);
  extra.records.push({...extra.records[0], id: 2, key: 'secret', value: 'unrelated'});
  assert.match(await chooseReceiptFile(app, JSON.stringify(extra)), /FAIL: An excerpt/);
  assert.match(await chooseReceiptFile(app, '{not json'), /FAIL: File is not valid JSON/);
  assert.match(await chooseReceiptFile(app, '{}', 1024 * 1024 + 1), /FAIL: File exceeds the 1 MiB limit/);
  assert.equal(app.elements.get('receipt-verification').innerHTML, '');
  assert.equal(app.field.claims.length, 0);
  assert.equal(app.saved.size, 0);
});

test('a slower receipt file cannot replace the result of a newer selection', async () => {
  const app = boot();
  const input = app.context.document.getElementById('receipt-file');
  const correction = JSON.stringify(applicableCorrectionFixture());
  let finishFirst;
  input.files = [{size: Buffer.byteLength(correction), text: () => new Promise(resolve => { finishFirst = resolve; })}];
  const first = vm.runInContext('verifyEvidenceFile()', app.context);
  assert.match(await chooseReceiptFile(app, '{}'), /FAIL: Unsupported format/);
  finishFirst(correction);
  await first;
  assert.match(app.elements.get('receipt-verification').textContent, /FAIL: Unsupported format/);
  assert.equal(app.elements.get('incoming-correction-preview-button').disabled, true);
  assert.equal(vm.runInContext('verifiedIncomingCorrection', app.context), null);
});

test('question matching abstains on unsupported grammar and ambiguous stored names', () => {
  const app = boot();
  app.fact('favorite color', 'teal');
  app.fact('my favorite color', 'amber');
  const question = app.context.document.getElementById('fact-question');
  question.value = 'What is my favorite color?';
  vm.runInContext('askEvidence()', app.context);
  const ambiguous = app.elements.get('fact-answer').textContent;
  assert.match(ambiguous, /multiple recorded names.*No answer given/);
  assert.match(ambiguous, /“favorite color”/);
  assert.match(ambiguous, /“my favorite color”/);
  question.value = 'What is favorite color?';
  vm.runInContext('askEvidence()', app.context);
  assert.match(app.elements.get('fact-answer').textContent, /teal.*Source #1/);
  question.value = 'Who knows my favorite color?';
  vm.runInContext('askEvidence()', app.context);
  assert.match(app.elements.get('fact-answer').textContent, /Use.*What is.*No answer given/);
});

test('conflicts and deletions invalidate prior question answers and require a new source choice', () => {
  const app = boot();
  const question = app.context.document.getElementById('fact-question');
  question.value = 'What is my favorite color?';
  app.fact('favorite color', 'teal');
  vm.runInContext('askEvidence()', app.context);
  assert.match(app.elements.get('fact-answer').textContent, /teal.*Source #1/);
  app.fact('favorite color', 'amber');
  assert.match(app.elements.get('fact-answer').textContent, /ledger changed.*Ask again/i);
  vm.runInContext('askEvidence()', app.context);
  assert.match(app.elements.get('fact-answer').textContent, /Conflicting.*#1, #2.*No answer given/);
  vm.runInContext('selectFact(1)', app.context);
  vm.runInContext('askEvidence()', app.context);
  assert.match(app.elements.get('fact-answer').textContent, /teal.*Source #1/);
  vm.runInContext('deleteFact(1)', app.context);
  vm.runInContext('askEvidence()', app.context);
  assert.match(app.elements.get('fact-answer').textContent, /Only superseded.*No answer given/);
});

test('answers from untrusted values render as text', () => {
  const app = boot();
  app.fact('quote', '<img src=x onerror=alert(1)>');
  app.context.document.getElementById('fact-question').value = 'What is quote?';
  vm.runInContext('askEvidence()', app.context);
  const answer = app.elements.get('fact-answer');
  assert.match(answer.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(answer.innerHTML, '');
});

test('conflicting assertions force abstention until one source is selected', () => {
  const app = boot();
  const lookup = vm.runInContext('lookupFact', app.context);
  app.fact('favorite color', 'teal');
  app.fact('FAVORITE COLOR', 'amber');
  assert.equal(lookup('favorite color').kind, 'conflict');
  assert.match(app.elements.get('ledger-result').textContent, /No answer given/);
  vm.runInContext('selectFact(1)', app.context);
  assert.equal(lookup('favorite color').kind, 'known');
  assert.equal(lookup('favorite color').value, 'teal');
  assert.equal(app.field.claims[1].status, 'superseded');
  const reloaded = boot(Object.fromEntries(app.saved));
  assert.equal(vm.runInContext('lookupFact("favorite color")', reloaded.context).value, 'teal');
  app.fact('favorite color', 'violet');
  assert.equal(lookup('favorite color').kind, 'conflict');
  vm.runInContext('deleteFact(3)', app.context);
  assert.equal(lookup('favorite color').value, 'teal');
  vm.runInContext('deleteFact(1)', app.context);
  assert.equal(lookup('favorite color').kind, 'historical');
});

test('a case change in a value is a conflict rather than silent agreement', () => {
  const app = boot();
  app.fact('identifier', 'US');
  app.fact('identifier', 'us');
  assert.equal(vm.runInContext('lookupFact("identifier").kind', app.context), 'conflict');
});

test('fact rendering treats entered markup as text and malformed saved records are rejected', () => {
  const app = boot();
  app.fact('<img src=x onerror=alert(1)>', '<svg onload=alert(1)>');
  const card = app.elements.get('ledger-entries').children[0];
  assert.match(card.children[0].textContent, /<svg onload=alert\(1\)>/);
  assert.equal(card.children[0].innerHTML, '');
  const restored = boot({ aru_fact_claims: JSON.stringify([
    { id: 1, key: 'valid', value: 'yes', time: Date.now(), status: 'active' },
    { id: 1, key: 'duplicate', value: 'no', time: Date.now(), status: 'active' },
    { id: 2, key: 'bad', value: '<script>', time: 'not a time', status: 'active' }
  ]) });
  assert.equal(restored.field.claims.length, 1);
  assert.equal(restored.field.claims[0].key, 'valid');
});

test('full fact ledger refuses overflow rather than silently evicting sources', () => {
  const claims = Array.from({length: 100}, (_, i) => ({
    id: i + 1, key: `key ${i}`, value: `value ${i}`, time: Date.now(), status: 'active'
  }));
  const app = boot({aru_fact_claims: JSON.stringify(claims), aru_fact_counter: '101'});
  app.fact('another', 'value');
  assert.equal(app.field.claims.length, 100);
  assert.match(app.elements.get('ledger-result').textContent, /nothing was silently removed/);
});

test('evidence-only export previews and merges a conflict with new local source IDs', async () => {
  const origin = boot();
  origin.fact('favorite color', 'amber');
  vm.runInContext('downloadFactLedger()', origin.context);
  const json = await origin.exports[0].text();
  const bundle = JSON.parse(json);
  assert.equal(bundle.format, 'aru-evidence-ledger');
  assert.equal(bundle.version, 1);
  assert.equal(bundle.records.length, 1);
  assert.equal(bundle.records[0].value, 'amber');
  assert.equal(bundle.memory, undefined);

  const target = boot();
  target.fact('favorite color', 'teal');
  target.context.document.getElementById('fact-question').value = 'What is my favorite color?';
  vm.runInContext('askEvidence()', target.context);
  assert.match(target.elements.get('fact-answer').textContent, /teal.*Source #1/);
  const before = JSON.stringify(target.field.claims);
  target.elements.get('fact-import').files = [{size: Buffer.byteLength(json), text: async () => json}];
  target.elements.get('fact-import').value = 'aru-evidence-ledger.json';
  await vm.runInContext('previewFactImport()', target.context);
  assert.equal(JSON.stringify(target.field.claims), before, 'preview must not change the ledger');
  assert.equal(target.elements.get('fact-import-apply').disabled, false);
  const preview = target.elements.get('fact-import-preview');
  assert.match(preview.children[0].textContent, /1 affected name will have conflicting/);
  assert.match(preview.children[1].textContent, /Incoming #1 → local #2.*amber/);
  assert.match(preview.children[2].textContent, /local #1 = teal.*local #2 = amber.*withhold an answer/);
  vm.runInContext('applyFactImport()', target.context);
  assert.match(target.elements.get('fact-answer').textContent, /ledger changed.*Ask again/i);
  vm.runInContext('askEvidence()', target.context);
  assert.match(target.elements.get('fact-answer').textContent, /Conflicting.*No answer given/);
  assert.equal(target.field.claims.length, 2);
  assert.equal(target.field.claims[1].id, 2);
  assert.equal(target.field.claims[1].imported, true);
  assert.equal(target.field.coherence, 0.64);
  assert.equal(target.field.memory.length, 0);
  assert.equal(vm.runInContext('lookupFact("favorite color").kind', target.context), 'conflict');
  const reloaded = boot(Object.fromEntries(target.saved));
  assert.equal(vm.runInContext('lookupFact("favorite color").kind', reloaded.context), 'conflict');
  assert.match(reloaded.elements.get('ledger-entries').children[0].children[1].textContent, /imported assertion/);
  reloaded.context.document.getElementById('fact-question').value = 'What is my favorite color?';
  vm.runInContext('selectFact(2)', reloaded.context);
  vm.runInContext('askEvidence()', reloaded.context);
  assert.match(reloaded.elements.get('fact-answer').textContent, /amber.*Source #2.*user assertion/);
});

test('malformed and over-capacity imports are rejected in full without changing records', async () => {
  const app = boot();
  app.fact('already here', 'yes');
  const good = {id: 1, key: 'new', value: 'value', time: Date.now(), status: 'active'};
  const bad = {...good, id: 2, time: 'invalid'};
  const preview = async records => {
    const text = JSON.stringify({format: 'aru-evidence-ledger', version: 1, records});
    app.elements.get('fact-import').files = [{size: Buffer.byteLength(text), text: async () => text}];
    app.elements.get('fact-import').value = 'candidate.json';
    await vm.runInContext('previewFactImport()', app.context);
  };
  await preview([good, bad]);
  assert.match(app.elements.get('fact-import-preview').textContent, /invalid or duplicate/);
  assert.equal(app.elements.get('fact-import-apply').disabled, true);
  assert.equal(app.field.claims.length, 1);
  await preview(Array.from({length: 100}, (_, i) => ({...good, id: i + 1})));
  assert.match(app.elements.get('fact-import-preview').textContent, /exceed 100 records/);
  assert.equal(app.field.claims.length, 1);
  const input = app.elements.get('fact-import');
  input.files = [{size: 262145, text: async () => { throw Error('should not read'); }}];
  input.value = 'too-large.json';
  await vm.runInContext('previewFactImport()', app.context);
  assert.match(app.elements.get('fact-import-preview').textContent, /256 KiB limit/);
  assert.equal(app.field.claims.length, 1);
});

test('a local edit invalidates an import preview before it can be applied', async () => {
  const app = boot();
  const json = JSON.stringify({format: 'aru-evidence-ledger', version: 1,
    records: [{id: 1, key: 'imported', value: 'value', time: Date.now(), status: 'active'}]});
  app.context.document.getElementById('fact-import').files = [{size: Buffer.byteLength(json), text: async () => json}];
  app.elements.get('fact-import').value = 'candidate.json';
  await vm.runInContext('previewFactImport()', app.context);
  app.fact('local', 'value');
  assert.equal(app.elements.get('fact-import-apply').disabled, true);
  vm.runInContext('applyFactImport()', app.context);
  assert.equal(app.field.claims.length, 1);
  assert.equal(app.field.claims[0].key, 'local');
  assert.match(app.elements.get('fact-import-preview').textContent, /Choose the file again/);
});

test('imported markup remains text in both preview and stored cards', async () => {
  const app = boot();
  const json = JSON.stringify({format: 'aru-evidence-ledger', version: 1,
    records: [{id: 1, key: '<img src=x onerror=alert(1)>', value: '<svg onload=alert(1)>',
      time: Date.now(), status: 'active'}]});
  const input = app.context.document.getElementById('fact-import');
  input.files = [{size: Buffer.byteLength(json), text: async () => json}];
  input.value = 'candidate.json';
  await vm.runInContext('previewFactImport()', app.context);
  const preview = app.elements.get('fact-import-preview').children[1];
  assert.match(preview.textContent, /<svg onload=alert\(1\)>/);
  assert.equal(preview.innerHTML, '');
  vm.runInContext('applyFactImport()', app.context);
  const card = app.elements.get('ledger-entries').children[0];
  assert.match(card.children[0].textContent, /<svg onload=alert\(1\)>/);
  assert.equal(card.children[0].innerHTML, '');
});

test('corrupt saved data falls back safely and saved messages restore as text', () => {
  const app = boot({
    aru_coherence: 'null',
    aru_memory: '{broken',
    aru_messages: JSON.stringify([{type: 'field', text: '<img src=x onerror=alert(1)>', html: '<img src=x onerror=alert(1)>'}])
  });
  assert.equal(app.field.coherence, 0.64);
  assert.equal(app.field.memory.length, 0);
  const restored = app.elements.get('messages').children[0];
  assert.equal(restored.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(restored.innerHTML, '');
});

test('malformed memory numbers and tokens are repaired before scoring', () => {
  const app = boot({
    aru_memory: JSON.stringify([{
      text: 'Earlier idea', time: Date.now(), weight: 'broken',
      tokens: [{bad: 'token'}], count: 'broken'
    }])
  });
  app.input('Earlier idea');
  assert.ok(Number.isFinite(app.field.coherence));
  assert.ok(app.field.lastTransition.terms.find(term => term.label === 'Prior memory overlap').value > 0);
  assert.equal(app.field.memory[0].count, 2);
});

test('saved v1 memory text is retokenized under current rules on reload', () => {
  const app = boot({aru_memory: JSON.stringify([{
    text: 'ＣＡＦÉ river', cleaned: 'caf river', tokens: ['caf', 'river'],
    time: Date.now(), weight: 2, count: 1
  }])});
  assert.equal(JSON.stringify(app.field.memory[0].tokens), '["café","river"]');
  assert.equal(app.field.memory[0].cleaned, 'café river');
  app.input('café river');
  const overlap = app.field.lastTransition.terms.find(term => term.label === 'Prior memory overlap').value;
  assert.ok(overlap > 0.09, `expected restored Unicode memory overlap; got ${overlap}`);
});

test('export includes entered text and reset removes only this app’s keys', async () => {
  const app = boot({unrelated_key: 'keep'});
  app.input('Private reminder');
  vm.runInContext('downloadState()', app.context);
  assert.equal(app.exports.length, 1);
  const data = JSON.parse(await app.exports[0].text());
  assert.equal(data.memory[0].text, 'Private reminder');
  assert.equal(data.messages[0].text, 'Private reminder');
  assert.equal(data.schema_version, 1);
  assert.equal(data.last_transition.memoryEffect, 0);
  assert.equal(data.last_transition.control.after, data.last_transition.after);
  assert.deepEqual(data.fact_claims, []);

  vm.runInContext('resetField()', app.context);
  assert.equal(app.window.reloaded, true);
  assert.equal(app.saved.get('unrelated_key'), 'keep');
  assert.equal(app.saved.has('aru_memory'), false);
  assert.equal(app.saved.has('aru_last_transition'), false);
  assert.equal(app.saved.has('aru_fact_claims'), false);
  assert.equal(app.saved.has('aru_fact_counter'), false);
  assert.equal(app.saved.has('aru_fact_ledger_v1'), false);
});

async function chooseStateFile(app, text) {
  const input = app.context.document.getElementById('state-import');
  input.files = [{size: Buffer.byteLength(text), text: async () => text}];
  input.value = 'aru-remembrance-field-state.json';
  await vm.runInContext('previewStateImport()', app.context);
}

test('full state backup restores score, history, and sourced facts across browsers', async () => {
  const origin = boot();
  origin.input('Café river');
  origin.fact('favorite color', 'teal');
  vm.runInContext('downloadState()', origin.context);
  const bundle = JSON.parse(await origin.exports[0].text());
  bundle.memory[0].tokens = ['poisoned'];
  bundle.memory[0].cleaned = 'poisoned';
  bundle.messages[1].text = '<img src=x onerror=alert(1)>';

  const target = boot({unrelated_key: 'keep'});
  target.input('Existing local work');
  target.fact('old fact', 'old value');
  await chooseStateFile(target, JSON.stringify(bundle));
  assert.equal(target.elements.get('state-import-apply').disabled, false);
  assert.match(target.elements.get('state-import-preview').textContent, /Incoming: μ/);
  vm.runInContext('applyStateImport()', target.context);
  assert.equal(target.window.reloaded, true);
  assert.equal(target.saved.get('unrelated_key'), 'keep');

  const restored = boot(Object.fromEntries(target.saved));
  assert.equal(restored.field.coherence, origin.field.coherence);
  assert.equal(restored.field.memory[0].text, 'Café river');
  assert.equal(restored.field.memory[0].cleaned, 'café river');
  assert.notDeepEqual([...restored.field.memory[0].tokens], ['poisoned']);
  assert.equal(restored.field.messages[0].text, 'Café river');
  assert.equal(restored.elements.get('messages').children[1].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(restored.elements.get('messages').children[1].innerHTML, '');
  assert.equal(restored.field.claims[0].value, 'teal');
  assert.equal(restored.field.claimCounter, origin.field.claimCounter);
  assert.equal(restored.saved.has('aru_fact_ledger_v1'), true);
  assert.equal(restored.field.lastProof, null);
  assert.equal(restored.field.lastTransition, null);
  restored.input('Café river');
  assert.ok(restored.field.lastTransition.terms.find(term => term.label === 'Prior memory overlap').value > 0);
});

test('invalid, duplicate, and oversized state files cannot overwrite local data', async () => {
  const app = boot();
  app.input('Keep this');
  vm.runInContext('downloadState()', app.context);
  const original = JSON.parse(await app.exports[0].text());
  const before = [...app.saved];
  const invalid = [
    '{bad',
    JSON.stringify({format: 'aru-evidence-ledger', version: 1, records: []}),
    JSON.stringify({...original, coherence: 42}),
    JSON.stringify({...original, memory: [{text: 'x', weight: 99, time: 0, count: 1}]}),
    JSON.stringify({...original, fact_claims: [{id: 1, key: 'a', value: 'x', time: 0, status: 'active'},
      {id: 1, key: 'b', value: 'y', time: 0, status: 'active'}], next_fact_id: 2}),
    ' '.repeat(4 * 1024 * 1024 + 1)
  ];
  for (const text of invalid) {
    await chooseStateFile(app, text);
    assert.equal(app.elements.get('state-import-apply').disabled, true);
    vm.runInContext('applyStateImport()', app.context);
    assert.deepEqual([...app.saved], before);
    assert.equal(app.window.reloaded, undefined);
  }
});

test('restore requires fresh preview after local change and honors cancellation', async () => {
  const source = boot();
  source.input('Backup value');
  vm.runInContext('downloadState()', source.context);
  const text = await source.exports[0].text();
  const target = boot();
  await chooseStateFile(target, text);
  target.input('A later local change');
  vm.runInContext('applyStateImport()', target.context);
  assert.match(target.elements.get('state-import-preview').textContent, /Local state changed/);
  assert.equal(target.elements.get('state-import-apply').disabled, true);
  assert.equal(target.window.reloaded, undefined);

  await chooseStateFile(target, text);
  target.window.confirm = () => false;
  vm.runInContext('applyStateImport()', target.context);
  assert.equal(target.window.reloaded, undefined);
  assert.equal(target.field.memory[0].text, 'A later local change');
});

test('a storage write failure rolls back every state key before reload', async () => {
  const source = boot();
  source.input('New memory');
  vm.runInContext('downloadState()', source.context);
  const target = boot({unrelated_key: 'keep'});
  target.input('Old memory');
  const before = [...target.saved];
  await chooseStateFile(target, await source.exports[0].text());
  const storage = target.context.localStorage;
  const write = storage.setItem;
  let failed = false;
  storage.setItem = (key, value) => {
    if (key === 'aru_messages' && !failed) { failed = true; throw new Error('quota'); }
    write(key, value);
  };
  vm.runInContext('applyStateImport()', target.context);
  assert.equal(failed, true);
  assert.deepEqual([...target.saved], before);
  assert.equal(target.window.reloaded, undefined);
  assert.match(target.elements.get('state-import-preview').textContent, /original local state was kept/);
});

test('session-only mode keeps new score, messages, proofs, and facts out of browser storage', async () => {
  const origin = boot();
  origin.input('Earlier saved memory');
  origin.fact('saved fact', 'blue');
  const app = boot(Object.fromEntries(origin.saved));
  const before = JSON.stringify([...app.saved]);
  vm.runInContext('toggleSessionOnly()', app.context);
  assert.equal(app.elements.get('session-toggle').getAttribute('aria-checked'), 'true');
  assert.match(app.elements.get('storage-status').textContent, /not saved/);
  app.input('Private session phrase');
  app.fact('session fact', 'amber');
  assert.equal(app.field.memory.some(m => m.text === 'Private session phrase'), true);
  assert.equal(app.field.claims.some(c => c.key === 'session fact'), true);
  assert.equal(app.field.lastProof.input, 'Private session phrase');
  assert.equal(JSON.stringify([...app.saved]), before);
  vm.runInContext('downloadState()', app.context);
  const explicitDownload = await app.exports[0].text();
  assert.match(explicitDownload, /Private session phrase/);

  app.window.confirm = () => false;
  vm.runInContext('toggleSessionOnly()', app.context);
  assert.equal(app.window.reloaded, undefined);
  assert.equal(app.elements.get('session-toggle').getAttribute('aria-checked'), 'true');
  app.window.confirm = () => true;
  vm.runInContext('toggleSessionOnly()', app.context);
  assert.equal(app.window.reloaded, true);
  const reopened = boot(Object.fromEntries(app.saved));
  assert.equal(reopened.field.memory.some(m => m.text === 'Private session phrase'), false);
  assert.equal(reopened.field.claims.some(c => c.key === 'session fact'), false);
  assert.equal(reopened.field.memory[0].text, 'Earlier saved memory');
  assert.equal(reopened.field.claims[0].value, 'blue');
  assert.equal(vm.runInContext('sessionOnly', reopened.context), false);
});

test('session-only mode blocks replacement of saved state even after a prior preview', async () => {
  const source = boot();
  source.input('Backup value');
  vm.runInContext('downloadState()', source.context);
  const app = boot();
  await chooseStateFile(app, await source.exports[0].text());
  assert.equal(app.elements.get('state-import-apply').disabled, false);
  vm.runInContext('toggleSessionOnly()', app.context);
  assert.equal(app.elements.get('state-import-apply').disabled, true);
  vm.runInContext('applyStateImport()', app.context);
  assert.equal(app.window.reloaded, undefined);
  assert.equal(app.saved.size, 0);
  await chooseStateFile(app, await source.exports[0].text());
  assert.match(app.elements.get('state-import-preview').textContent, /Leave session-only mode/);
  assert.equal(app.elements.get('state-import-apply').disabled, true);
});

test('session-only mode cannot start midway through a saving submission', () => {
  const app = boot();
  app.field.busy = true;
  vm.runInContext('toggleSessionOnly()', app.context);
  assert.equal(vm.runInContext('sessionOnly', app.context), false);
  assert.match(app.elements.get('session-mode').textContent, /Wait for the current submission/);
});
