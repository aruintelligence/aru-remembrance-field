const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {loadModel} = require('../tools/benchmark-evidence.cjs');
const {auditEvidenceBatch, browserCaptureFromReport} = require('../tools/audit-evidence-batch.cjs');
const {review} = require('../tools/review-evidence.cjs');
const {challenge, FIXED} = require('../tools/challenge-multisource-evidence.cjs');

const root = path.join(__dirname, '..');
const example = name => path.join(root, 'research', `example-runtime-${name}.json`);
const args = [example('reference'), example('receipt'), '--check-capture', example('capture')];

function temporary(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-runtime-'));
  const save = (name, data) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
    return file;
  };
  try { return callback(save, dir); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('a matching capture is withheld when the selected name normalizes differently', () => {
  const nodeAuditor = spawnSync(process.execPath,
    [path.join(root, 'tools', 'audit-evidence-batch.cjs'), ...args, '--json'],
    {encoding:'utf8'});
  const pythonAuditor = spawnSync('python3',
    [path.join(root, 'tools', 'independent-evidence-batch.py'), ...args, '--json'],
    {encoding:'utf8'});
  assert.equal(nodeAuditor.status, 0, nodeAuditor.stderr);
  assert.equal(pythonAuditor.status, 0, pythonAuditor.stderr);
  assert.equal(JSON.parse(nodeAuditor.stdout).totals.match, 1);
  assert.equal(JSON.parse(pythonAuditor.stdout).totals.match, 1);

  const pythonProbe = spawnSync('python3', [path.join(root, 'tools', 'probe-normalization.py')],
    {input:JSON.stringify({strings:['\ua7f1']}), encoding:'utf8'});
  assert.equal(pythonProbe.status, 0, pythonProbe.stderr);
  const pythonKey = JSON.parse(pythonProbe.stdout).normalized[0];
  const nodeKey = loadModel().normalize('\ua7f1');
  const result = review(args);
  if (nodeKey !== pythonKey) {
    assert.equal(result.replay, 'UNCONFIRMED');
    assert.equal(result.reason, 'normalization_disagreement');
    assert.equal(Object.hasOwn(result, 'receipt_assessment'), false);
  } else {
    // A runtime with matching selected-name semantics may replay this fixture;
    // no capture version pins the original browser's Unicode runtime.
    assert.equal(result.replay, 'MATCH');
    assert.equal(result.selected_name_normalization, 'node_python_match');
    assert.equal(result.browser_runtime_normalization, 'not_recorded_in_capture');
  }
});

test('ordinary review labels its selected-name match and unbound browser runtime', () => {
  const file = name => path.join(root, 'research', name);
  const result = review([file('example-boundary-reference.json'),
    file('example-boundary-receipt.json'), '--check-capture',
    file('example-boundary-capture.json')]);
  assert.equal(result.replay, 'MATCH');
  assert.equal(result.selected_name_normalization, 'node_python_match');
  assert.equal(result.browser_runtime_normalization, 'not_recorded_in_capture');
});

test('a recorded FAIL remains reproducible when its malformed field exceeds the name bound', () => temporary(save => {
  const reference = save('reference.json', fs.readFileSync(
    path.join(root, 'research', 'example-boundary-reference.json'), 'utf8'));
  const bad = JSON.parse(fs.readFileSync(
    path.join(root, 'research', 'example-boundary-receipt.json'), 'utf8'));
  bad.records[0].key = 'x'.repeat(1000);
  const receipt = save('bad-receipt.json', bad);
  const report = auditEvidenceBatch(reference, [receipt]);
  assert.equal(report.receipts[0].verdict, 'FAIL');
  const capture = save('capture.json', browserCaptureFromReport(report));
  const result = review([reference, receipt, '--check-capture', capture]);
  assert.equal(result.replay, 'MATCH');
  assert.equal(result.receipt_assessment, 'recorded_failures');
}));

test('an original file changed during review cannot retain a positive result', () => temporary(save => {
  const reference = save('reference.json', fs.readFileSync(example('reference'), 'utf8'));
  const receipt = save('receipt.json', fs.readFileSync(example('receipt'), 'utf8'));
  const capture = save('capture.json', browserCaptureFromReport(
    auditEvidenceBatch(reference, [receipt])));
  const modifier = save('modifier.cjs', `const fs=require('node:fs');\n` +
    `const {spawnSync}=require('node:child_process');\n` +
    `const report=spawnSync('python3',[${JSON.stringify(path.join(root, 'tools', 'independent-evidence-batch.py'))},...process.argv.slice(2)],{encoding:'utf8'});\n` +
    `fs.appendFileSync(${JSON.stringify(receipt)},'\\n');\n` +
    `process.stdout.write(report.stdout);\n`);
  const result = review([reference, receipt, '--check-capture', capture], [
    [process.execPath, path.join(root, 'tools', 'audit-evidence-batch.cjs')],
    [process.execPath, modifier]
  ]);
  assert.equal(result.replay, 'UNCONFIRMED');
  assert.equal(result.reason, 'inputs_changed');
}));

test('multi-record challenge covers every refusal and answer branch', () => {
  assert.equal(FIXED.length, 21);
  for (const seed of [20261017, 1, 4294967295]) {
    const runs = seed === 20261017 ? 500 : 2000;
    const result = challenge({seed, runs});
    assert.equal(result.passed, true, JSON.stringify(result.first_disagreement));
    assert.equal(result.runs_completed, runs);
    assert.equal(result.fixed_cases, 21);
    for (const count of Object.values(result.coverage)) assert(count > 0);
  }
});

test('an intentionally wrong Python probe yields the exact first counterexample', () => temporary((save, dir) => {
  fs.copyFileSync(path.join(root, 'tools', 'independent-evidence-batch.py'),
    path.join(dir, 'independent-evidence-batch.py'));
  const worker = save('faulty.py', 'import json,sys\n' +
    'cases=json.load(sys.stdin)["cases"]\n' +
    'print(json.dumps({"results":[{"valid":True,"answer":{"kind":"known"}} for _ in cases]}))\n');
  const result = challenge({runs:100, worker});
  assert.equal(result.passed, false);
  assert.equal(result.first_disagreement.case_index, 0);
  assert.equal(result.first_disagreement.label, 'empty-ledger');
  assert.equal(result.first_disagreement.browser.answer.kind, 'missing');
  assert.equal(result.first_disagreement.python.answer.kind, 'known');
}));
