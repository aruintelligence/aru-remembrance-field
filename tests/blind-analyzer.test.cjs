'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {analyzeTrialFiles, formatText} = require('../tools/analyze-blind-trials.cjs');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'example-blind-trial.json'), 'utf8'));
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
    assert.equal(result.dataset_sha256, analyzeTrialFiles([copy, file]).dataset_sha256);
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
