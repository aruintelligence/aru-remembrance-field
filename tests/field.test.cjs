const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

  vm.runInContext('resetField()', app.context);
  assert.equal(app.window.reloaded, true);
  assert.equal(app.saved.get('unrelated_key'), 'keep');
  assert.equal(app.saved.has('aru_memory'), false);
  assert.equal(app.saved.has('aru_last_transition'), false);
});
