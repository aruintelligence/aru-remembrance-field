const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {reviewSourceMap} = require('../tools/review-source-probe.cjs');

const root = path.join(__dirname, '..');
const file = name => path.join(root, 'research', name);
const tool = path.join(root, 'tools/review-source-probe.cjs');
const baseline = file('example-evidence-reference-baseline.json');
const conflict = file('example-evidence-reference-conflict.json');
const unrelated = file('example-verdict-witness-reference-unrelated.json');
const excerpt = file('example-evidence-excerpt.json');
const full = file('example-evidence-receipt.json');
const checkpoint = file('example-evidence-ledger-checkpoint.json');
const capture = file('example-evidence-browser-batch-capture.json');

function temporary(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-probe-test-'));
  const save = (name, data) => { const target = path.join(dir, name); fs.writeFileSync(target, data); return target; };
  try { return callback(save); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('two implementations reproduce a conflict reversal and a verdict-only snapshot change', () => {
  const first = reviewSourceMap({reference: conflict, receipts: [excerpt]});
  assert.equal(first.assessment, 'MATCH');
  assert.equal(first.capture_replay, 'not_checked');
  assert.equal(first.receipt_assessment, 'recorded_differences');
  assert.deepEqual(first.source_map.rows[0].removals, [
    {source_id: 1, verdict: 'DIFFER', answer_changed: true},
    {source_id: 2, verdict: 'MATCH', answer_changed: true}
  ]);
  const second = reviewSourceMap({reference: unrelated, receipts: [full]});
  assert.equal(second.assessment, 'MATCH');
  assert.deepEqual(second.source_map.rows[0].removals[1],
    {source_id: 2, verdict: 'MATCH', answer_changed: false});
  assert.doesNotMatch(JSON.stringify(second), /synthetic town|favorite color|teal/);
});

test('brief answers distinguish a cited source from an unrelated snapshot source', () => temporary(save => {
  const brief = file('example-evidence-brief.json');
  const records = JSON.parse(fs.readFileSync(brief, 'utf8')).records;
  const reference = save('brief-reference.json', JSON.stringify({format: 'aru-evidence-ledger-baseline',
    version: 1, records, next_source_id: 7}));
  const result = reviewSourceMap({reference, receipts: [brief]});
  assert.equal(result.assessment, 'MATCH');
  assert.equal(result.receipt_assessment, 'all_receipts_match');
  assert.deepEqual(result.source_map.rows[0].removals.find(row => row.source_id === 3),
    {source_id: 3, verdict: 'DIFFER', answer_changed: true});
  assert.deepEqual(result.source_map.rows[0].removals.find(row => row.source_id === 6),
    {source_id: 6, verdict: 'DIFFER', answer_changed: false});
}));

test('capture binding and checkpoint are independently checked without upgrading recorded failures', () => {
  const good = reviewSourceMap({reference: baseline, receipts: [excerpt, full], checkpoint, capture});
  assert.equal(good.assessment, 'MATCH');
  assert.equal(good.capture_replay, 'MATCH');
  assert.deepEqual(good.capture_binding,
    {script: 'matched', selected_name_runtime: 'selected_profile_matched'});
  assert.equal(good.receipt_assessment, 'all_receipts_match');

  const legacy = reviewSourceMap({reference: baseline, receipts: [excerpt, full], checkpoint,
    capture: file('example-evidence-browser-batch-capture-v1.json')});
  assert.equal(legacy.assessment, 'MATCH');
  assert.equal(legacy.capture_binding.script, 'unavailable_legacy_v1');
  assert.equal(legacy.capture_binding.selected_name_runtime, 'not_recorded_in_capture');

  const failure = reviewSourceMap({reference: baseline,
    receipts: [excerpt, file('example-judgment-fail-receipt.json')],
    capture: file('example-judgment-fail-capture.json')});
  assert.equal(failure.assessment, 'MATCH');
  assert.equal(failure.capture_replay, 'MATCH');
  assert.equal(failure.receipt_assessment, 'recorded_failures');
  assert.equal(failure.source_map.rows[1].skipped, true);
});

test('tampering, wrong order, changed script, malformed files, and a bad checkpoint withhold results', () => temporary(save => {
  const original = JSON.parse(fs.readFileSync(capture, 'utf8'));
  const changed = save('script.json', JSON.stringify({...original,
    browser_script_sha256: '0'.repeat(64)}));
  assert.deepEqual(reviewSourceMap({reference: baseline, receipts: [excerpt, full], checkpoint,
    capture: changed}).reason, 'capture_unconfirmed');
  assert.equal(reviewSourceMap({reference: baseline, receipts: [full, excerpt], checkpoint,
    capture}).assessment, 'UNCONFIRMED');
  const reordered = save('changed-receipt.json', fs.readFileSync(excerpt, 'utf8') + '\n');
  assert.equal(reviewSourceMap({reference: baseline, receipts: [reordered, full], checkpoint,
    capture}).assessment, 'UNCONFIRMED');
  const badCheckpoint = save('checkpoint.json', JSON.stringify({...JSON.parse(fs.readFileSync(checkpoint)),
    sha256: '0'.repeat(64)}));
  assert.throws(() => reviewSourceMap({reference: baseline, receipts: [excerpt],
    checkpoint: badCheckpoint}), /checkpoint/i);
  const ambiguous = save('ambiguous.json', '{"format": 1, "format": 2}');
  const malformed = save('malformed.json', '{');
  const mixed = reviewSourceMap({reference: baseline,
    receipts: [excerpt, ambiguous, malformed, excerpt]});
  assert.equal(mixed.assessment, 'MATCH');
  assert.equal(mixed.receipt_assessment, 'recorded_failures');
  assert.deepEqual(mixed.source_map.rows.map(row => row.skipped || false),
    [false, true, true, false]);
  assert.equal(mixed.source_map.selection.receipts[3].duplicate_of, 1);
  assert.throws(() => reviewSourceMap({reference: save('reference.json', '{'),
    receipts: [excerpt]}), /JSON|reference/i);
  const missing = spawnSync(process.execPath, [tool, baseline, path.join(os.tmpdir(),
    'aru-no-such-source-receipt.json'), '--json'], {encoding: 'utf8'});
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, '');
}));

test('a rejecting or disagreeing independent checker cannot issue a positive map', () => temporary(save => {
  const disagree = save('disagree.py', 'import json\nprint(json.dumps({"format":"aru-source-removal-map"}))\n');
  const rejected = save('reject.py', 'raise ValueError("synthetic rejection")\n');
  assert.equal(reviewSourceMap({reference: conflict, receipts: [excerpt]},
    {pythonScript: disagree}).reason, 'checker_disagreement');
  assert.equal(reviewSourceMap({reference: conflict, receipts: [excerpt]},
    {pythonScript: rejected}).reason, 'checker_rejected');
  const cli = spawnSync(process.execPath, [tool, conflict, excerpt, '--json'], {encoding: 'utf8'});
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).assessment, 'MATCH');
}));
