const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {auditEvidenceBatch, transitionCaptureFromReports, sealedTransitionFromCapture,
  openingKeyBytes} = require('../tools/audit-evidence-batch.cjs');

const root = path.join(__dirname, '..');
const fixture = name => path.join(root, 'research', name);
const a = fixture('example-evidence-reference-baseline.json');
const b = fixture('example-evidence-reference-conflict.json');
const checkpoint = fixture('example-evidence-ledger-checkpoint.json');
const receipts = [fixture('example-evidence-excerpt.json'), fixture('example-evidence-receipt.json')];
const auditors = [[process.execPath, 'audit-evidence-batch.cjs'],
  ['python3', 'independent-evidence-batch.py']];
const key = {format: 'aru-evidence-transition-opening-key', version: 1,
  key_hex: Array.from({length: 32}, (_, i) => i.toString(16).padStart(2, '0')).join('')};

function temporary(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-sealed-transition-'));
  const save = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  try { return callback(save, dir); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
const run = ([executable, script], args, cwd = root) => spawnSync(executable,
  [path.join(cwd, 'tools', script), ...args], {encoding: 'utf8'});
const args = (capture, opening, selected = receipts, referenceB = b, aCheckpoint = checkpoint) =>
  [a, ...selected, ...(aCheckpoint ? ['--checkpoint', aCheckpoint] : []),
    '--reference-b', referenceB, '--check-sealed', capture, '--opening-key', opening];
const transition = (items = receipts) => transitionCaptureFromReports(
  auditEvidenceBatch(a, items, {checkpointFile: checkpoint}), auditEvidenceBatch(b, items));

test('two independent auditors replay keyed commitments; fresh keys do not expose raw file hashes', () => temporary((save, dir) => {
  const ordinary = transition();
  const privateCapture = sealedTransitionFromCapture(ordinary, openingKeyBytes(key));
  const otherKey = {...key, key_hex: 'f'.repeat(64)};
  const second = sealedTransitionFromCapture(ordinary, openingKeyBytes(otherKey));
  assert.notDeepEqual(privateCapture, second);
  assert.deepEqual(privateCapture.changed_receipts, [1, 2]);
  assert.deepEqual(privateCapture.totals_b, {match: 0, differ: 2, fail: 0, identical_copies: 0});
  assert.doesNotMatch(JSON.stringify(privateCapture), new RegExp(ordinary.capture_a.reference_sha256));
  assert.doesNotMatch(JSON.stringify(privateCapture), new RegExp(ordinary.capture_a.receipts[0].sha256));
  assert.equal(Object.hasOwn(privateCapture, 'key_hex'), false);
  const capture = save('private.json', privateCapture);
  const opening = save('opening.json', key);
  for (const auditor of auditors) {
    const checked = run(auditor, args(capture, opening));
    assert.equal(checked.status, 0, `${auditor[1]}: ${checked.stderr}`);
    assert.match(checked.stdout, /A: 2 MATCH, 0 DIFFER, 0 FAIL.*B: 0 MATCH, 2 DIFFER, 0 FAIL.*SEALED TRANSITION MATCH/s);
    const json = run(auditor, [...args(capture, opening), '--json']);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), privateCapture);
    assert.doesNotMatch(json.stdout, new RegExp(ordinary.capture_a.reference_sha256));
  }
  const kit = path.join(dir, 'kit');
  const makeKit = spawnSync(process.execPath,
    [path.join(root, 'tools/verifier-kit.cjs'), 'create', capture, kit], {encoding: 'utf8'});
  assert.equal(makeKit.status, 0, makeKit.stderr);
  assert.equal(fs.existsSync(path.join(kit, 'opening.json')), false);
  assert.equal(fs.existsSync(path.join(kit, 'private.json')), false);
  assert.equal(spawnSync(process.execPath,
    [path.join(kit, 'tools/verifier-kit.cjs'), 'check', kit, capture]).status, 0);
  for (const auditor of auditors) {
    const archived = run(auditor, args(capture, opening), kit);
    assert.equal(archived.status, 0, `${auditor[1]} in kit: ${archived.stderr}`);
  }
}));

test('wrong key, tampering, bytes, order, checkpoint, legacy, and malformed inputs fail closed', () => temporary(save => {
  const ordinary = transition();
  const privateCapture = sealedTransitionFromCapture(ordinary, openingKeyBytes(key));
  const capture = save('private.json', privateCapture);
  const opening = save('opening.json', key);
  const wrong = save('wrong.json', {...key, key_hex: 'f'.repeat(64)});
  const badKeys = [wrong, save('short.json', {...key, key_hex: '00'}),
    save('extra.json', {...key, extra: true}), save('legacy-key.json', {...key, version: 0}),
    save('malformed-key.json', '{')];
  const altered = [
    {...privateCapture, browser_script_sha256: '0'.repeat(64)},
    {...privateCapture, reference_a_commitment: '0'.repeat(64)},
    {...privateCapture, checkpoint_a_commitment: null},
    {...privateCapture, receipts: privateCapture.receipts.slice(1)},
    {...privateCapture, receipts: privateCapture.receipts.map((row, i) =>
      i ? row : {...row, commitment: '0'.repeat(64)})},
    {...privateCapture, receipts: privateCapture.receipts.map((row, i) =>
      i ? row : {...row, verdict_b: 'MATCH'})},
    {...privateCapture, totals_b: {...privateCapture.totals_b, fail: 2}},
    {...privateCapture, changed_receipts: []},
    {...privateCapture, unexpected: 'private claim'},
    ordinary,
    {...privateCapture, version: 2}
  ];
  const badCaptures = altered.map((value, index) => save(`changed-${index}.json`, value));
  badCaptures.push(save('malformed-capture.json', '{'));
  const changedBytes = save('receipt-with-space.json', fs.readFileSync(receipts[0], 'utf8') + '\n');
  const changedReference = save('modified-reference.json', fs.readFileSync(b, 'utf8') + '\n');
  const changedCheckpoint = save('modified-checkpoint.json', fs.readFileSync(checkpoint, 'utf8') + '\n');
  for (const auditor of auditors) {
    for (const candidate of badKeys) {
      const result = run(auditor, args(capture, candidate));
      assert.equal(result.status, 1, `${auditor[1]} accepted key ${candidate}`);
      assert.doesNotMatch(result.stdout + result.stderr, /favorite color|teal|amber/);
    }
    for (const candidate of badCaptures) {
      assert.equal(run(auditor, args(candidate, opening)).status, 1,
        `${auditor[1]} accepted capture ${candidate}`);
    }
    for (const flags of [args(capture, opening, [receipts[1], receipts[0]]),
      args(capture, opening, [receipts[0]]),
      args(capture, opening, [changedBytes, receipts[1]]),
      args(capture, opening, receipts, changedReference),
      args(capture, opening, receipts, b, changedCheckpoint),
      [a, ...receipts, '--reference-b', b, '--check-sealed', capture],
      [a, ...receipts, '--reference-b', b, '--opening-key', opening],
      [...args(capture, opening), '--check-transition', save('ordinary.json', ordinary)]]) {
      assert.equal(run(auditor, flags).status, 1, `${auditor[1]} accepted altered inputs`);
    }
  }
}));

test('a private match can faithfully record failure, repeats, and no verified truth', () => temporary(save => {
  const malformed = save('malformed.json', '{');
  const selected = [receipts[0], malformed, receipts[0]];
  const capture = sealedTransitionFromCapture(transition(selected), openingKeyBytes(key));
  assert.deepEqual(capture.receipts.map(row => row.duplicate_of), [null, null, 1]);
  assert.equal(capture.totals_a.fail, 1);
  assert.equal(capture.totals_b.differ, 2);
  for (const auditor of auditors) {
    const result = run(auditor, args(save('mixed.json', capture), save('key.json', key), selected));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 FAIL.*SEALED TRANSITION MATCH/s);
    assert.match(result.stdout, /does not prove origin, completeness, or factual truth/);
  }
}));
