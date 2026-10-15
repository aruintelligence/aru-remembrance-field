const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { verifyProof } = require('../tools/verify-proof.cjs');
const { verifyTrajectory } = require('../tools/verify-trajectory.cjs');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function boot(values = {}) {
  const saved = new Map(Object.entries(values));
  const elements = new Map();
  const exports = [];
  const canvasContext = { setTransform() {}, fillRect() {}, fillStyle: '' };
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
    getContext() { return canvasContext; }
    click() { this.clicked = true; }
  }
  const document = {
    body: new Element('body'),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element(id));
      return elements.get(id);
    },
    createElement(tag) { return new Element(tag); }
  };
  const window = {
    innerWidth: 72, innerHeight: 72, devicePixelRatio: 1,
    addEventListener() {}, confirm() { return true },
    location: { reload() { window.reloaded = true; } }
  };
  const localStorage = {
    getItem(key) { return saved.has(key) ? saved.get(key) : null; },
    setItem(key, value) { saved.set(key, value); },
    removeItem(key) { saved.delete(key); }
  };
  const context = vm.createContext({
    document, window, localStorage, console, Blob,
    URL: {
      createObjectURL(blob) { exports.push(blob); return 'blob:test-export'; },
      revokeObjectURL() {}
    },
    requestAnimationFrame() {}, setInterval() {},
    setTimeout(callback) { callback(); }
  });
  vm.runInContext(source, context);
  return {
    context, saved, elements, exports, window,
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
  assert.equal(proof.model_revision, 'aru-field-heuristics-1');
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
