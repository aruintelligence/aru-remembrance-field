const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {challenge, generate, JS_SPACE, EXTRA} = require('../tools/challenge-verifier-boundaries.cjs');
const {auditEvidenceBatch, browserCaptureFromReport} = require('../tools/audit-evidence-batch.cjs');

const root = path.join(__dirname, '..');
const reviewTool = path.join(root, 'tools', 'review-evidence.cjs');
const example = name => path.join(root, 'research', `example-boundary-${name}.json`);

function temporary(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-boundaries-'));
  const save = (name, data) => {
    const target = path.join(dir, name);
    fs.writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data));
    return target;
  };
  try { return callback(save, dir); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

const record = (key, id = 1) => ({id, key, value: 'Portland',
  time: 1700000000000, status: 'active', imported: false});
const receipt = (claim, question, answer) => ({format: 'aru-evidence-question-receipt',
  version: 1, model_revision: 'aru-evidence-questions-1', question,
  records: [claim], answer});

test('fixed and seeded boundary cases compare the live browser model with independent Python', () => {
  const cases = generate(20261017, 400);
  assert.equal(cases.length, 400);
  assert(cases.some(c => c.codepoint === 0x85 && c.scenario === 'key_inner'));
  assert(cases.some(c => c.codepoint === 0x0d && c.scenario === 'possessive_gap'));
  assert(cases.some(c => c.codepoint === 0xfeff && c.scenario === 'key_edges'));
  assert(cases.some(c => c.codepoint === 0x17f && c.scenario === 'grammar_case'));
  for (const point of JS_SPACE) assert.match(String.fromCodePoint(point), /\s/);
  for (const point of EXTRA) assert.doesNotMatch(String.fromCodePoint(point), /\s/);
  for (const seed of [20261017, 1, 4294967295]) {
    const result = challenge({seed, runs: seed === 20261017 ? 400 : 2000});
    assert.equal(result.passed, true, JSON.stringify(result.first_disagreement));
    assert.equal(result.runs_completed, result.runs_requested);
    assert.equal(result.systematic_cases, 201);
    assert.match(result.browser_model_sha256, /^[0-9a-f]{64}$/);
    assert.match(result.python_auditor_sha256, /^[0-9a-f]{64}$/);
  }
});

test('the first disagreement is a reproducible counterexample, not a silent pass', () => temporary((save, dir) => {
  fs.copyFileSync(path.join(root, 'tools', 'independent-evidence-batch.py'),
    path.join(dir, 'independent-evidence-batch.py'));
  const worker = save('faulty-probe.py', 'import json,sys\n' +
    'cases=json.load(sys.stdin)["cases"]\n' +
    'print(json.dumps({"results":[{"valid":True,"answer":{"kind":"known"}} for _ in cases]}))\n');
  const result = challenge({seed:20261017, runs:400, worker});
  assert.equal(result.passed, false);
  assert.equal(result.runs_completed, 1);
  assert.equal(result.first_disagreement.case_index, 0);
  assert.equal(result.first_disagreement.codepoint, 'U+0009');
  assert.deepEqual(result.first_disagreement.python, {valid:true, answer:{kind:'known'}});
  assert.notDeepEqual(result.first_disagreement.browser, result.first_disagreement.python);
  assert.throws(() => challenge({runs:0}), /1–2000/);
  assert.throws(() => challenge({runs:2001}), /1–2000/);
  assert.throws(() => challenge({seed:-1}), /uint32/);
}));

test('public U+0085 fixture replays as one MATCH under both auditors', () => {
  const run = spawnSync(process.execPath,
    [reviewTool, example('reference'), example('receipt'), '--check-capture',
      example('capture'), '--json'], {encoding:'utf8'});
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.replay, 'MATCH');
  assert.equal(result.receipt_assessment, 'all_receipts_match');
  assert.equal(result.totals.match, 1);
  assert.equal(result.script_binding, 'matched');
});

test('full saved captures replay the corrected boundaries with both auditors', () => temporary(save => {
  // The old Python auditor marked the U+0085 receipt FAIL and turned the CR
  // refusal into a cited answer. Both were disagreements with browser rules.
  const special = record('city\u0085hall');
  const ordinary = record('city hall');
  const reference = save('reference.json', {format:'aru-evidence-ledger-baseline',
    version:1, records:[special], next_source_id:2});
  const one = save('u0085.json', receipt(special, 'What is city hall?', {kind:'missing'}));
  const two = save('cr.json', receipt(ordinary, 'What is my\rcity hall?', {kind:'unsupported'}));
  const report = auditEvidenceBatch(reference, [one, two]);
  assert.deepEqual(report.receipts.map(row => row.verdict), ['MATCH', 'DIFFER']);
  // The second receipt has a different reference record, so DIFFER is correct;
  // its internal replay is still valid under the browser's refusal semantics.
  const capture = save('capture.json', browserCaptureFromReport(report));
  const run = (files, selected = capture) => spawnSync(process.execPath,
    [reviewTool, reference, ...files, '--check-capture', selected, '--json'],
    {encoding:'utf8'});
  const reviewed = run([one, two]);
  assert.equal(reviewed.status, 0, reviewed.stderr);
  const value = JSON.parse(reviewed.stdout);
  assert.equal(value.replay, 'MATCH');
  assert.equal(value.receipt_assessment, 'recorded_differences');
  assert.deepEqual(value.auditors, {node:'matched', python:'matched'});
  assert.deepEqual(value.not_established,
    ['authorship', 'independent_custody', 'completeness', 'factual_truth']);

  const swapped = run([two, one]);
  assert.equal(swapped.status, 1);
  assert.equal(JSON.parse(swapped.stdout).replay, 'UNCONFIRMED');
  const altered = save('altered.json', receipt(special, 'What is city hall?',
    {kind:'known', value:'Portland', sources:[1]}));
  assert.equal(JSON.parse(run([altered, two]).stdout).replay, 'UNCONFIRMED');
  const wrongScript = browserCaptureFromReport(report);
  wrongScript.browser_script_sha256 = '0'.repeat(64);
  assert.equal(JSON.parse(run([one, two], save('wrong-script.json', wrongScript)).stdout).replay,
    'UNCONFIRMED');
  const legacy = save('legacy.json', browserCaptureFromReport(report, 1));
  assert.equal(JSON.parse(run([one, two], legacy).stdout).script_binding,
    'unavailable_legacy_v1');
  assert.equal(JSON.parse(run([one, save('malformed.json', '{')]).stdout).replay,
    'UNCONFIRMED');
}));
