const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { verifyProof, loadEvaluator } = require('../tools/verify-proof.cjs');
const { verifyTrajectory } = require('../tools/verify-trajectory.cjs');
const { verifyMemoryChallenge } = require('../tools/verify-memory-challenge.cjs');
const { verifyEvidenceReceipt } = require('../tools/verify-evidence-receipt.cjs');
const { verifyBlindTrial } = require('../tools/verify-blind-trial.cjs');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function boot(values = {}, options = {}) {
  const saved = new Map(Object.entries(values));
  const elements = new Map();
  const exports = [];
  const frames = new Map();
  let nextFrame = 1;
  let paintCalls = 0;
  const documentEvents = new Map();
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
  }
  const document = {
    body: new Element('body'),
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
    addEventListener() {}, confirm() { return true },
    matchMedia() { return motionPreference; },
    location: { reload() { window.reloaded = true; } }
  };
  const localStorage = {
    getItem(key) { return saved.has(key) ? saved.get(key) : null; },
    setItem(key, value) { saved.set(key, value); },
    removeItem(key) { saved.delete(key); }
  };
  const context = vm.createContext({
    document, window, localStorage, console, Blob, TextEncoder,
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
  assert.equal(proof.model_revision, 'aru-field-heuristics-2');
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

test('browser replays a shared v2 proof and a fresh positive history effect without changing local state', async () => {
  const visitor = boot({unrelated_key: 'keep'});
  visitor.fact('private fact', 'do not overwrite');
  const before = JSON.stringify([...visitor.saved]);
  const fixture = fs.readFileSync(path.join(__dirname, '..', 'research', 'example-proof-v2.json'), 'utf8');
  assert.match(await chooseScoreProofFile(visitor, fixture), /PASS: input “nevermore”.*With history μ 0.62624; no-history control μ 0.62624; immediate effect \+0.00000/);
  assert.equal(verifyProof(JSON.parse(fixture)).effect, 0);
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
  const proof = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-proof-v2.json'), 'utf8'));
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
  assert.match(await chooseScoreProofFile(app, legacy), /FAIL: Invalid proof: only current v2/);
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

test('v1 and v2 archived score receipts and trajectories verify under their own revisions', () => {
  const read = file => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', file), 'utf8'));
  assert.ok(verifyProof(read('example-proof.json')).effect > 0);
  assert.equal(verifyProof(read('example-proof-v2.json')).effect, 0);
  assert.equal(verifyTrajectory(read('example-trajectory.json')).steps, 5);
  assert.equal(verifyTrajectory(read('example-trajectory-v2.json')).steps, 3);
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
  assert.equal(app.elements.get('blind-vote').hidden, false);
  assert.equal(app.elements.get('blind-download').disabled, true);
  assert.equal(app.elements.get('blind-reveal').textContent, '');
  assert.equal(app.elements.get('blind-result').children[0].children.length, 2);
  assert.ok(report.conditions.with_history.score.after > report.conditions.without_history.score.after);
  const chosen = report.assignment.A === 'with_history' ? 'A' : 'B';
  vm.runInContext(`rateBlindTrial('${chosen}')`, app.context);
  assert.equal(report.choice, chosen);
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

test('three-control challenge shows positive, zero, and negative effects without changing saved state', async () => {
  const app = boot();
  app.input('My private local memory');
  app.fact('private fact', 'private value');
  const before = JSON.stringify([...app.saved]);
  vm.runInContext('runMemoryChallenge()', app.context);
  assert.match(app.elements.get('challenge-result').children[0].textContent, /3\/3 controls/);
  assert.equal(app.elements.get('challenge-download').disabled, false);
  const rows = app.elements.get('challenge-result').children[1].children[0].children[1].children;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.children[5].textContent), ['Expected', 'Expected', 'Expected']);
  assert.equal(JSON.stringify([...app.saved]), before);
  vm.runInContext('downloadMemoryChallenge()', app.context);
  const report = JSON.parse(await app.exports[0].text());
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-memory-challenge.json'), 'utf8'));
  assert.deepEqual(report, fixture);
  const results = verifyMemoryChallenge(report);
  assert.deepEqual(results.map(row => row.direction), ['positive', 'zero', 'negative']);
  assert.equal(JSON.stringify(report).includes('private value'), false);
  assert.equal(JSON.stringify(report).includes('My private local memory'), false);
});

test('challenge verifier rejects altered outputs, missing controls, relabeling, and swapped inputs', () => {
  const report = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-memory-challenge.json'), 'utf8'));
  assert.equal(verifyMemoryChallenge(report).length, 3);
  const altered = structuredClone(report);
  altered.scenarios[0].trajectory.steps[1].actual.after += 0.01;
  assert.throws(() => verifyMemoryChallenge(altered), /step 2 with history\.after/);
  const missing = structuredClone(report);
  missing.scenarios.pop();
  assert.throws(() => verifyMemoryChallenge(missing), /exactly three/);
  const relabeled = structuredClone(report);
  relabeled.scenarios[2].expected_direction = 'positive';
  assert.throws(() => verifyMemoryChallenge(relabeled), /fixed contradiction sequence/);
  const changed = structuredClone(report);
  changed.scenarios[1].trajectory.inputs = ['violet river', 'violet river'];
  assert.throws(() => verifyMemoryChallenge(changed), /fixed unrelated sequence/);
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
  let finishFirst;
  input.files = [{size: 2, text: () => new Promise(resolve => { finishFirst = resolve; })}];
  const first = vm.runInContext('verifyEvidenceFile()', app.context);
  assert.match(await chooseReceiptFile(app, '{}'), /FAIL: Unsupported format/);
  finishFirst('{}');
  await first;
  assert.match(app.elements.get('receipt-verification').textContent, /FAIL: Unsupported format/);
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

test('saved v1 memory text is retokenized under v2 on reload', () => {
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
