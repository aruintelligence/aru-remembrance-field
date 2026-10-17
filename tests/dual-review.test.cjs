const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {auditEvidenceBatch, transitionCaptureFromReports, sealedTransitionFromCapture,
  openingKeyBytes} = require('../tools/audit-evidence-batch.cjs');
const {review} = require('../tools/review-evidence.cjs');

const root = path.join(__dirname, '..');
const file = name => path.join(root, 'research', name);
const tool = path.join(root, 'tools', 'review-evidence.cjs');
const nodeAuditor = path.join(root, 'tools', 'audit-evidence-batch.cjs');
const reference = file('example-evidence-reference-baseline.json');
const referenceB = file('example-evidence-reference-conflict.json');
const checkpoint = file('example-evidence-ledger-checkpoint.json');
const receipts = [file('example-evidence-excerpt.json'), file('example-evidence-receipt.json')];
const capture = file('example-evidence-browser-batch-capture.json');
const transition = file('example-evidence-reference-transition-capture.json');
const singleArgs = [reference, ...receipts, '--checkpoint', checkpoint, '--check-capture', capture];
const pairArgs = [reference, ...receipts, '--checkpoint', checkpoint, '--reference-b', referenceB,
  '--check-transition', transition];

function run(args) {
  return spawnSync(process.execPath, [tool, ...args, '--json'], {encoding: 'utf8'});
}
function temporary(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-dual-review-'));
  const save = (name, data) => {
    const target = path.join(dir, name);
    fs.writeFileSync(target, data);
    return target;
  };
  try { return callback(save, dir); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('two auditors distinguish a reproduced capture from its receipt verdicts', () => {
  const single = run(singleArgs);
  assert.equal(single.status, 0, single.stderr);
  const one = JSON.parse(single.stdout);
  assert.equal(one.replay, 'MATCH');
  assert.equal(one.receipt_assessment, 'all_receipts_match');
  assert.deepEqual(one.auditors, {node: 'matched', python: 'matched'});
  assert.equal(one.capture_sha256, createHash('sha256').update(fs.readFileSync(capture)).digest('hex'));
  assert.equal(one.script_binding, 'matched');
  assert.equal(one.checkpoint_selection, true);

  const pair = run(pairArgs);
  assert.equal(pair.status, 0, pair.stderr);
  const two = JSON.parse(pair.stdout);
  assert.equal(two.replay, 'MATCH');
  assert.deepEqual(two.receipt_assessment,
    {a: 'all_receipts_match', b: 'recorded_differences'});
  assert.equal(two.totals.b.differ, 2);
  assert.deepEqual(two.changed_receipt_positions, [1, 2]);
  assert.deepEqual(two.checkpoint_selection, {a: true, b: false});
  assert.deepEqual(two.not_established,
    ['authorship', 'independent_custody', 'completeness', 'factual_truth']);
  assert.doesNotMatch(pair.stdout, /favorite color|teal|amber|example-evidence|key_hex|reference_sha256/);
});

test('recorded FAIL and repeats survive a dual match without becoming a clean assessment', () => temporary(save => {
  const malformed = save('bad.json', '{');
  const selected = [receipts[0], malformed, receipts[0]];
  const saved = save('capture.json', JSON.stringify(transitionCaptureFromReports(
    auditEvidenceBatch(reference, selected, {checkpointFile: checkpoint}),
    auditEvidenceBatch(referenceB, selected))));
  const result = run([reference, ...selected, '--checkpoint', checkpoint,
    '--reference-b', referenceB, '--check-transition', saved]);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.replay, 'MATCH');
  assert.equal(value.receipt_assessment.a, 'recorded_failures');
  assert.equal(value.receipt_assessment.b, 'recorded_failures');
  assert.equal(value.totals.a.fail, 1);
  assert.equal(value.totals.b.identical_copies, 1);
}));

test('private capture works with its separate key and fails closed with the wrong one', () => temporary(save => {
  const ordinary = transitionCaptureFromReports(auditEvidenceBatch(reference, receipts),
    auditEvidenceBatch(referenceB, receipts));
  const key = {format: 'aru-evidence-transition-opening-key', version: 1,
    key_hex: '49'.repeat(32)};
  const sealed = save('private.json', JSON.stringify(sealedTransitionFromCapture(ordinary,
    openingKeyBytes(key))));
  const opening = save('opening.json', JSON.stringify(key));
  const args = [reference, ...receipts, '--reference-b', referenceB,
    '--check-sealed', sealed, '--opening-key', opening];
  const good = run(args);
  assert.equal(good.status, 0, good.stderr);
  const value = JSON.parse(good.stdout);
  assert.equal(value.capture_kind, 'private_transition');
  assert.equal(value.receipt_assessment.b, 'recorded_differences');
  assert.doesNotMatch(good.stdout, /key_hex|494949|reference_a_commitment/);
  const wrong = save('wrong-key.json', JSON.stringify({...key, key_hex: '50'.repeat(32)}));
  const rejected = run([...args.slice(0, -1), wrong]);
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stdout).replay, 'UNCONFIRMED');
  assert.equal(JSON.parse(rejected.stdout).reason, 'auditor_rejected');
}));

test('legacy capture is explicitly unpinned, never promoted to a script-bound result', () => {
  const result = run([reference, ...receipts, '--checkpoint', checkpoint,
    '--check-capture', file('example-evidence-browser-batch-capture-v1.json')]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).script_binding, 'unavailable_legacy_v1');
});

test('tampering, swapped or missing files, a changed script, and ambiguous input do not issue an assessment', () => temporary(save => {
  const original = JSON.parse(fs.readFileSync(transition, 'utf8'));
  const tampered = save('tampered.json', JSON.stringify({...original,
    capture_b: {...original.capture_b, browser_script_sha256: '0'.repeat(64)}}));
  const ambiguous = save('ambiguous.json', '{"format": 1, "format": 2}');
  const mutated = save('same-verdict-different-bytes.json', fs.readFileSync(receipts[0]) + '\n');
  const cases = [
    [reference, receipts[1], receipts[0], '--checkpoint', checkpoint,
      '--reference-b', referenceB, '--check-transition', transition],
    [reference, receipts[0], '--checkpoint', checkpoint,
      '--reference-b', referenceB, '--check-transition', transition],
    [reference, mutated, receipts[1], '--checkpoint', checkpoint,
      '--reference-b', referenceB, '--check-transition', transition],
    [...pairArgs.slice(0, -1), tampered]
  ];
  for (const args of cases) {
    const result = run(args);
    assert.equal(result.status, 1, result.stdout);
    const value = JSON.parse(result.stdout);
    assert.equal(value.replay, 'UNCONFIRMED');
    assert.equal(value.reason, 'auditor_rejected');
    assert.equal(Object.hasOwn(value, 'totals'), false);
  }
  const bad = run([...pairArgs.slice(0, -1), ambiguous]);
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /not unambiguous UTF-8 JSON/);
}));

test('a disagreeing or missing checker cannot yield a positive review', () => temporary((save, dir) => {
  const falseReport = JSON.parse(fs.readFileSync(transition, 'utf8'));
  falseReport.capture_b.totals.match = 2;
  const liar = save('liar.cjs', `console.log(${JSON.stringify(JSON.stringify(falseReport))});\n`);
  const disagreement = review(pairArgs, [[process.execPath, nodeAuditor], [process.execPath, liar]]);
  assert.deepEqual({replay: disagreement.replay, reason: disagreement.reason},
    {replay: 'UNCONFIRMED', reason: 'auditor_disagreement'});
  const missing = review(pairArgs, [[process.execPath, nodeAuditor],
    [path.join(dir, 'no-interpreter'), liar]]);
  assert.equal(missing.replay, 'UNCONFIRMED');
  assert.equal(missing.auditors.python, 'rejected');
}));

test('a capture changed between checker runs cannot yield a positive review', () => temporary(save => {
  const changing = save('capture.json', fs.readFileSync(capture));
  const modifier = save('modifier.cjs',
    `require('node:fs').appendFileSync(${JSON.stringify(changing)}, '\\n');\nconsole.log('{}');\n`);
  const result = review([...singleArgs.slice(0, -1), changing],
    [[process.execPath, nodeAuditor], [process.execPath, modifier]]);
  assert.equal(result.replay, 'UNCONFIRMED');
  assert.equal(result.reason, 'capture_changed');
  assert.equal(Object.hasOwn(result, 'totals'), false);
}));

test('bad options and malformed capture fail before a positive result', () => temporary(save => {
  const malformed = save('malformed.json', '{');
  for (const args of [singleArgs.slice(0, -2),
    [...singleArgs, '--check-transition', transition],
    [reference, ...receipts, '--reference-b', referenceB, '--check-sealed', transition],
    [...pairArgs.slice(0, -1), malformed]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /"replay": "MATCH"/);
  }
}));
