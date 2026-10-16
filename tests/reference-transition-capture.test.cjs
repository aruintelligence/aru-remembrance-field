const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {auditEvidenceBatch, transitionCaptureFromReports} = require('../tools/audit-evidence-batch.cjs');

const root = path.join(__dirname, '..');
const fixture = name => path.join(root, 'research', name);
const a = fixture('example-evidence-reference-baseline.json');
const b = fixture('example-evidence-reference-conflict.json');
const checkpoint = fixture('example-evidence-ledger-checkpoint.json');
const receipts = [fixture('example-evidence-excerpt.json'), fixture('example-evidence-receipt.json')];
const captureFile = fixture('example-evidence-reference-transition-capture.json');
const auditors = [
  {name: 'Node', executable: process.execPath, tool: path.join(root, 'tools/audit-evidence-batch.cjs')},
  {name: 'Python', executable: 'python3', tool: path.join(root, 'tools/independent-evidence-batch.py')}
];
const args = (referenceB = b, items = receipts, saved = captureFile) =>
  [a, ...items, '--checkpoint', checkpoint, '--reference-b', referenceB,
    '--check-transition', saved];
const invoke = (auditor, flags) => spawnSync(auditor.executable, [auditor.tool, ...flags],
  {encoding: 'utf8'});

function temporary(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-transition-capture-'));
  const save = (name, data) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    return file;
  };
  try { return callback(save); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('a browser-compatible paired capture is reproduced by Node and independent Python', () => {
  const expected = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
  const produced = transitionCaptureFromReports(auditEvidenceBatch(a, receipts, {checkpointFile: checkpoint}),
    auditEvidenceBatch(b, receipts));
  assert.deepEqual(produced, expected);
  assert.deepEqual(expected.changed_receipts, [1, 2]);
  assert.deepEqual(expected.capture_a.totals, {match: 2, differ: 0, fail: 0, identical_copies: 0});
  assert.deepEqual(expected.capture_b.totals, {match: 0, differ: 2, fail: 0, identical_copies: 0});
  assert.equal(expected.capture_a.browser_script_sha256, expected.capture_b.browser_script_sha256);
  assert.equal(expected.capture_a.receipts[0].sha256,
    createHash('sha256').update(fs.readFileSync(receipts[0])).digest('hex'));
  assert.doesNotMatch(JSON.stringify(expected), /favorite color|teal|amber|example-evidence/);
  for (const auditor of auditors) {
    const verified = invoke(auditor, args());
    assert.equal(verified.status, 0, `${auditor.name}: ${verified.stderr}`);
    assert.match(verified.stdout, /A: 2 MATCH, 0 DIFFER, 0 FAIL.*B: 0 MATCH, 2 DIFFER, 0 FAIL.*2 changed receipt verdicts.*TRANSITION CAPTURE MATCH/s);
    const ordinary = invoke(auditor, args().slice(0, -2));
    assert.equal(ordinary.status, 1, `${auditor.name}: ordinary audit must expose DIFFER`);
  }
});

test('tampering, extra fields, missing or reordered inputs, and a legacy nested capture are refused', () => temporary(save => {
  const original = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
  const altered = [
    {...original, changed_receipts: []},
    {...original, capture_b: {...original.capture_b, totals: {...original.capture_b.totals, match: 2}}},
    {...original, capture_a: {...original.capture_a, browser_script_sha256: '0'.repeat(64)}},
    {...original, capture_b: {...original.capture_b, receipts: [
      {...original.capture_b.receipts[0], verdict: 'MATCH'}, original.capture_b.receipts[1]]}},
    {...original, capture_a: {...original.capture_a, version: 1}},
    {...original, private_value: 'should not be accepted'}
  ];
  for (const [index, candidate] of altered.entries()) {
    const changed = save(`changed-${index}.json`, JSON.stringify(candidate));
    for (const auditor of auditors) {
      const run = invoke(auditor, args(b, receipts, changed));
      assert.equal(run.status, 1, `${auditor.name}: altered #${index}`);
      assert.match(run.stderr, /transition capture differs|Saved transition capture differs/i);
    }
  }
  const spaced = save('same-result-different-bytes.json', fs.readFileSync(receipts[0], 'utf8') + '\n');
  for (const auditor of auditors) {
    for (const changedFiles of [[receipts[1], receipts[0]], [receipts[0]], [spaced, receipts[1]]]) {
      const run = invoke(auditor, args(b, changedFiles));
      assert.equal(run.status, 1, `${auditor.name}: changed input set`);
      assert.match(run.stderr, /transition capture differs|Saved transition capture differs/i);
    }
  }
}));

test('a recorded FAIL can replay without being called a successful evidence audit', () => temporary(save => {
  const malformed = save('malformed.json', '{');
  const selected = [receipts[0], malformed, receipts[0]];
  const capture = transitionCaptureFromReports(
    auditEvidenceBatch(a, selected, {checkpointFile: checkpoint}), auditEvidenceBatch(b, selected));
  assert.deepEqual(capture.capture_a.totals, {match: 2, differ: 0, fail: 1, identical_copies: 1});
  assert.deepEqual(capture.capture_b.totals, {match: 0, differ: 2, fail: 1, identical_copies: 1});
  assert.deepEqual(capture.changed_receipts, [1, 3]);
  const saved = save('mixed.json', JSON.stringify(capture));
  for (const auditor of auditors) {
    const run = invoke(auditor, args(b, selected, saved));
    assert.equal(run.status, 0, `${auditor.name}: ${run.stderr}`);
    assert.match(run.stdout, /A: 2 MATCH, 0 DIFFER, 1 FAIL.*B: 0 MATCH, 2 DIFFER, 1 FAIL.*TRANSITION CAPTURE MATCH/s);
    assert.match(run.stdout, /Inspect A and B counts independently/i);
    const badCheckpoint = save('changed-checkpoint.json', JSON.stringify({
      ...JSON.parse(fs.readFileSync(checkpoint, 'utf8')), sha256: '0'.repeat(64)}));
    const mismatch = invoke(auditor, [a, ...selected, '--checkpoint', badCheckpoint,
      '--reference-b', b, '--check-transition', saved]);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /checkpoint differs/i);
  }
}));

test('malformed transition files and invalid option combinations fail closed', () => temporary(save => {
  const invalid = save('invalid.json', '{');
  for (const auditor of auditors) {
    assert.equal(invoke(auditor, args(b, receipts, invalid)).status, 1);
    assert.equal(invoke(auditor, [a, ...receipts, '--check-transition', captureFile]).status, 1);
    assert.equal(invoke(auditor, [a, ...receipts, '--checkpoint-b', checkpoint]).status, 1);
    assert.equal(invoke(auditor, [a, ...receipts, '--reference-b', b,
      '--check-capture', fixture('example-evidence-browser-batch-capture.json')]).status, 1);
  }
}));
