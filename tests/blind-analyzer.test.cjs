'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const {analyzeTrialFiles, formatText, loadTrialPlan} = require('../tools/analyze-blind-trials.cjs');
const {loadEvaluator} = require('../tools/verify-proof.cjs');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-blind-trial.json'), 'utf8'));
const planFixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-blind-trial-plan.json'), 'utf8'));
const modernFixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-blind-trial-v2.json'), 'utf8'));
const modernPlanFixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-blind-trial-plan-v2.json'), 'utf8'));
const currentFixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-blind-trial-v3.json'), 'utf8'));
const currentPlanFixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-blind-trial-plan-v3.json'), 'utf8'));
const cli = path.join(__dirname, '..', 'tools', 'analyze-blind-trials.cjs');

function inTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-blind-batch-'));
  const write = (name, report) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(report));
    return file;
  };
  try { run({dir, write}); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

function modernTrial(context, prompt, choice) {
  const report = structuredClone(modernFixture);
  report.context = context;
  report.prompt = prompt;
  report.choice = choice;
  const model = loadEvaluator(report.model_revision);
  model.inputs = context;
  model.finalPrompt = prompt;
  report.conditions = JSON.parse(JSON.stringify(vm.runInContext(`(() => {
    const startAt = 1700000000000;
    let withMu = 0.64, withoutMu = 0.64, memory = [];
    const messages = [];
    inputs.forEach((input, index) => {
      const at = startAt + index * 1000;
      withMu = evaluateCoherence(input, {coherence: withMu, memory, messages}, at).after;
      withoutMu = evaluateCoherence(input, {coherence: withoutMu, memory: [], messages: []}, at).after;
      memory = advanceMemory(memory, input, withMu, at);
      messages.push({type: 'user', text: input});
    });
    const at = startAt + inputs.length * 1000;
    const withScore = evaluateCoherence(finalPrompt, {coherence: withMu, memory, messages}, at);
    const withoutScore = evaluateCoherence(finalPrompt, {coherence: withoutMu, memory: [], messages: []}, at);
    return {
      with_history: {score: withScore, response_html: getResponse(finalPrompt, false, withScore.after, memory, at)},
      without_history: {score: withoutScore, response_html: getResponse(finalPrompt, false, withoutScore.after, [], at)}
    };
  })()`, model, {timeout: 1000})));
  return report;
}

test('replayed reports count both wins and ties with the all-trials denominator and A/B positions', () => {
  inTempDir(({write}) => {
    const history = structuredClone(fixture);
    history.choice = 'A';
    const control = structuredClone(fixture);
    control.assignment = {A: 'without_history', B: 'with_history'};
    control.choice = 'A';
    const reports = [write('history.json', history), write('control.json', control),
      write('tie.json', fixture)];
    const result = analyzeTrialFiles(reports);
    assert.deepEqual(result.summary, {
      trials: 3, history_wins: 1, control_wins: 1, ties: 1, non_ties: 2,
      history_win_fraction_all: 1 / 3, history_win_fraction_non_ties: 1 / 2,
      history_as_A: {trials: 2, history_wins: 1, control_wins: 0, ties: 1},
      history_as_B: {trials: 1, history_wins: 0, control_wins: 1, ties: 0},
      identical_copies: 0, distinct_file_contents: 3
    });
    assert.match(result.dataset_sha256, /^[0-9a-f]{64}$/);
    assert.match(formatText(result), /History preferred: 1\/3 \(33\.3% of all\)/);
    assert.deepEqual(result.diagnostics, {
      score_higher_with_history: {trials: 3, history_wins: 1, control_wins: 1, ties: 1},
      score_equal: {trials: 0, history_wins: 0, control_wins: 0, ties: 0},
      score_higher_without_history: {trials: 0, history_wins: 0, control_wins: 0, ties: 0},
      decisive_score_choice_agreement: {aligned: 1, opposed: 1, total: 2},
      history_win_fraction_all_wilson95: {lower: 0.06149194472039621, upper: 0.7923403991979522}
    });
    assert.match(formatText(result), /aligned 1\/2; opposed 1\/2/);
    const cliResult = spawnSync(process.execPath, [cli, '--json', ...reports], {encoding: 'utf8'});
    assert.equal(cliResult.status, 0, cliResult.stderr);
    assert.deepEqual(JSON.parse(cliResult.stdout), result);
    assert.doesNotMatch(cliResult.stdout, /violet river/);
  });
});

test('identical file copies remain in the denominator and are flagged', () => {
  inTempDir(({write}) => {
    const file = write('one.json', fixture);
    const copy = write('two.json', fixture);
    const result = analyzeTrialFiles([file, copy]);
    assert.equal(result.summary.trials, 2);
    assert.equal(result.summary.ties, 2);
    assert.equal(result.summary.history_win_fraction_non_ties, null);
    assert.equal(result.summary.identical_copies, 1);
    assert.equal(result.duplicates[0].copies, 2);
    assert.match(formatText(result), /Among 0 non-ties: history 0\/0 \(undefined\)/);
    assert.match(formatText(result), /no decisive comparisons \(agreement undefined\)/);
    assert.equal(result.dataset_sha256, analyzeTrialFiles([copy, file]).dataset_sha256);
  });
});

test('the primary interval handles zero and all wins while flagging duplicate files', () => {
  inTempDir(({write}) => {
    const one = write('one.json', fixture);
    const zeroWins = analyzeTrialFiles([one]);
    assert.equal(zeroWins.diagnostics.history_win_fraction_all_wilson95.lower, 0);
    assert.ok(Math.abs(zeroWins.diagnostics.history_win_fraction_all_wilson95.upper - 0.7934506856227627) < 1e-12);
    const selected = structuredClone(fixture);
    selected.choice = 'A';
    const win = write('win.json', selected);
    const allWins = analyzeTrialFiles([win, win]);
    assert.equal(allWins.diagnostics.history_win_fraction_all_wilson95.upper, 1);
    assert.ok(allWins.diagnostics.history_win_fraction_all_wilson95.lower > 0.34);
    assert.equal(allWins.summary.identical_copies, 1);
    assert.match(formatText(allWins), /assuming independent ratings/);
    assert.match(allWins.limitation, /unauthenticated files cannot establish/);
  });
});

test('any invalid or altered input fails the whole batch without a partial scorecard', () => {
  inTempDir(({write}) => {
    const good = write('good.json', fixture);
    const tampered = structuredClone(fixture);
    tampered.conditions.with_history.response_html += ' invented';
    const bad = write('bad.json', tampered);
    assert.throws(() => analyzeTrialFiles([good, bad]), /bad\.json: Invalid proof: with_history response does not match/);
    const result = spawnSync(process.execPath, [cli, '--json', good, bad], {encoding: 'utf8'});
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /bad\.json/);
    const forgedScore = structuredClone(fixture);
    forgedScore.conditions.with_history.score.after = 0.35;
    assert.throws(() => analyzeTrialFiles([good, write('forged-score.json', forgedScore)]),
      /forged-score\.json: Invalid proof: with_history.after does not match/);
    const malformed = path.join(path.dirname(good), 'malformed.json');
    fs.writeFileSync(malformed, '{');
    assert.throws(() => analyzeTrialFiles([malformed]), /malformed\.json/);
  });
});

test('input limits reject empty batches, too many files, and oversized reports', () => {
  inTempDir(({dir, write}) => {
    assert.throws(() => analyzeTrialFiles([]), /1–100/);
    const file = write('one.json', fixture);
    assert.throws(() => analyzeTrialFiles(Array(101).fill(file)), /1–100/);
    const large = path.join(dir, 'large.json');
    fs.writeFileSync(large, Buffer.alloc(1024 * 1024 + 1, 32));
    assert.throws(() => analyzeTrialFiles([large]), /exceeds 1 MiB/);
  });
});

test('a fixed plan checks every case count and preserves its exact-file fingerprint', () => {
  inTempDir(({write}) => {
    const planFile = write('plan.json', planFixture);
    const rated = write('trial.json', fixture);
    const result = analyzeTrialFiles([rated], {planFile});
    assert.deepEqual(result.plan, {
      sha256: loadTrialPlan(planFile).sha256, expected_trials: 1, cases: 1,
      coverage: [{id: 'synthetic-example', expected: 1, received: 1,
        history_wins: 0, control_wins: 0, ties: 1,
        score_direction: 'score_higher_with_history', score_choice_aligned: 0, score_choice_opposed: 0}],
      sensitivity: {equal_case_history_win_fraction_all: 0, largest_case_rating_fraction: 1,
        leave_one_case_out_equal_case_range: null}
    });
    assert.match(formatText(result), /Plan complete: 1\/1 rated slots across 1 case/);
    assert.match(formatText(result), /synthetic-example: 1\/1; history 0, control 0, tie 1/);
    assert.match(formatText(result), /Leave-one-case-out equal-case range: undefined with one planned case/);
    const check = spawnSync(process.execPath, [cli, '--check-plan', planFile], {encoding: 'utf8'});
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, new RegExp(`Valid aru-field-heuristics-2 / aru-response-1 plan: 1 case, 1 expected rating\\. Plan SHA-256: ${result.plan.sha256}`));
    const command = spawnSync(process.execPath, [cli, '--json', '--plan', planFile, rated], {encoding: 'utf8'});
    assert.equal(command.status, 0, command.stderr);
    assert.deepEqual(JSON.parse(command.stdout), result);
    assert.doesNotMatch(command.stdout, /violet river/);

    const reformatted = path.join(path.dirname(planFile), 'reformatted.json');
    fs.writeFileSync(reformatted, JSON.stringify(planFixture, null, 2));
    assert.notEqual(analyzeTrialFiles([rated], {planFile: reformatted}).plan.sha256, result.plan.sha256);
  });
});

test('planned case sensitivity exposes a dominant prompt without changing the primary outcome', () => {
  inTempDir(({write}) => {
    const frequent = modernTrial(['favorite color teal'], 'My favorite color is not teal.', 'A');
    const control = modernTrial(['always'], 'never', 'B');
    const tie = modernTrial(['amber comet'], 'violet river', 'tie');
    const plan = structuredClone(modernPlanFixture);
    plan.cases = [
      {id: 'frequent', context: frequent.context, prompt: frequent.prompt, ratings: 8},
      {id: 'control', context: control.context, prompt: control.prompt, ratings: 1},
      {id: 'tie', context: tie.context, prompt: tie.prompt, ratings: 1}
    ];
    const planFile = write('plan.json', plan);
    const files = [
      ...Array.from({length: 8}, (_, index) => write(`frequent-${index}.json`, frequent)),
      write('control.json', control), write('tie.json', tie)
    ];
    const result = analyzeTrialFiles(files, {planFile});
    assert.equal(result.summary.history_win_fraction_all, 0.8);
    assert.deepEqual(result.plan.sensitivity, {
      equal_case_history_win_fraction_all: 1 / 3,
      largest_case_rating_fraction: 0.8,
      leave_one_case_out_equal_case_range: {min: 0, max: 0.5}
    });
    assert.equal(result.summary.identical_copies, 7);
    assert.deepEqual(analyzeTrialFiles([...files].reverse(), {planFile}).plan.sensitivity,
      result.plan.sensitivity);
    assert.match(formatText(result), /Case-balance diagnostic .* history 33\.3%; largest case contributes 80\.0%/);
    assert.match(formatText(result), /Leave-one-case-out equal-case range: 0\.0%–50\.0% \(descriptive, not a confidence interval\)/);
    const command = spawnSync(process.execPath, [cli, '--json', '--plan', planFile, ...files], {encoding: 'utf8'});
    assert.equal(command.status, 0, command.stderr);
    assert.deepEqual(JSON.parse(command.stdout).plan.sensitivity, result.plan.sensitivity);
  });
});

test('planned cases expose differing outcomes instead of hiding them in one aggregate', () => {
  inTempDir(({write}) => {
    const second = modernTrial(['always'], 'never', 'B');
    const plan = structuredClone(modernPlanFixture);
    plan.cases.push({id: 'contradiction', context: second.context, prompt: second.prompt, ratings: 1});
    const result = analyzeTrialFiles([write('one.json', modernFixture), write('two.json', second)],
      {planFile: write('plan.json', plan)});
    assert.equal(result.summary.trials, 2);
    assert.equal(result.summary.control_wins, 1);
    assert.equal(result.response_revision, 'aru-response-2');
    assert.equal(result.diagnostics.score_higher_without_history.control_wins, 1);
    assert.deepEqual(result.diagnostics.decisive_score_choice_agreement,
      {aligned: 1, opposed: 0, total: 1});
    assert.match(formatText(result), /Verified 2 submitted trials against aru-response-2/);
    assert.match(formatText(result), /contradiction: 1\/1;.*modeled control higher; aligned 1, opposed 0/);
    assert.deepEqual(result.plan.coverage, [
      {id: 'negated-color', expected: 1, received: 1, history_wins: 0, control_wins: 0, ties: 1,
        score_direction: 'score_higher_with_history', score_choice_aligned: 0, score_choice_opposed: 0},
      {id: 'contradiction', expected: 1, received: 1, history_wins: 0, control_wins: 1, ties: 0,
        score_direction: 'score_higher_without_history', score_choice_aligned: 1, score_choice_opposed: 0}
    ]);
  });
});

test('the score audit separates positive, negative, and zero effects from recorded preferences', () => {
  inTempDir(({write}) => {
    const positive = modernTrial(['favorite color teal'], 'My favorite color is not teal.', 'A');
    const negative = modernTrial(['always'], 'never', 'A');
    const zero = modernTrial(['amber comet'], 'violet river', 'A');
    const reports = [
      positive, {...positive, choice: 'B'}, {...positive, choice: 'tie'},
      negative, {...negative, choice: 'B'}, {...negative, choice: 'tie'},
      zero, {...zero, choice: 'B'}, {...zero, choice: 'tie'}
    ].map((report, index) => write(`${index}.json`, report));
    const result = analyzeTrialFiles(reports);
    assert.deepEqual(result.diagnostics.score_higher_with_history,
      {trials: 3, history_wins: 1, control_wins: 1, ties: 1});
    assert.deepEqual(result.diagnostics.score_higher_without_history,
      {trials: 3, history_wins: 1, control_wins: 1, ties: 1});
    assert.deepEqual(result.diagnostics.score_equal,
      {trials: 3, history_wins: 1, control_wins: 1, ties: 1});
    assert.deepEqual(result.diagnostics.decisive_score_choice_agreement,
      {aligned: 2, opposed: 2, total: 4});
    assert.equal(result.summary.history_win_fraction_all, 1 / 3);
    assert.match(formatText(result), /Modeled scores equal: 3/);
    assert.match(formatText(result), /aligned 2\/4; opposed 2\/4/);
  });
});

test('response revisions are pinned by plans and cannot be combined into one batch', () => {
  inTempDir(({write}) => {
    const old = write('old.json', fixture);
    const current = write('current.json', modernFixture);
    const oldPlan = write('old-plan.json', planFixture);
    const currentPlan = write('current-plan.json', modernPlanFixture);
    assert.equal(analyzeTrialFiles([old], {planFile: oldPlan}).response_revision, 'aru-response-1');
    assert.equal(analyzeTrialFiles([current], {planFile: currentPlan}).response_revision, 'aru-response-2');
    assert.equal(loadTrialPlan(currentPlan).responseRevision, 'aru-response-2');
    const checked = spawnSync(process.execPath, [cli, '--check-plan', currentPlan], {encoding: 'utf8'});
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /Valid aru-field-heuristics-2 \/ aru-response-2 plan/);
    assert.throws(() => analyzeTrialFiles([old, current]), /mixed response revisions in one batch/);
    assert.throws(() => analyzeTrialFiles([current], {planFile: oldPlan}), /does not match trial plan/);
    assert.throws(() => analyzeTrialFiles([old], {planFile: currentPlan}), /does not match trial plan/);
    const badRevision = structuredClone(modernPlanFixture);
    badRevision.response_revision = 'aru-response-9';
    assert.throws(() => loadTrialPlan(write('bad-plan.json', badRevision)), /unsupported format/);
  });
});

test('v3 reverses the negation probe while preserving replay of the v2 trial', () => {
  inTempDir(({write}) => {
    const before = write('v2.json', modernFixture);
    const after = write('v3.json', currentFixture);
    const oldPlan = write('v2-plan.json', modernPlanFixture);
    const plan = write('v3-plan.json', currentPlanFixture);
    assert.equal(analyzeTrialFiles([before], {planFile: oldPlan}).diagnostics.score_higher_with_history.trials, 1);
    const result = analyzeTrialFiles([after], {planFile: plan});
    assert.equal(result.model_revision, 'aru-field-heuristics-3');
    assert.equal(result.response_revision, 'aru-response-2');
    assert.equal(result.diagnostics.score_higher_without_history.trials, 1);
    assert.equal(result.plan.coverage[0].score_direction, 'score_higher_without_history');
    const check = spawnSync(process.execPath, [cli, '--check-plan', plan], {encoding: 'utf8'});
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /Valid aru-field-heuristics-3 \/ aru-response-2 plan/);
    assert.throws(() => analyzeTrialFiles([before, after]), /mixed score model revisions/);
    assert.throws(() => analyzeTrialFiles([after], {planFile: oldPlan}), /model revision .* does not match trial plan/);
    assert.throws(() => analyzeTrialFiles([before], {planFile: plan}), /model revision .* does not match trial plan/);
    const mislabeled = structuredClone(currentFixture);
    mislabeled.model_revision = 'aru-field-heuristics-2';
    assert.throws(() => analyzeTrialFiles([write('mislabeled.json', mislabeled)]), /does not match the model/);
  });
});

test('a missing, extra, or unplanned report fails without a partial scorecard', () => {
  inTempDir(({write}) => {
    const rated = write('trial.json', fixture);
    const extra = write('extra.json', fixture);
    const twice = structuredClone(planFixture);
    twice.cases[0].ratings = 2;
    const twoFilePlan = write('two.json', twice);
    assert.throws(() => analyzeTrialFiles([rated], {planFile: twoFilePlan}),
      /Incomplete trial plan: synthetic-example 1\/2/);
    assert.throws(() => analyzeTrialFiles([rated, extra], {planFile: write('one.json', planFixture)}),
      /trial plan case synthetic-example exceeds 1 ratings/);

    const different = structuredClone(planFixture);
    different.cases[0].prompt = 'another prompt';
    const differentPlan = write('different.json', different);
    const cliResult = spawnSync(process.execPath, [cli, '--plan', differentPlan, rated], {encoding: 'utf8'});
    assert.equal(cliResult.status, 2);
    assert.equal(cliResult.stdout, '');
    assert.match(cliResult.stderr, /context and prompt are not in the trial plan/);
  });
});

test('a plan rejects duplicate cases, invalid outcomes, and excessive ratings', () => {
  inTempDir(({write}) => {
    const repeated = structuredClone(planFixture);
    repeated.cases.push({...repeated.cases[0], id: 'second'});
    assert.throws(() => loadTrialPlan(write('repeated.json', repeated)), /repeated context and prompt/);
    const wrongOutcome = structuredClone(planFixture);
    wrongOutcome.primary_outcome = 'non_ties_only';
    assert.throws(() => loadTrialPlan(write('outcome.json', wrongOutcome)), /unsupported format, outcome/);
    const excessive = structuredClone(planFixture);
    excessive.cases[0].ratings = 101;
    assert.throws(() => loadTrialPlan(write('too-many.json', excessive)), /invalid case/);
    const missingArg = spawnSync(process.execPath, [cli, '--plan', '--json', 'trial.json'], {encoding: 'utf8'});
    assert.equal(missingArg.status, 2);
    assert.match(missingArg.stderr, /Use --plan once/);
  });
});
