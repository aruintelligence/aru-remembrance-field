const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {auditEvidenceBatch, browserCaptureFromReport} = require('../tools/audit-evidence-batch.cjs');

const root = path.join(__dirname, '..');
const cli = path.join(root, 'tools', 'audit-evidence-batch.cjs');
const fixture = name => path.join(root, 'research', name);
const baseline = fixture('example-evidence-reference-baseline.json');
const checkpoint = fixture('example-evidence-ledger-checkpoint.json');
const excerpt = fixture('example-evidence-excerpt.json');
const full = fixture('example-evidence-receipt.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function temporary(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-batch-audit-'));
  const save = (name, contents) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, contents);
    return file;
  };
  try { return callback(save); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('matching fixtures produce a private, byte-bound report with an independently checked checkpoint', () => {
  const report = auditEvidenceBatch(baseline, [excerpt, full, excerpt], {checkpointFile: checkpoint});
  assert.equal(report.format, 'aru-evidence-batch-audit');
  assert.equal(report.version, 1);
  assert.deepEqual(report.totals, {match: 3, differ: 0, fail: 0, identical_copies: 1});
  assert.deepEqual(report.receipts.map(row => [row.verdict, row.reason, row.duplicate_of]),
    [['MATCH', null, null], ['MATCH', null, null], ['MATCH', null, 1]]);
  assert.equal(report.receipts[0].sha256, digest(fs.readFileSync(excerpt)));
  assert.equal(report.reference_sha256, digest(fs.readFileSync(baseline)));
  assert.equal(report.checkpoint_sha256, digest(fs.readFileSync(checkpoint)));
  for (const key of ['model_sha256', 'verifier_sha256', 'auditor_sha256']) {
    assert.match(report[key], /^[0-9a-f]{64}$/);
  }
  assert.doesNotMatch(JSON.stringify(report), /favorite color|teal|example-evidence|\/tmp\//);
});

test('audit separates omitted reference conflicts, malformed input, unsupported formats, and failed replay', () => temporary(save => {
  const reference = JSON.parse(fs.readFileSync(baseline, 'utf8'));
  const answer = JSON.parse(fs.readFileSync(excerpt, 'utf8'));
  reference.records.push({...reference.records[0], id: 2, value: 'amber', time: 1700000000001});
  reference.next_source_id = 3;
  const conflicted = save('conflicted.json', JSON.stringify(reference));
  const broken = save('broken.json', '{');
  const unsupported = save('correction.json', JSON.stringify({format: 'aru-evidence-correction-receipt'}));
  const tampered = save('tampered.json', JSON.stringify({...answer,
    answer: {...answer.answer, value: 'purple'}}));
  const report = auditEvidenceBatch(conflicted, [excerpt, broken, unsupported, tampered, excerpt]);
  assert.deepEqual(report.receipts.map(row => [row.verdict, row.reason, row.duplicate_of]), [
    ['DIFFER', 'reference-mismatch', null],
    ['FAIL', 'invalid-json', null],
    ['FAIL', 'unsupported-format', null],
    ['FAIL', 'replay-failed', null],
    ['DIFFER', 'reference-mismatch', 1]
  ]);
  assert.deepEqual(report.totals, {match: 0, differ: 2, fail: 3, identical_copies: 1});
}));

test('a changed checkpoint or invalid reference stops before receipt files are read', () => temporary(save => {
  const altered = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
  altered.sha256 = '0'.repeat(64);
  const changed = save('changed-checkpoint.json', JSON.stringify(altered));
  const absentReceipt = path.join(os.tmpdir(), 'aru-no-such-answer-receipt.json');
  assert.throws(() => auditEvidenceBatch(baseline, [absentReceipt], {checkpointFile: changed}),
    /checkpoint differs/);
  const invalid = save('invalid-reference.json', JSON.stringify({...JSON.parse(fs.readFileSync(baseline, 'utf8')),
    next_source_id: 1}));
  assert.throws(() => auditEvidenceBatch(invalid, [absentReceipt]), /next source ID/);
  assert.throws(() => auditEvidenceBatch(baseline, [excerpt], {checkpointFile: save('null.json', 'null')}),
    /unsupported checkpoint/);
}));

test('CLI report can be reproduced, and a changed byte fails even when the verdict stays MATCH', () => temporary(save => {
  const emitted = spawnSync(process.execPath, [cli, baseline, excerpt, full, '--checkpoint', checkpoint, '--json'],
    {encoding: 'utf8'});
  assert.equal(emitted.status, 0, emitted.stderr);
  const report = JSON.parse(emitted.stdout);
  const savedReport = save('report.json', emitted.stdout);
  const replay = spawnSync(process.execPath,
    [cli, baseline, excerpt, full, '--checkpoint', checkpoint, '--check-report', savedReport],
    {encoding: 'utf8'});
  assert.equal(replay.status, 0, replay.stderr);
  assert.match(replay.stdout, /REPORT MATCH/);
  const reordered = spawnSync(process.execPath,
    [cli, baseline, full, excerpt, '--checkpoint', checkpoint, '--check-report', savedReport],
    {encoding: 'utf8'});
  assert.equal(reordered.status, 1);
  assert.match(reordered.stderr, /Saved report differs/);

  const changedReceipt = save('same-answer-new-spacing.json', fs.readFileSync(excerpt, 'utf8') + '\n');
  const changed = spawnSync(process.execPath,
    [cli, baseline, changedReceipt, full, '--checkpoint', checkpoint, '--check-report', savedReport],
    {encoding: 'utf8'});
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /Saved report differs/);
  assert.equal(auditEvidenceBatch(baseline, [changedReceipt]).totals.match, 1);

  report.auditor_sha256 = '0'.repeat(64);
  const forgedReport = save('forged-report.json', JSON.stringify(report));
  const forged = spawnSync(process.execPath,
    [cli, baseline, excerpt, full, '--checkpoint', checkpoint, '--check-report', forgedReport],
    {encoding: 'utf8'});
  assert.equal(forged.status, 1);
  assert.match(forged.stderr, /Saved report differs/);
}));

test('CLI reports differences with nonzero status but can reproduce that exact report', () => temporary(save => {
  const invalid = save('invalid.json', '{');
  const run = spawnSync(process.execPath, [cli, baseline, excerpt, invalid, '--json'], {encoding: 'utf8'});
  assert.equal(run.status, 1);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.totals, {match: 1, differ: 0, fail: 1, identical_copies: 0});
  const recorded = save('recorded.json', run.stdout);
  const reproduced = spawnSync(process.execPath,
    [cli, baseline, excerpt, invalid, '--check-report', recorded], {encoding: 'utf8'});
  assert.equal(reproduced.status, 0, reproduced.stderr);
  assert.match(reproduced.stdout, /1 FAIL.*REPORT MATCH/s);
}));

test('CLI replays a minimal browser capture and rejects added fields or altered verdicts', () => temporary(save => {
  const report = auditEvidenceBatch(baseline, [excerpt, full], {checkpointFile: checkpoint});
  const capture = browserCaptureFromReport(report);
  assert.deepEqual(Object.keys(capture), ['format', 'version', 'browser_script_sha256', 'normalization_sha256', 'reference_sha256',
    'checkpoint_sha256', 'receipts', 'totals']);
  assert.equal(capture.version, 3);
  const script = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.equal(capture.browser_script_sha256, digest(Buffer.from(script, 'utf8')));
  assert.equal(capture.receipts[0].sha256, digest(fs.readFileSync(excerpt)));
  const file = save('capture.json', JSON.stringify(capture));
  const args = [cli, baseline, excerpt, full, '--checkpoint', checkpoint, '--check-capture', file];
  const pass = spawnSync(process.execPath, args, {encoding: 'utf8'});
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /CAPTURE MATCH/);
  assert.match(pass.stdout, /selected-name normalization profile agree/);
  const changedScript = save('changed-script.json', JSON.stringify({...capture,
    browser_script_sha256: '0'.repeat(64)}));
  const mismatchedScript = spawnSync(process.execPath,
    [...args.slice(0, -1), changedScript], {encoding: 'utf8'});
  assert.equal(mismatchedScript.status, 1);
  assert.match(mismatchedScript.stderr, /Browser capture differs/);
  const added = save('added.json', JSON.stringify({...capture, private_field: 'no'}));
  const extra = spawnSync(process.execPath, [...args.slice(0, -1), added], {encoding: 'utf8'});
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /Browser capture differs/);
  const altered = save('altered.json', JSON.stringify({...capture,
    receipts: [{...capture.receipts[0], verdict: 'DIFFER'}, capture.receipts[1]]}));
  const fail = spawnSync(process.execPath, [...args.slice(0, -1), altered], {encoding: 'utf8'});
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /Browser capture differs/);
}));

test('older v1 browser captures still replay with an explicit missing-code warning', () => temporary(save => {
  const report = auditEvidenceBatch(baseline, [excerpt], {checkpointFile: checkpoint});
  const legacy = browserCaptureFromReport(report, 1);
  assert.equal(legacy.version, 1);
  assert.equal('browser_script_sha256' in legacy, false);
  const file = save('legacy.json', JSON.stringify(legacy));
  const replay = spawnSync(process.execPath,
    [cli, baseline, excerpt, '--checkpoint', checkpoint, '--check-capture', file],
    {encoding: 'utf8'});
  assert.equal(replay.status, 0, replay.stderr);
  assert.match(replay.stdout, /Legacy v1 capture has no browser script fingerprint/);
}));

test('bounds, invalid UTF-8, and unknown options fail or classify without partial acceptance', () => temporary(save => {
  assert.throws(() => auditEvidenceBatch(baseline, []), /1–20/);
  assert.throws(() => auditEvidenceBatch(baseline, Array(21).fill(excerpt)), /1–20/);
  assert.throws(() => auditEvidenceBatch(baseline, [save('huge.json', ' '.repeat(1024 * 1024 + 1))]),
    /1 MiB/);
  const four = Array.from({length: 5}, (_, index) => save(`large-${index}.json`, ' '.repeat(900000)));
  assert.throws(() => auditEvidenceBatch(baseline, four), /4 MiB combined/);
  const badEncoding = save('bad-encoding.json', Buffer.from([0xff, 0xfe, 0xfd]));
  const report = auditEvidenceBatch(baseline, [badEncoding]);
  assert.equal(report.receipts[0].reason, 'invalid-json');
  assert.equal(report.receipts[0].sha256, digest(fs.readFileSync(badEncoding)));
  const badFlag = spawnSync(process.execPath, [cli, baseline, excerpt, '--unknown'], {encoding: 'utf8'});
  assert.equal(badFlag.status, 1);
  assert.match(badFlag.stderr, /Unknown option/);
}));
