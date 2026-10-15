const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { verifyProof } = require('../tools/verify-proof.cjs');

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
  assert.equal(target.field.claims.length, 2);
  assert.equal(target.field.claims[1].id, 2);
  assert.equal(target.field.claims[1].imported, true);
  assert.equal(target.field.coherence, 0.64);
  assert.equal(target.field.memory.length, 0);
  assert.equal(vm.runInContext('lookupFact("favorite color").kind', target.context), 'conflict');
  const reloaded = boot(Object.fromEntries(target.saved));
  assert.equal(vm.runInContext('lookupFact("favorite color").kind', reloaded.context), 'conflict');
  assert.match(reloaded.elements.get('ledger-entries').children[0].children[1].textContent, /imported assertion/);
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
