#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const {verifyBlindTrial} = require('./verify-blind-trial.cjs');

const MAX_FILES = 100;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const LIMITATION = 'These counts describe only the supplied files. They cannot establish independent readers, original assignments or ratings, complete submission, or real-world benefit.';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function analyzeTrialFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES ||
    files.some(file => typeof file !== 'string' || !file)) {
    throw new Error(`Provide 1–${MAX_FILES} trial JSON files`);
  }

  const summary = {
    trials: 0, history_wins: 0, control_wins: 0, ties: 0, non_ties: 0,
    history_win_fraction_all: 0, history_win_fraction_non_ties: null,
    history_as_A: {trials: 0, history_wins: 0, control_wins: 0, ties: 0},
    history_as_B: {trials: 0, history_wins: 0, control_wins: 0, ties: 0},
    identical_copies: 0, distinct_file_contents: 0
  };
  const hashes = new Map();
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
      const {preferred} = verifyBlindTrial(report);
      const position = report.assignment.A === 'with_history' ? 'history_as_A' : 'history_as_B';
      const outcome = preferred === 'with_history' ? 'history_wins' :
        preferred === 'without_history' ? 'control_wins' : 'ties';
      summary.trials++;
      summary[outcome]++;
      summary[position].trials++;
      summary[position][outcome]++;
      const hash = sha256(contents);
      hashes.set(hash, (hashes.get(hash) || 0) + 1);
    } catch (error) {
      throw new Error(`${file}: ${error.message}`);
    }
  }
  summary.non_ties = summary.history_wins + summary.control_wins;
  summary.history_win_fraction_all = summary.history_wins / summary.trials;
  if (summary.non_ties) summary.history_win_fraction_non_ties = summary.history_wins / summary.non_ties;
  summary.distinct_file_contents = hashes.size;
  summary.identical_copies = summary.trials - hashes.size;
  const duplicates = [...hashes].filter(([, copies]) => copies > 1)
    .map(([sha256, copies]) => ({sha256, copies})).sort((a, b) => a.sha256.localeCompare(b.sha256));
  const dataset_sha256 = sha256([...hashes].flatMap(([hash, copies]) => Array(copies).fill(hash)).sort().join('\n'));
  return {
    format: 'aru-blind-trial-batch-analysis', version: 1,
    model_revision: 'aru-field-heuristics-2', dataset_sha256, summary, duplicates,
    limitation: LIMITATION
  };
}

function formatText(report) {
  const s = report.summary;
  const pct = fraction => (fraction * 100).toFixed(1) + '%';
  return [
    `Verified ${s.trials} submitted trial${s.trials === 1 ? '' : 's'} against the scripted model.`,
    `History preferred: ${s.history_wins}/${s.trials} (${pct(s.history_win_fraction_all)} of all); control preferred: ${s.control_wins}/${s.trials}; tie/neither: ${s.ties}/${s.trials}.`,
    `Among ${s.non_ties} non-ties: history ${s.history_wins}/${s.non_ties} (${s.non_ties ? pct(s.history_win_fraction_non_ties) : 'undefined'}).`,
    `History shown as A: ${s.history_as_A.trials} (history ${s.history_as_A.history_wins}, control ${s.history_as_A.control_wins}, tie ${s.history_as_A.ties}); as B: ${s.history_as_B.trials} (history ${s.history_as_B.history_wins}, control ${s.history_as_B.control_wins}, tie ${s.history_as_B.ties}).`,
    `Byte-identical report copies: ${s.identical_copies} (counted in the totals; ${s.distinct_file_contents} distinct file contents).`,
    `Dataset SHA-256: ${report.dataset_sha256}`,
    report.limitation
  ].join('\n');
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const json = args[0] === '--json';
    const files = json ? args.slice(1) : args;
    if (files.some(file => file.startsWith('--'))) {
      throw new Error('Usage: node tools/analyze-blind-trials.cjs [--json] <trial1.json> [trial2.json ...]');
    }
    const result = analyzeTrialFiles(files);
    console.log(json ? JSON.stringify(result, null, 2) : formatText(result));
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = {analyzeTrialFiles, formatText};
