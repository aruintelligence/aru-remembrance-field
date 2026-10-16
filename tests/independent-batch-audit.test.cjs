const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {browserCaptureFromReport} = require('../tools/audit-evidence-batch.cjs');

const root = path.join(__dirname, '..');
const nodeTool = path.join(root, 'tools', 'audit-evidence-batch.cjs');
const pythonTool = path.join(root, 'tools', 'independent-evidence-batch.py');
const fixture = name => path.join(root, 'research', name);
const digest = data => createHash('sha256').update(data).digest('hex');

function temporary(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-independent-batch-'));
  const save = (name, data) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    return file;
  };
  try { return callback(save); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

function both(reference, files, checkpoint) {
  const args = [reference, ...files, ...(checkpoint ? ['--checkpoint', checkpoint] : []), '--json'];
  const js = spawnSync(process.execPath, [nodeTool, ...args], {encoding: 'utf8'});
  const py = spawnSync('python3', [pythonTool, ...args], {encoding: 'utf8'});
  assert.equal(py.status, js.status, `Node: ${js.stderr}\nPython: ${py.stderr}`);
  const left = JSON.parse(js.stdout);
  const right = JSON.parse(py.stdout);
  assert.deepEqual(right.receipts, left.receipts);
  assert.deepEqual(right.totals, left.totals);
  for (const key of ['reference_sha256', 'checkpoint_sha256']) assert.equal(right[key], left[key]);
  return {js: left, py: right};
}

test('Python independently reproduces the shipped v2 and legacy v1 captures', () => {
  const reference = fixture('example-evidence-reference-baseline.json');
  const checkpoint = fixture('example-evidence-ledger-checkpoint.json');
  const files = [fixture('example-evidence-excerpt.json'), fixture('example-evidence-receipt.json')];
  const {js, py} = both(reference, files, checkpoint);
  assert.deepEqual(py.totals, {match: 2, differ: 0, fail: 0, identical_copies: 0});
  assert.equal(py.browser_script_sha256, browserCaptureFromReport(js).browser_script_sha256);
  for (const name of ['example-evidence-browser-batch-capture.json',
                       'example-evidence-browser-batch-capture-v1.json']) {
    const replay = spawnSync('python3', [pythonTool, reference, ...files, '--checkpoint', checkpoint,
      '--check-capture', fixture(name)], {encoding: 'utf8'});
    assert.equal(replay.status, 0, replay.stderr);
    assert.match(replay.stdout, /CAPTURE MATCH/);
  }
});

test('separate implementations agree on omissions, altered citations, replay failures, bytes and repeats', () => temporary(save => {
  const records = [
    {id: 1, key: 'city', value: 'Portland', time: 1700000000001, status: 'active'},
    {id: 2, key: 'CITY', value: 'Denver', time: 1700000000002, status: 'active'},
    {id: 3, key: 'favorite color', value: 'teal', time: 1700000000003, status: 'active'},
    {id: 4, key: 'plan', value: 'old', time: 1700000000004, status: 'superseded'}
  ];
  const baseline = save('baseline.json', JSON.stringify({format: 'aru-evidence-ledger-baseline',
    version: 1, records, next_source_id: 5}));
  const question = (text, snapshot, answer) => ({format: 'aru-evidence-question-receipt',
    version: 1, model_revision: 'aru-evidence-questions-1', question: text,
    records: snapshot, answer});
  const excerpt = (text, snapshot, answer) => ({...question(text, snapshot, answer),
    format: 'aru-evidence-answer-excerpt', scope: 'cited-assertions-only'});
  const full = question('What is city?', records, {kind: 'conflict', sources: [1, 2]});
  const color = excerpt('What is my favorite color?', [records[2]],
    {kind: 'known', value: 'teal', sources: [3]});
  const colorBytes = JSON.stringify(color);
  const brief = {format: 'aru-evidence-brief-receipt', version: 1,
    model_revision: 'aru-evidence-briefs-1', names: ['city', 'favorite color', 'plan', 'pet'],
    records, results: [
      {name: 'city', answer: {kind: 'conflict', sources: [1, 2]}},
      {name: 'favorite color', answer: {kind: 'known', value: 'teal', sources: [3]}},
      {name: 'plan', answer: {kind: 'historical', sources: [4]}},
      {name: 'pet', answer: {kind: 'missing'}}
    ]};
  const contents = [JSON.stringify(full), colorBytes,
    JSON.stringify(excerpt('What is city?', [records[0]],
      {kind: 'known', value: 'Portland', sources: [1]})),
    JSON.stringify(excerpt('What is my favorite color?', [{...records[2], value: 'amber'}],
      {kind: 'known', value: 'amber', sources: [3]})),
    JSON.stringify(question('What is city?', [...records].reverse(),
      {kind: 'conflict', sources: [2, 1]})),
    JSON.stringify({...color, answer: {kind: 'known', value: 'purple', sources: [3]}}),
    JSON.stringify({format: 'aru-evidence-correction-receipt'}), '{', Buffer.from([0xff, 0xfe]),
    colorBytes, JSON.stringify(color, null, 2), JSON.stringify(brief),
    JSON.stringify({...brief, results: [...brief.results.slice(0, 3),
      {name: 'pet', answer: {kind: 'known', value: 'invented', sources: [3]}}]}),
    JSON.stringify(question('Who knows city?', records, {kind: 'unsupported'})),
    JSON.stringify({format: []})];
  const files = contents.map((content, index) => save(`receipt-${index}.json`, content));
  const {js, py} = both(baseline, files);
  assert.deepEqual(js.receipts.map(row => row.verdict),
    ['MATCH', 'MATCH', 'DIFFER', 'DIFFER', 'DIFFER', 'FAIL', 'FAIL', 'FAIL',
      'FAIL', 'MATCH', 'MATCH', 'MATCH', 'FAIL', 'MATCH', 'FAIL']);
  assert.equal(js.receipts[9].duplicate_of, 2);
  assert.equal(js.receipts[10].duplicate_of, null);
  assert.equal(py.receipts[8].sha256, digest(Buffer.from([0xff, 0xfe])));
  assert.deepEqual(py.totals, {match: 6, differ: 3, fail: 6, identical_copies: 1});
  assert.doesNotMatch(JSON.stringify(py), /Portland|Denver|teal|fabricated/);
  const capture = save('capture.json', JSON.stringify(browserCaptureFromReport(js)));
  const args = [pythonTool, baseline, ...files, '--check-capture', capture];
  const pass = spawnSync('python3', args, {encoding: 'utf8'});
  assert.equal(pass.status, 0, pass.stderr);
  const changed = save('changed-script.json', JSON.stringify({...browserCaptureFromReport(js),
    browser_script_sha256: '0'.repeat(64)}));
  const fail = spawnSync('python3', [...args.slice(0, -1), changed], {encoding: 'utf8'});
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /capture differs/);
  fs.appendFileSync(files[0], '\n');
  const changedBytes = spawnSync('python3', args, {encoding: 'utf8'});
  assert.equal(changedBytes.status, 1);
  assert.match(changedBytes.stderr, /capture differs/);
}));

test('a changed checkpoint stops the Python audit before receipt files are opened', () => temporary(save => {
  const checkpoint = JSON.parse(fs.readFileSync(fixture('example-evidence-ledger-checkpoint.json')));
  checkpoint.sha256 = '0'.repeat(64);
  const changed = save('checkpoint.json', JSON.stringify(checkpoint));
  const missing = path.join(os.tmpdir(), 'aru-independent-no-such-receipt.json');
  const run = spawnSync('python3', [pythonTool, fixture('example-evidence-reference-baseline.json'),
    missing, '--checkpoint', changed], {encoding: 'utf8'});
  assert.equal(run.status, 1);
  assert.match(run.stderr, /checkpoint differs/);
  assert.doesNotMatch(run.stderr, /No such file/);
}));

test('Python refuses oversized or nonregular receipt files before reporting a partial batch', () => temporary(save => {
  const baseline = fixture('example-evidence-reference-baseline.json');
  const good = fixture('example-evidence-excerpt.json');
  const huge = save('huge.json', ' '.repeat(1024 * 1024 + 1));
  for (const invalid of [huge, path.dirname(huge)]) {
    const run = spawnSync('python3', [pythonTool, baseline, good, invalid, '--json'],
      {encoding: 'utf8'});
    assert.equal(run.status, 1);
    assert.match(run.stderr, /regular file of at most 1 MiB/);
    assert.equal(run.stdout, '');
  }
}));

test('varying normalized names, statuses and citations agree across both auditors', () => temporary(save => {
  for (let index = 0; index < 24; index++) {
    const name = index % 2 ? 'ＣＩＴＹ' : 'city';
    const first = {id: 1, key: 'city', value: index % 3 ? 'Portland' : 'Denver',
      time: 1700000000001, status: 'active'};
    const second = {id: 2, key: name, value: index % 4 ? 'Denver' : first.value,
      time: 1700000000002, status: index % 3 ? 'active' : 'superseded'};
    const color = {id: 3, key: 'favorite color', value: 'teal',
      time: 1700000000003, status: 'active'};
    const records = [first, second, color];
    const active = second.status === 'active' ? [first, second] : [first];
    const city = new Set(active.map(row => row.value)).size > 1
      ? {kind: 'conflict', sources: active.map(row => row.id)}
      : {kind: 'known', value: first.value, sources: active.map(row => row.id)};
    const question = (snapshot, result) => ({format: 'aru-evidence-question-receipt',
      version: 1, model_revision: 'aru-evidence-questions-1', question: 'What is city?',
      records: snapshot, answer: result});
    const colorExcerpt = {format: 'aru-evidence-answer-excerpt', version: 1,
      model_revision: 'aru-evidence-questions-1', scope: 'cited-assertions-only',
      question: 'What is my favorite color?', records: [color],
      answer: {kind: 'known', value: 'teal', sources: [3]}};
    const cityExcerpt = {format: 'aru-evidence-answer-excerpt', version: 1,
      model_revision: 'aru-evidence-questions-1', scope: 'cited-assertions-only',
      question: 'What is city?', records: [first],
      answer: {kind: 'known', value: first.value, sources: [1]}};
    const reordered = [color, second, first];
    const reversedActive = second.status === 'active' ? [second, first] : [first];
    const reverseResult = new Set(reversedActive.map(row => row.value)).size > 1
      ? {kind: 'conflict', sources: reversedActive.map(row => row.id)}
      : {kind: 'known', value: first.value, sources: reversedActive.map(row => row.id)};
    const reference = save(`baseline-${index}.json`, JSON.stringify({
      format: 'aru-evidence-ledger-baseline', version: 1, records, next_source_id: 4}));
    const items = [question(records, city), colorExcerpt, cityExcerpt,
      question(records, {kind: 'known', value: 'fabricated', sources: [1]}),
      question(reordered, reverseResult)];
    const files = items.map((item, row) => save(`case-${index}-${row}.json`, JSON.stringify(item)));
    const {js} = both(reference, files);
    assert.deepEqual(js.receipts.map(row => row.verdict),
      ['MATCH', 'MATCH', second.status === 'active' ? 'DIFFER' : 'MATCH', 'FAIL', 'DIFFER']);
  }
}));
