#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const {loadEvaluator, matchReceipt, matchNumber, requireCondition} = require('./verify-proof.cjs');

function verifyTrajectory(proof) {
  requireCondition(proof && typeof proof === 'object' && !Array.isArray(proof), 'trajectory object expected');
  requireCondition(proof.schema_version === 1 &&
    (proof.model_revision === 'aru-field-heuristics-1' || proof.model_revision === 'aru-field-heuristics-2'),
    'unsupported trajectory version');
  requireCondition(proof.start_mu === 0.64 && proof.start_at === 1700000000000 && proof.step_ms === 1000,
    'trajectory must use the fixed initial score and clock');
  requireCondition(Array.isArray(proof.inputs) && proof.inputs.length >= 2 && proof.inputs.length <= 24,
    'trajectory needs 2–24 inputs');
  for (const input of proof.inputs) {
    requireCondition(typeof input === 'string' && input.length >= 1 && input.length <= 500 &&
      input === input.trim() && !/[\r\n]/.test(input), 'invalid trajectory input');
  }
  requireCondition(Array.isArray(proof.steps) && proof.steps.length === proof.inputs.length, 'step count does not match');
  requireCondition(proof.final && typeof proof.final === 'object', 'final scores missing');

  const context = loadEvaluator(proof.model_revision);
  context.proof = proof;
  const computed = vm.runInContext('runTrajectory(proof.inputs, proof.start_mu, proof.start_at, proof.step_ms)',
    context, {timeout: 1000});
  computed.steps.forEach((step, i) => {
    const recorded = proof.steps[i];
    requireCondition(recorded && recorded.input === step.input, `step ${i + 1} input does not match`);
    matchNumber(recorded.at, step.at, `step ${i + 1} timestamp`);
    matchReceipt(recorded.actual, step.actual, `step ${i + 1} with history`);
    matchReceipt(recorded.control, step.control, `step ${i + 1} without history`);
    matchNumber(recorded.effect, step.effect, `step ${i + 1} difference`);
  });
  for (const key of ['with_history', 'without_history', 'difference']) {
    matchNumber(proof.final[key], computed.final[key], `final.${key}`);
  }
  return {steps: computed.steps.length, ...computed.final};
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node tools/verify-trajectory.cjs <proof.json>');
    const file = process.argv[2];
    if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('Trajectory exceeds the 2 MiB verifier limit');
    const result = verifyTrajectory(JSON.parse(fs.readFileSync(file, 'utf8')));
    console.log(`PASS: ${result.steps} steps; with history ${result.with_history.toFixed(5)}, without history ${result.without_history.toFixed(5)}, difference ${result.difference.toFixed(5)}`);
    console.log('Recomputed against the local model source. This checks consistency, not authenticity or scientific validity.');
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {verifyTrajectory};
