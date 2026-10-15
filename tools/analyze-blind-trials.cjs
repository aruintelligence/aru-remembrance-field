#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const {verifyBlindTrial} = require('./verify-blind-trial.cjs');

const MAX_FILES = 100;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const LIMITATION = 'These counts describe only the supplied files. They cannot establish independent readers, original assignments or ratings, or complete submission. The Wilson interval assumes independent ratings; duplicate or unauthenticated files cannot establish that assumption. Neither score agreement nor the interval proves usefulness or real-world benefit.';

function wilsonInterval(wins, trials) {
  const z = 1.959963984540054;
  const p = wins / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const radius = z * Math.sqrt(p * (1 - p) / trials + z2 / (4 * trials * trials)) / denominator;
  return {lower: Math.max(0, center - radius), upper: Math.min(1, center + radius)};
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function loadTrialPlan(file) {
  if (typeof file !== 'string' || !file) throw new Error('Provide a trial plan JSON file');
  let contents;
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error('exceeds 1 MiB');
    contents = fs.readFileSync(file);
    if (contents.length > MAX_FILE_BYTES) throw new Error('exceeds 1 MiB');
  } catch (error) {
    throw new Error(`Trial plan ${file}: ${error.message}`);
  }
  let plan;
  try { plan = JSON.parse(contents.toString('utf8')); }
  catch (error) { throw new Error(`Trial plan ${file}: invalid JSON: ${error.message}`); }
  const modern = plan && plan.version === 2;
  const keys = ['format', 'version', 'model_revision', 'primary_outcome', 'cases'];
  if (modern) keys.push('response_revision');
  if (!exactKeys(plan, keys) ||
    plan.format !== 'aru-blind-trial-plan' || (plan.version !== 1 && !modern) ||
    plan.model_revision !== 'aru-field-heuristics-2' ||
    (modern && plan.response_revision !== 'aru-response-2') ||
    plan.primary_outcome !== 'history_win_fraction_all' ||
    !Array.isArray(plan.cases) || plan.cases.length < 1 || plan.cases.length > 50) {
    throw new Error(`Trial plan ${file}: unsupported format, outcome, or case count`);
  }
  const byInput = new Map();
  const ids = new Set();
  let expected = 0;
  for (const entry of plan.cases) {
    if (!exactKeys(entry, ['id', 'context', 'prompt', 'ratings']) ||
      typeof entry.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(entry.id) ||
      ids.has(entry.id) || !Number.isSafeInteger(entry.ratings) ||
      entry.ratings < 1 || entry.ratings > MAX_FILES ||
      !Array.isArray(entry.context) || entry.context.length < 1 || entry.context.length > 8 ||
      !entry.context.every(line => typeof line === 'string' && line.trim() === line &&
        line.length >= 1 && line.length <= 500 && !/[\r\n]/.test(line)) ||
      typeof entry.prompt !== 'string' || entry.prompt.trim() !== entry.prompt ||
      entry.prompt.length < 1 || entry.prompt.length > 500) {
      throw new Error(`Trial plan ${file}: invalid case or repeated ID`);
    }
    const key = JSON.stringify([entry.context, entry.prompt]);
    if (byInput.has(key)) throw new Error(`Trial plan ${file}: repeated context and prompt`);
    byInput.set(key, {id: entry.id, expected: entry.ratings, received: 0,
      history_wins: 0, control_wins: 0, ties: 0,
      score_direction: null, score_choice_aligned: 0, score_choice_opposed: 0});
    ids.add(entry.id);
    expected += entry.ratings;
  }
  if (expected > MAX_FILES) throw new Error(`Trial plan ${file}: exceeds ${MAX_FILES} rated trials`);
  return {sha256: sha256(contents), expected, byInput,
    responseRevision: modern ? 'aru-response-2' : 'aru-response-1'};
}

function analyzeTrialFiles(files, {planFile} = {}) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES ||
    files.some(file => typeof file !== 'string' || !file)) {
    throw new Error(`Provide 1–${MAX_FILES} trial JSON files`);
  }
  const plan = planFile === undefined ? null : loadTrialPlan(planFile);

  const summary = {
    trials: 0, history_wins: 0, control_wins: 0, ties: 0, non_ties: 0,
    history_win_fraction_all: 0, history_win_fraction_non_ties: null,
    history_as_A: {trials: 0, history_wins: 0, control_wins: 0, ties: 0},
    history_as_B: {trials: 0, history_wins: 0, control_wins: 0, ties: 0},
    identical_copies: 0, distinct_file_contents: 0
  };
  const blankOutcomes = () => ({trials: 0, history_wins: 0, control_wins: 0, ties: 0});
  const diagnostics = {
    score_higher_with_history: blankOutcomes(), score_equal: blankOutcomes(),
    score_higher_without_history: blankOutcomes(),
    decisive_score_choice_agreement: {aligned: 0, opposed: 0, total: 0}
  };
  const hashes = new Map();
  let batchResponseRevision = null;
  let totalBytes = 0;
  for (const file of files) {
    try {
      const size = fs.statSync(file).size;
      if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) {
        throw new Error('exceeds 1 MiB per file');
      }
      const contents = fs.readFileSync(file);
      if (contents.length > MAX_FILE_BYTES) throw new Error('exceeds 1 MiB per file');
      totalBytes += contents.length;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('exceeds 16 MiB total');
      const report = JSON.parse(contents.toString('utf8'));
      const {preferred, responseRevision, withHistory, withoutHistory} = verifyBlindTrial(report);
      if (plan && responseRevision !== plan.responseRevision) {
        throw new Error(`response revision ${responseRevision} does not match trial plan ${plan.responseRevision}`);
      }
      if (batchResponseRevision && responseRevision !== batchResponseRevision) {
        throw new Error('mixed response revisions in one batch');
      }
      batchResponseRevision = responseRevision;
      let slot;
      if (plan) {
        slot = plan.byInput.get(JSON.stringify([report.context, report.prompt]));
        if (!slot) throw new Error('context and prompt are not in the trial plan');
        if (++slot.received > slot.expected) throw new Error(`trial plan case ${slot.id} exceeds ${slot.expected} ratings`);
      }
      const position = report.assignment.A === 'with_history' ? 'history_as_A' : 'history_as_B';
      const outcome = preferred === 'with_history' ? 'history_wins' :
        preferred === 'without_history' ? 'control_wins' : 'ties';
      summary.trials++;
      summary[outcome]++;
      if (slot) slot[outcome]++;
      summary[position].trials++;
      summary[position][outcome]++;
      const effect = withHistory - withoutHistory;
      const scoreDirection = Math.abs(effect) <= 1e-10 ? 'score_equal' :
        effect > 0 ? 'score_higher_with_history' : 'score_higher_without_history';
      diagnostics[scoreDirection].trials++;
      diagnostics[scoreDirection][outcome]++;
      if (slot) slot.score_direction = scoreDirection;
      if (scoreDirection !== 'score_equal' && outcome !== 'ties') {
        const agreement = diagnostics.decisive_score_choice_agreement;
        agreement.total++;
        const aligned = (scoreDirection === 'score_higher_with_history' && outcome === 'history_wins') ||
          (scoreDirection === 'score_higher_without_history' && outcome === 'control_wins');
        agreement[aligned ? 'aligned' : 'opposed']++;
        if (slot) slot[aligned ? 'score_choice_aligned' : 'score_choice_opposed']++;
      }
      const hash = sha256(contents);
      hashes.set(hash, (hashes.get(hash) || 0) + 1);
    } catch (error) {
      throw new Error(`${file}: ${error.message}`);
    }
  }
  if (plan) {
    const missing = [...plan.byInput.values()].filter(slot => slot.received < slot.expected);
    if (missing.length) {
      throw new Error(`Incomplete trial plan: ${missing.map(slot =>
        `${slot.id} ${slot.received}/${slot.expected}`).join(', ')}`);
    }
  }
  summary.non_ties = summary.history_wins + summary.control_wins;
  summary.history_win_fraction_all = summary.history_wins / summary.trials;
  if (summary.non_ties) summary.history_win_fraction_non_ties = summary.history_wins / summary.non_ties;
  summary.distinct_file_contents = hashes.size;
  summary.identical_copies = summary.trials - hashes.size;
  diagnostics.history_win_fraction_all_wilson95 = wilsonInterval(summary.history_wins, summary.trials);
  const duplicates = [...hashes].filter(([, copies]) => copies > 1)
    .map(([sha256, copies]) => ({sha256, copies})).sort((a, b) => a.sha256.localeCompare(b.sha256));
  const dataset_sha256 = sha256([...hashes].flatMap(([hash, copies]) => Array(copies).fill(hash)).sort().join('\n'));
  const result = {
    format: 'aru-blind-trial-batch-analysis', version: 1,
    model_revision: 'aru-field-heuristics-2', response_revision: batchResponseRevision,
    dataset_sha256, summary, diagnostics, duplicates,
    limitation: LIMITATION
  };
  if (plan) result.plan = {
    sha256: plan.sha256, expected_trials: plan.expected, cases: plan.byInput.size,
    coverage: [...plan.byInput.values()].map(({id, expected, received, history_wins, control_wins,
      ties, score_direction, score_choice_aligned, score_choice_opposed}) =>
      ({id, expected, received, history_wins, control_wins, ties,
        score_direction, score_choice_aligned, score_choice_opposed}))
  };
  return result;
}

function formatText(report) {
  const s = report.summary;
  const d = report.diagnostics;
  const pct = fraction => (fraction * 100).toFixed(1) + '%';
  const scoreRow = (label, row) => `${label}: ${row.trials} (history ${row.history_wins}, control ${row.control_wins}, tie ${row.ties}).`;
  const directionLabel = {
    score_higher_with_history: 'history higher',
    score_equal: 'equal',
    score_higher_without_history: 'control higher'
  };
  return [
    `Verified ${s.trials} submitted trial${s.trials === 1 ? '' : 's'} against ${report.response_revision}.`,
    `History preferred: ${s.history_wins}/${s.trials} (${pct(s.history_win_fraction_all)} of all); control preferred: ${s.control_wins}/${s.trials}; tie/neither: ${s.ties}/${s.trials}.`,
    `Among ${s.non_ties} non-ties: history ${s.history_wins}/${s.non_ties} (${s.non_ties ? pct(s.history_win_fraction_non_ties) : 'undefined'}).`,
    `Wilson 95% interval for history preference among all ratings (assuming independent ratings): ${pct(d.history_win_fraction_all_wilson95.lower)}–${pct(d.history_win_fraction_all_wilson95.upper)}.`,
    scoreRow('Modeled score higher with history', d.score_higher_with_history),
    scoreRow('Modeled scores equal', d.score_equal),
    scoreRow('Modeled score higher without history', d.score_higher_without_history),
    d.decisive_score_choice_agreement.total
      ? `Where both score and recorded choice selected a side: aligned ${d.decisive_score_choice_agreement.aligned}/${d.decisive_score_choice_agreement.total}; opposed ${d.decisive_score_choice_agreement.opposed}/${d.decisive_score_choice_agreement.total}.`
      : 'Where both score and recorded choice selected a side: no decisive comparisons (agreement undefined).',
    `History shown as A: ${s.history_as_A.trials} (history ${s.history_as_A.history_wins}, control ${s.history_as_A.control_wins}, tie ${s.history_as_A.ties}); as B: ${s.history_as_B.trials} (history ${s.history_as_B.history_wins}, control ${s.history_as_B.control_wins}, tie ${s.history_as_B.ties}).`,
    `Byte-identical report copies: ${s.identical_copies} (counted in the totals; ${s.distinct_file_contents} distinct file contents).`,
    ...(report.plan ? [
      `Plan complete: ${s.trials}/${report.plan.expected_trials} rated slots across ${report.plan.cases} case${report.plan.cases === 1 ? '' : 's'}. Plan SHA-256: ${report.plan.sha256}`,
      ...report.plan.coverage.map(row =>
        `  ${row.id}: ${row.received}/${row.expected}; history ${row.history_wins}, control ${row.control_wins}, tie ${row.ties}; modeled ${directionLabel[row.score_direction]}; aligned ${row.score_choice_aligned}, opposed ${row.score_choice_opposed}.`)
    ] : []),
    `Dataset SHA-256: ${report.dataset_sha256}`,
    report.limitation
  ].join('\n');
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--check-plan') {
      if (args.length !== 2) throw new Error('Usage: node tools/analyze-blind-trials.cjs --check-plan plan.json');
      const plan = loadTrialPlan(args[1]);
      console.log(`Valid ${plan.responseRevision} plan: ${plan.byInput.size} case${plan.byInput.size === 1 ? '' : 's'}, ${plan.expected} expected rating${plan.expected === 1 ? '' : 's'}. Plan SHA-256: ${plan.sha256}`);
    } else {
      let json = false, planFile;
      while (args[0] === '--json' || args[0] === '--plan') {
        const option = args.shift();
        if (option === '--json') {
          if (json) throw new Error('Use --json only once');
          json = true;
        } else {
          if (planFile !== undefined || !args[0] || args[0].startsWith('--')) {
            throw new Error('Use --plan once with a JSON file');
          }
          planFile = args.shift();
        }
      }
      const files = args;
      if (files.some(file => file.startsWith('--'))) {
        throw new Error('Usage: node tools/analyze-blind-trials.cjs [--json] [--plan plan.json] <trial1.json> [trial2.json ...]');
      }
      const result = analyzeTrialFiles(files, {planFile});
      console.log(json ? JSON.stringify(result, null, 2) : formatText(result));
    }
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = {analyzeTrialFiles, formatText, loadTrialPlan};
