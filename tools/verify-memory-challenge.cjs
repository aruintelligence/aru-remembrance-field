#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {verifyTrajectory} = require('./verify-trajectory.cjs');
const {requireCondition} = require('./verify-proof.cjs');

const CONTROLS = [
  {id: 'repeated', label: 'Repeated phrase', inputs: ['violet river', 'violet river'], direction: 'positive'},
  {id: 'unrelated', label: 'Unrelated phrases', inputs: ['amber comet', 'violet river'], direction: 'zero'},
  {id: 'contradiction', label: 'Contradictory words', inputs: ['always', 'never'], direction: 'negative'}
];
const DIRECT_NEGATION = {id: 'direct-negation', label: 'Direct negation',
  inputs: ['favorite color teal', 'My favorite color is not teal.'], direction: 'negative'};

function observedDirection(value) {
  return Math.abs(value) < 1e-10 ? 'zero' : value > 0 ? 'positive' : 'negative';
}

function verifyMemoryChallenge(report) {
  requireCondition(report && typeof report === 'object' && !Array.isArray(report) &&
    report.format === 'aru-memory-challenge' && report.version === 1 &&
    ['aru-field-heuristics-2', 'aru-field-heuristics-3'].includes(report.model_revision),
    'unsupported memory challenge report');
  const controls = report.model_revision === 'aru-field-heuristics-3'
    ? [...CONTROLS, DIRECT_NEGATION] : CONTROLS;
  requireCondition(Array.isArray(report.scenarios) && report.scenarios.length === controls.length,
    `memory challenge must contain exactly ${controls.length} controls`);
  const results = [];
  controls.forEach((control, index) => {
    const row = report.scenarios[index];
    requireCondition(row && row.id === control.id && row.label === control.label &&
      row.expected_direction === control.direction && row.trajectory &&
      row.trajectory.model_revision === report.model_revision &&
      Array.isArray(row.trajectory.inputs) &&
      JSON.stringify(row.trajectory.inputs) === JSON.stringify(control.inputs),
      `control ${index + 1} must use the fixed ${control.id} sequence`);
    const verified = verifyTrajectory(row.trajectory);
    const observed = observedDirection(verified.difference);
    requireCondition(observed === control.direction,
      `control ${control.id}: expected ${control.direction} effect, observed ${observed}`);
    results.push({id: control.id, difference: verified.difference, direction: observed});
  });
  return results;
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node tools/verify-memory-challenge.cjs <report.json>');
    const file = process.argv[2];
    if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('Challenge exceeds the 2 MiB verifier limit');
    const results = verifyMemoryChallenge(JSON.parse(fs.readFileSync(file, 'utf8')));
    console.log(`PASS: ${results.map(r => `${r.id} ${r.difference.toFixed(5)} (${r.direction})`).join('; ')}`);
    console.log('Recomputed from fixed controls against the local model source. This checks software behavior, not authenticity or scientific validity.');
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {verifyMemoryChallenge};
