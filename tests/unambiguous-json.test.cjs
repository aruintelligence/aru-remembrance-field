const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {parseUnambiguousJSON} = require('../tools/unambiguous-json.cjs');
const {auditEvidenceBatch, browserCaptureFromReport, transitionCaptureFromReports,
  sealedTransitionFromCapture, openingKeyBytes} = require('../tools/audit-evidence-batch.cjs');

const root = path.join(__dirname, '..');
const fixture = name => path.join(root, 'research', name);
const reference = fixture('example-evidence-reference-baseline.json');
const otherReference = fixture('example-evidence-reference-conflict.json');
const receipt = fixture('example-evidence-receipt.json');
const auditors = [[process.execPath, 'audit-evidence-batch.cjs'],
  ['python3', 'independent-evidence-batch.py']];

function temporary(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-unambiguous-json-'));
  const save = (name, contents) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
    return file;
  };
  try { return callback(save, dir); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
const run = (executable, script, flags) => spawnSync(executable,
  [path.join(root, 'tools', script), ...flags], {encoding: 'utf8'});

test('decoded duplicate names are rejected at every nesting level without false positives', () => {
  const valid = [
    '{"a":1,"b":2}',
    '{"items":[{"id":1},{"id":2}],"note":"\\\"id\\\":0 { x }"}',
    '{"a\\u0062":1,"ab2":2}',
    '[{"k":"braces {,} and escaped \\\"quotes\\\""},{"k":"second object"}]'
  ];
  for (const source of valid) assert.deepEqual(parseUnambiguousJSON(source), JSON.parse(source));
  for (const source of [
    '{"version":0,"version":1}',
    '{"\\u0076ersion":0,"version":1}',
    '{"nested":{"value":"first","value":"last"}}',
    '[{"id":1},{"id":2,"\\u0069d":3}]',
    '{"secret assertion":0,"secret assertion":1}'
  ]) {
    assert.throws(() => parseUnambiguousJSON(source), /Duplicate JSON object name/);
  }
  assert.throws(() => parseUnambiguousJSON('{'), SyntaxError);
  assert.throws(() => parseUnambiguousJSON('['.repeat(129) + '0' + ']'.repeat(129)),
    /nesting exceeds 128/);
});

test('a once-accepted ambiguous receipt now fails standalone and both batch verifiers', () => temporary(save => {
  const original = fs.readFileSync(receipt, 'utf8');
  const variants = [
    original.replace('"version": 1,', '"version": 0, "version": 1,'),
    original.replace('"version": 1,', '"\\u0076ersion": 0, "version": 1,'),
    original.replace('"value": "teal"', '"value": "amber", "value": "teal"')
  ];
  for (const [index, raw] of variants.entries()) {
    assert.deepEqual(JSON.parse(raw), JSON.parse(original), 'ordinary parsing hides the earlier member');
    const altered = save(`ambiguous-${index}.json`, raw);
    const standalone = run(process.execPath, 'verify-evidence-receipt.cjs', [altered, reference]);
    assert.equal(standalone.status, 1);
    assert.match(standalone.stderr, /duplicate JSON object name/);
    for (const [executable, script] of auditors) {
      const result = run(executable, script, [reference, altered]);
      assert.equal(result.status, 1, `${script}: ${result.stderr}`);
      assert.match(result.stdout, /0 MATCH, 0 DIFFER, 1 FAIL/);
      assert.doesNotMatch(result.stdout + result.stderr, /amber|secret assertion/);
    }
  }
  const clean = run(process.execPath, 'verify-evidence-receipt.cjs', [receipt, reference]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /MATCH: known/);
}));

test('ambiguous reference, checkpoint, capture, private key, and kit input fail closed', () => temporary((save, dir) => {
  const referenceRaw = fs.readFileSync(reference, 'utf8');
  const ambiguousReference = save('reference.json', referenceRaw.replace(
    '"next_source_id": 2', '"next_source_id": 9, "next_source_id": 2'));
  const checkpointRaw = fs.readFileSync(fixture('example-evidence-ledger-checkpoint.json'), 'utf8');
  const ambiguousCheckpoint = save('checkpoint.json', checkpointRaw.replace(
    '"version": 1', '"version": 0, "version": 1'));
  const captureRaw = fs.readFileSync(fixture('example-evidence-browser-batch-capture.json'), 'utf8');
  const ambiguousCapture = save('capture.json', captureRaw.replace(
    '"version": 3', '"version": 1, "version": 3'));
  const aReport = auditEvidenceBatch(reference, [receipt]);
  const bReport = auditEvidenceBatch(otherReference, [receipt]);
  const key = {format: 'aru-evidence-transition-opening-key', version: 1,
    key_hex: 'a'.repeat(64)};
  const privateCapture = save('private.json', sealedTransitionFromCapture(
    transitionCaptureFromReports(aReport, bReport), openingKeyBytes(key)));
  const ambiguousKey = save('key.json', JSON.stringify(key).replace(
    '"key_hex"', '"key_hex":"' + 'f'.repeat(64) + '","key_hex"'));
  assert.equal(JSON.parse(fs.readFileSync(ambiguousKey, 'utf8')).key_hex, key.key_hex);

  for (const [executable, script] of auditors) {
    for (const flags of [
      [ambiguousReference, receipt],
      [reference, receipt, '--checkpoint', ambiguousCheckpoint],
      [reference, receipt, '--check-capture', ambiguousCapture],
      [reference, receipt, '--reference-b', otherReference, '--check-sealed', privateCapture,
        '--opening-key', ambiguousKey]
    ]) {
      const result = run(executable, script, flags);
      assert.equal(result.status, 1, `${script} accepted ${flags.join(' ')}`);
      assert.match(result.stderr, /duplicate JSON object name/i);
    }
  }
  const kit = path.join(dir, 'rejected-kit');
  const rejected = run(process.execPath, 'verifier-kit.cjs', ['create', ambiguousCapture, kit]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /valid UTF-8 JSON|duplicate/i);
  assert.equal(fs.existsSync(kit), false);
  const cleanCapture = save('clean.json', browserCaptureFromReport(aReport));
  const created = run(process.execPath, 'verifier-kit.cjs', ['create', cleanCapture, kit]);
  assert.equal(created.status, 0, created.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(kit, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.length, 11);
  assert.ok(manifest.files.some(row => row.path === 'tools/unambiguous-json.cjs'));
}));
