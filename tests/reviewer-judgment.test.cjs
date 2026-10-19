const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {SCENARIOS, verifyReviewerJudgment, readReviewerJudgment} =
  require('../tools/verify-reviewer-judgment.cjs');
const {analyze} = require('../tools/analyze-reviewer-judgments.cjs');
const {review} = require('../tools/review-evidence.cjs');

const root = path.join(__dirname, '..');
const verifier = path.join(root, 'tools/verify-reviewer-judgment.cjs');
const analyzer = path.join(root, 'tools/analyze-reviewer-judgments.cjs');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const browserHash = createHash('sha256').update(script).digest('hex');
const order = SCENARIOS.map(item => item.id);

function report(choices = SCENARIOS.map(item => item.correct), ordered = order) {
  const answers = ordered.map((scenario, index) => ({scenario, choice: choices[index]}));
  return {format: 'aru-reviewer-judgment', version: 1,
    revision: 'aru-reviewer-judgment-1', browser_script_sha256: browserHash,
    order_method: 'crypto_shuffle', scenario_order: ordered, answers,
    score: {correct: answers.filter(row => SCENARIOS.find(item => item.id === row.scenario).correct ===
      row.choice).length, total: SCENARIOS.length}};
}

function temporary(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-judgment-'));
  const save = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  try { callback(save, dir); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('strict report replay accepts the recorded choices but refuses tampered score, code, structure, and order', () => temporary(save => {
  const valid = report();
  const file = save('valid.json', valid);
  assert.equal(verifyReviewerJudgment(valid).correct, 5);
  assert.equal(readReviewerJudgment(file).result.total, 5);
  assert.equal(spawnSync(process.execPath, [verifier, file], {encoding: 'utf8'}).status, 0);
  const mutations = [
    {...valid, score: {correct: 4, total: 5}},
    {...valid, browser_script_sha256: '0'.repeat(64)},
    {...valid, revision: 'unknown'},
    {...valid, extra: true},
    {...valid, scenario_order: [order[0], order[0], ...order.slice(2)]},
    {...valid, answers: valid.answers.slice(0, 4)},
    {...valid, answers: [{scenario: order[0], choice: 'truth'}, ...valid.answers.slice(1)]},
    {...valid, answers: [{scenario: order[1], choice: valid.answers[0].choice}, ...valid.answers.slice(1)]},
    {...valid, answers: [{...valid.answers[0], choice: 'invalid'}, ...valid.answers.slice(1)]}
  ];
  for (const [index, value] of mutations.entries()) {
    const bad = save(`bad-${index}.json`, value);
    assert.throws(() => readReviewerJudgment(bad));
    assert.equal(spawnSync(process.execPath, [verifier, bad], {encoding: 'utf8'}).status, 1);
  }
  for (const [name, value] of [['malformed', '{'],
    ['duplicate', JSON.stringify(valid).replace('"version":1', '"version":1,"version":1')]]) {
    const bad = save(`${name}.json`, value);
    assert.throws(() => readReviewerJudgment(bad), /unambiguous/);
  }
  const backwards = order.slice().reverse();
  const reversed = report(backwards.map(id => SCENARIOS.find(item => item.id === id).correct), backwards);
  reversed.order_method = 'fixed_fallback';
  assert.throws(() => verifyReviewerJudgment(reversed), /Unsupported/);
  const fixed = report();
  fixed.order_method = 'fixed_fallback';
  assert.equal(verifyReviewerJudgment(fixed).correct, 5);
}));

test('aggregation counts choices, flags exact file copies, and refuses an invalid member', () => temporary(save => {
  const perfect = save('perfect.json', report());
  const copy = save('copy.json', report());
  const choices = SCENARIOS.map(item => item.correct);
  choices[1] = 'all_pass';
  const mistaken = save('mistaken.json', report(choices));
  const summary = analyze([perfect, copy, mistaken]);
  assert.equal(summary.files, 3);
  assert.equal(summary.decisions, 15);
  assert.equal(summary.correct, 14);
  assert.equal(summary.exact_byte_copies, 1);
  assert.deepEqual(summary.by_scenario.recorded_fail,
    {correct: 2, selections: {all_pass: 1, one_failed: 2, no_check: 0}});
  const cli = spawnSync(process.execPath, [analyzer, '--json', perfect, copy, mistaken],
    {encoding: 'utf8'});
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), summary);
  const bad = save('forged.json', {...report(), score: {correct: 0, total: 5}});
  assert.throws(() => analyze([perfect, bad]), /score/);
  assert.equal(spawnSync(process.execPath, [analyzer, perfect, bad],
    {encoding: 'utf8'}).status, 1);
  assert.throws(() => analyze([]), /1–100/);
}));

test('the checked-in simulated example replays with four keyed choices; its bytes are not a person', () => {
  const file = path.join(root, 'research', 'example-reviewer-judgment.json');
  const result = readReviewerJudgment(file).result;
  assert.equal(result.correct, 4);
  assert.equal(result.total, 5);
  assert.equal(analyze([file]).files, 1);
});

test('a matching capture can still record a failed receipt in a reproducible counterexample', () => {
  const fixture = name => path.join(root, 'research', name);
  const result = review([fixture('example-evidence-reference-baseline.json'),
    fixture('example-evidence-excerpt.json'), fixture('example-judgment-fail-receipt.json'),
    '--check-capture', fixture('example-judgment-fail-capture.json')]);
  assert.equal(result.replay, 'MATCH');
  assert.equal(result.receipt_assessment, 'recorded_failures');
  assert.deepEqual(result.totals, {match:1, differ:0, fail:1, identical_copies:0});
});
