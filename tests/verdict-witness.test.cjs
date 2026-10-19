const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {loadModel} = require('../tools/benchmark-evidence.cjs');
const {auditEvidenceBatch, transitionCaptureFromReports, verdictAdditionWitness,
  explainTransitionAdditions} = require('../tools/audit-evidence-batch.cjs');

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
const full = records => ({format: 'aru-evidence-question-receipt', version: 1,
  model_revision: 'aru-evidence-questions-1', question: 'What is color?', records,
  answer: model.resolve('What is color?', records)});
const excerpt = records => ({...full(records), format: 'aru-evidence-answer-excerpt',
  scope: 'cited-assertions-only'});

function temporary(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-verdict-witness-'));
  const save = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  try { callback(save); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('three surfaces separate the answer from the actual verdict and find bounded minimum sets', () => temporary(save => {
  const color = record(1, 'color', 'private teal');
  const city = record(2, 'city', 'private Portland');
  const genre = record(3, 'genre', 'private jazz');
  const amber = record(2, 'color', 'private amber');
  const green = record(3, 'color', 'private green');
  const cases = [
    {name: 'full-unrelated', a: [color], b: [color, city], receipt: full([color]),
      verdicts: ['MATCH', 'DIFFER'], answerStatus: 'unchanged',
      expected: {status: 'witness', minimum_size: 1, sets: [[2]], total_sets: 1, tested_subsets: 1}},
    {name: 'full-completion', a: [color], b: [color, city, genre],
      receipt: full([color, city, genre]), verdicts: ['DIFFER', 'MATCH'],
      expected: {status: 'witness', minimum_size: 2, sets: [[2, 3]], total_sets: 1, tested_subsets: 3}},
    {name: 'excerpt-conflict', a: [color], b: [color, amber, green],
      receipt: excerpt([color]), verdicts: ['MATCH', 'DIFFER'],
      expected: {status: 'witness', minimum_size: 1, sets: [[2], [3]], total_sets: 2, tested_subsets: 2}},
    {name: 'excerpt-unrelated', a: [color], b: [color, city],
      receipt: excerpt([color]), verdicts: ['MATCH', 'MATCH'],
      expected: {status: 'unchanged'}},
    {name: 'edit', a: [color], b: [{...color, value: 'private amber'}],
      receipt: full([color]), verdicts: ['MATCH', 'DIFFER'],
      expected: {status: 'unavailable', reason: 'not-addition-only'}},
    {name: 'removed', a: [color, city], b: [color], receipt: full([color, city]),
      verdicts: ['MATCH', 'DIFFER'], expected: {status: 'unavailable', reason: 'not-addition-only'}},
    {name: 'reordered', a: [color, city], b: [city, color], receipt: full([color, city]),
      verdicts: ['MATCH', 'DIFFER'], expected: {status: 'unavailable', reason: 'not-addition-only'}},
    {name: 'seven-additions', a: [color], b: [color, ...Array.from({length: 7}, (_, i) =>
      record(i + 2, 'city', `private ${i}`))], receipt: full([color]),
      verdicts: ['MATCH', 'DIFFER'], expected: {status: 'unavailable', reason: 'too-many-additions'}},
    {name: 'four-ties', a: [color], b: [color, ...Array.from({length: 4}, (_, i) =>
      record(i + 2, 'city', `private ${i}`))], receipt: full([color]),
      verdicts: ['MATCH', 'DIFFER'], expected: {status: 'witness', minimum_size: 1,
        sets: [[2], [3], [4]], total_sets: 4, tested_subsets: 4}},
    {name: 'malformed', a: [color], b: [color, city], receipt: '{',
      verdicts: ['FAIL', 'FAIL'], expected: {status: 'unavailable', reason: 'receipt-failed'}},
    {name: 'forged-answer', a: [color], b: [color, city],
      receipt: {...full([color]), answer: {kind: 'known', value: 'private forged', sources: [1]}},
      verdicts: ['FAIL', 'FAIL'], expected: {status: 'unavailable', reason: 'receipt-failed'}}
  ];
  for (const item of cases) {
    const aFile = save(`${item.name}-a.json`, baseline(item.a));
    const bFile = save(`${item.name}-b.json`, baseline(item.b));
    const receiptFile = save(`${item.name}-receipt.json`, item.receipt);
    const aReport = auditEvidenceBatch(aFile, [receiptFile]);
    const bReport = auditEvidenceBatch(bFile, [receiptFile]);
    const capture = save(`${item.name}-capture.json`,
      transitionCaptureFromReports(aReport, bReport));
    assert.deepEqual([aReport.receipts[0].verdict, bReport.receipts[0].verdict], item.verdicts);
    if (typeof item.receipt !== 'string' && item.name !== 'forged-answer') {
      assert.deepEqual(verdictAdditionWitness(baseline(item.a), baseline(item.b),
        item.receipt, model), item.expected, item.name);
    }
    for (const [executable, script] of scripts) {
      const run = spawnSync(executable, [script, aFile, receiptFile, '--reference-b', bFile,
        '--check-transition', capture, '--explain-additions', '--explain-verdicts', '--json'],
      {encoding: 'utf8'});
      assert.equal(run.status, 0, `${item.name} ${script}: ${run.stderr}`);
      const output = JSON.parse(run.stdout);
      assert.deepEqual(output.verdict_influence, [{index: 1, ...item.expected}], item.name);
      assert.equal(output.transition.capture_b.receipts[0].verdict, item.verdicts[1]);
      if (item.answerStatus) assert.equal(output.answer_influence[0].status, item.answerStatus);
      assert.doesNotMatch(JSON.stringify(output.verdict_influence), /private|Portland|teal|amber|jazz/);
    }
  }
}));

test('explanation refuses changed files, unpaired input, and tampered capture or script fingerprint', () => temporary(save => {
  const color = record(1, 'color', 'private teal');
  const city = record(2, 'city', 'private Portland');
  const before = save('a.json', baseline([color]));
  const after = save('b.json', baseline([color, city]));
  const receipt = save('receipt.json', full([color]));
  const aReport = auditEvidenceBatch(before, [receipt]);
  const bReport = auditEvidenceBatch(after, [receipt]);
  const capture = transitionCaptureFromReports(aReport, bReport);
  assert.deepEqual(explainTransitionAdditions(before, after, [receipt], aReport, bReport,
    {verdict: true})[0], {index: 1, status: 'witness', minimum_size: 1,
    sets: [[2]], total_sets: 1, tested_subsets: 1});
  for (const field of ['model_sha256', 'verifier_sha256', 'auditor_sha256']) {
    assert.throws(() => explainTransitionAdditions(before, after, [receipt],
      {...aReport, [field]: '0'.repeat(64)}, bReport, {verdict: true}), /changed/);
  }
  const saved = save('capture.json', capture);
  const legacy = save('legacy-transition.json', transitionCaptureFromReports(aReport, bReport, 1));
  const second = save('second-receipt.json', excerpt([color]));
  const ordered = save('ordered-transition.json', transitionCaptureFromReports(
    auditEvidenceBatch(before, [receipt, second]), auditEvidenceBatch(after, [receipt, second])));
  const mutated = JSON.parse(JSON.stringify(capture));
  mutated.capture_a.browser_script_sha256 = '0'.repeat(64);
  const changedScript = save('changed-script.json', mutated);
  mutated.capture_a.browser_script_sha256 = capture.capture_a.browser_script_sha256;
  mutated.capture_b.receipts[0].verdict = 'MATCH';
  const changedVerdict = save('changed-verdict.json', mutated);
  for (const [executable, script] of scripts) {
    const base = [script, before, receipt, '--reference-b', after, '--explain-verdicts'];
    assert.equal(spawnSync(executable, [script, before, receipt, '--explain-verdicts'],
      {encoding: 'utf8'}).status, 1);
    for (const tampered of [changedScript, changedVerdict]) {
      const run = spawnSync(executable, [...base, '--check-transition', tampered],
        {encoding: 'utf8'});
      assert.equal(run.status, 1, `${script}: ${run.stdout}`);
      assert.doesNotMatch(run.stdout, /verdict witness:/);
    }
    assert.equal(spawnSync(executable, [...base, '--check-transition', saved],
      {encoding: 'utf8'}).status, 0);
    const older = spawnSync(executable, [...base, '--check-transition', legacy, '--json'],
      {encoding: 'utf8'});
    assert.equal(older.status, 0, older.stderr);
    assert.equal(JSON.parse(older.stdout).transition.version, 1);
    assert.deepEqual(JSON.parse(older.stdout).verdict_influence[0].sets, [[2]]);
    const reordered = spawnSync(executable, [script, before, second, receipt,
      '--reference-b', after, '--check-transition', ordered, '--explain-verdicts'],
    {encoding: 'utf8'});
    assert.equal(reordered.status, 1, `${script}: a reordered receipt list must not replay`);
    assert.doesNotMatch(reordered.stdout, /verdict witness:/);
    assert.equal(spawnSync(executable, [script, before,
      path.join(os.tmpdir(), `aru-missing-receipt-${process.pid}.json`), receipt,
      '--reference-b', after, '--check-transition', saved, '--explain-verdicts'],
    {encoding: 'utf8'}).status, 1);
  }
  fs.appendFileSync(after, '\n');
  assert.throws(() => explainTransitionAdditions(before, after, [receipt], aReport, bReport,
    {verdict: true}), /Reference bytes changed/);
  fs.writeFileSync(after, JSON.stringify(baseline([color, city])));
  fs.appendFileSync(receipt, '\n');
  assert.throws(() => explainTransitionAdditions(before, after, [receipt], aReport, bReport,
    {verdict: true}), /Receipt bytes changed/);
}));
