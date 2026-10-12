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

  vm.runInContext('resetField()', app.context);
  assert.equal(app.window.reloaded, true);
  assert.equal(app.saved.get('unrelated_key'), 'keep');
  assert.equal(app.saved.has('aru_memory'), false);
  assert.equal(app.saved.has('aru_last_transition'), false);
});
