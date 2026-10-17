const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {loadModel} = require('../tools/benchmark-evidence.cjs');
const {auditEvidenceBatch, transitionCaptureFromReports, additionWitness,
  explainTransitionAdditions} =
  require('../tools/audit-evidence-batch.cjs');

const root = path.join(__dirname, '..');
const scripts = [
  [process.execPath, path.join(root, 'tools/audit-evidence-batch.cjs')],
  ['python3', path.join(root, 'tools/independent-evidence-batch.py')]
];
const model = loadModel();
const record = (id, key, value) => ({id, key, value, time: 1700000000000 + id,
  status: 'active', imported: false});
const baseline = records => ({format: 'aru-evidence-ledger-baseline', version: 1, records,
  next_source_id: Math.max(0, ...records.map(item => item.id)) + 1});

function temporary(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-addition-witness-'));
  const save = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  try { callback(save); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('independent checkers agree on exact minimum sets, abstentions, and full receipt scope', () => temporary(save => {
  const color = record(1, 'color', 'secret teal');
  const amber = record(2, 'color', 'secret amber');
  const green = record(3, 'color', 'secret green');
  const makeQuestion = (question, records) => ({format: 'aru-evidence-question-receipt',
    version: 1, model_revision: 'aru-evidence-questions-1', question, records,
    answer: model.resolve(question, records)});
  const cases = [
    {name: 'pair', a: [], b: [color, amber], receipt: makeQuestion('What is color?', []),
      expected: {status: 'witness', minimum_size: 2, sets: [[1, 2]], total_sets: 1, tested_subsets: 3}},
    {name: 'ties', a: [record(1, 'my color', 'secret teal')],
      b: [record(1, 'my color', 'secret teal'), amber, green],
      receipt: makeQuestion('What is my color?', [record(1, 'my color', 'secret teal')]),
      expected: {status: 'witness', minimum_size: 1, sets: [[2], [3]], total_sets: 2, tested_subsets: 2}},
    {name: 'bounded-ties', a: [record(1, 'my color', 'secret teal')],
      b: [record(1, 'my color', 'secret teal'), ...[2, 3, 4, 5].map(id =>
        record(id, 'color', `secret value ${id}`))],
      receipt: makeQuestion('What is my color?', [record(1, 'my color', 'secret teal')]),
      expected: {status: 'witness', minimum_size: 1, sets: [[2], [3], [4]],
        total_sets: 4, tested_subsets: 4}},
    {name: 'unchanged', a: [color], b: [color, record(2, 'city', 'secret Portland')],
      receipt: makeQuestion('What is color?', [color]), expected: {status: 'unchanged'}},
    {name: 'edit', a: [color], b: [{...color, value: 'secret amber'}],
      receipt: makeQuestion('What is color?', [color]),
      expected: {status: 'unavailable', reason: 'not-addition-only'}},
    {name: 'deletion', a: [color], b: [], receipt: makeQuestion('What is color?', [color]),
      expected: {status: 'unavailable', reason: 'not-addition-only'}},
    {name: 'reorder', a: [color, amber], b: [amber, color],
      receipt: makeQuestion('What is color?', [color, amber]),
      expected: {status: 'unavailable', reason: 'not-addition-only'}},
    {name: 'bound', a: [], b: Array.from({length: 7}, (_, i) =>
      record(i + 1, 'color', 'secret teal')), receipt: makeQuestion('What is color?', []),
      expected: {status: 'unavailable', reason: 'too-many-additions'}},
    {name: 'brief', a: [color], b: [color, record(2, 'city', 'secret Portland')],
      receipt: {format: 'aru-evidence-brief-receipt', version: 1,
        model_revision: 'aru-evidence-briefs-1', names: ['color', 'city'], records: [color],
        results: model.brief(['color', 'city'], [color])},
      expected: {status: 'witness', minimum_size: 1, sets: [[2]], total_sets: 1, tested_subsets: 1}},
    {name: 'invalid', a: [color], b: [color, amber], receipt: '{',
      expected: {status: 'unavailable', reason: 'receipt-failed'}}
  ];
  for (const item of cases) {
    const aFile = save(`${item.name}-a.json`, baseline(item.a));
    const bFile = save(`${item.name}-b.json`, baseline(item.b));
    const receiptFile = save(`${item.name}-receipt.json`, item.receipt);
    const aReport = auditEvidenceBatch(aFile, [receiptFile]);
    const bReport = auditEvidenceBatch(bFile, [receiptFile]);
    const captureFile = save(`${item.name}-capture.json`,
      transitionCaptureFromReports(aReport, bReport));
    if (item.name !== 'invalid') {
      assert.deepEqual(additionWitness(baseline(item.a), baseline(item.b), item.receipt, model),
        item.expected, item.name);
    }
    for (const [executable, script] of scripts) {
      const args = [script, aFile, receiptFile, '--reference-b', bFile,
        '--check-transition', captureFile, '--explain-additions', '--json'];
      const run = spawnSync(executable, args, {encoding: 'utf8'});
      assert.equal(run.status, 0, `${item.name} ${script}: ${run.stderr}`);
      const output = JSON.parse(run.stdout);
      assert.deepEqual(output.answer_influence, [{index: 1, ...item.expected}], item.name);
      assert.equal(output.transition.format, 'aru-evidence-reference-transition-capture');
      assert.doesNotMatch(JSON.stringify(output.answer_influence), /secret|Portland|teal|amber|green/);
    }
  }
}));

test('the added-source flag needs two references and retains explicit DIFFER/FAIL counts', () => {
  const a = path.join(root, 'research/example-evidence-reference-baseline.json');
  const b = path.join(root, 'research/example-evidence-reference-conflict.json');
  const receipt = path.join(root, 'research/example-evidence-excerpt.json');
  for (const [executable, script] of scripts) {
    const missing = spawnSync(executable, [script, a, receipt, '--explain-additions'],
      {encoding: 'utf8'});
    assert.equal(missing.status, 1);
    const explained = spawnSync(executable, [script, a, receipt, '--reference-b', b,
      '--explain-additions'], {encoding: 'utf8'});
    assert.equal(explained.status, 1, `${script}: a B DIFFER remains nonzero without capture replay`);
    assert.match(explained.stdout, /A: 1 MATCH, 0 DIFFER, 0 FAIL.*B: 0 MATCH, 1 DIFFER, 0 FAIL.*#1 answer witness.*#2/s);
  }
});

test('answer analysis refuses a separately changed input or answer model after the audit', () => temporary(save => {
  const color = record(1, 'color', 'teal');
  const before = save('a.json', baseline([color]));
  const after = save('b.json', baseline([color, record(2, 'color', 'amber')]));
  const receipt = save('receipt.json', {format: 'aru-evidence-question-receipt', version: 1,
    model_revision: 'aru-evidence-questions-1', question: 'What is color?',
    records: [color], answer: model.resolve('What is color?', [color])});
  const aReport = auditEvidenceBatch(before, [receipt]);
  const bReport = auditEvidenceBatch(after, [receipt]);
  assert.deepEqual(explainTransitionAdditions(before, after, [receipt], aReport, bReport)[0],
    {index: 1, status: 'witness', minimum_size: 1, sets: [[2]],
      total_sets: 1, tested_subsets: 1});
  assert.throws(() => explainTransitionAdditions(before, after, [receipt],
    {...aReport, model_sha256: '0'.repeat(64)}, bReport), /model changed/);
  fs.appendFileSync(receipt, '\n');
  assert.throws(() => explainTransitionAdditions(before, after, [receipt], aReport, bReport),
    /Receipt bytes changed/);
  fs.writeFileSync(receipt, JSON.stringify({format: 'aru-evidence-question-receipt'}));
  fs.appendFileSync(after, '\n');
  assert.throws(() => explainTransitionAdditions(before, after, [receipt], aReport, bReport),
    /Reference bytes changed/);
}));
