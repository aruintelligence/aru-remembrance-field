#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const {loadEvaluator, matchReceipt, requireCondition} = require('./verify-proof.cjs');

function verifyBlindTrial(report) {
  const keys = ['format', 'version', 'model_revision', 'context', 'prompt', 'assignment', 'conditions', 'choice'];
  requireCondition(report && typeof report === 'object' && !Array.isArray(report) &&
    Object.keys(report).length === keys.length && keys.every(key => Object.hasOwn(report, key)) &&
    report.format === 'aru-blind-response-trial' && report.version === 1 &&
    report.model_revision === 'aru-field-heuristics-2', 'unsupported blind trial');
  requireCondition(Array.isArray(report.context) && report.context.length >= 1 && report.context.length <= 8 &&
    report.context.every(line => typeof line === 'string' && line.trim() === line && line.length >= 1 &&
      line.length <= 500 && !/[\r\n]/.test(line)) &&
    typeof report.prompt === 'string' && report.prompt.trim() === report.prompt &&
    report.prompt.length >= 1 && report.prompt.length <= 500, 'invalid context or prompt');
  requireCondition(report.assignment && typeof report.assignment === 'object' &&
    Object.keys(report.assignment).length === 2 &&
    ['A', 'B'].every(side => Object.hasOwn(report.assignment, side)) &&
    new Set([report.assignment.A, report.assignment.B]).size === 2 &&
    ['with_history', 'without_history'].includes(report.assignment.A) &&
    ['with_history', 'without_history'].includes(report.assignment.B) &&
    ['A', 'B', 'tie'].includes(report.choice), 'invalid assignment or choice');
  requireCondition(report.conditions && typeof report.conditions === 'object' &&
    Object.keys(report.conditions).length === 2 &&
    ['with_history', 'without_history'].every(key => Object.hasOwn(report.conditions, key)),
    'missing conditions');

  const context = loadEvaluator('aru-field-heuristics-2');
  context.trialContext = report.context;
  context.trialPrompt = report.prompt;
  const computed = vm.runInContext(`(() => {
    const startAt = 1700000000000;
    let withMu = 0.64, withoutMu = 0.64, memory = [];
    const messages = [];
    trialContext.forEach((input, index) => {
      const at = startAt + index * 1000;
      withMu = evaluateCoherence(input, {coherence: withMu, memory, messages}, at).after;
      withoutMu = evaluateCoherence(input, {coherence: withoutMu, memory: [], messages: []}, at).after;
      memory = advanceMemory(memory, input, withMu, at);
      messages.push({type: 'user', text: input});
    });
    const at = startAt + trialContext.length * 1000;
    const withScore = evaluateCoherence(trialPrompt, {coherence: withMu, memory, messages}, at);
    const withoutScore = evaluateCoherence(trialPrompt, {coherence: withoutMu, memory: [], messages: []}, at);
    return {
      with_history: {score: withScore, response_html: getResponse(trialPrompt, false, withScore.after, memory, at)},
      without_history: {score: withoutScore, response_html: getResponse(trialPrompt, false, withoutScore.after, [], at)}
    };
  })()`, context, {timeout: 1000});
  for (const key of ['with_history', 'without_history']) {
    const row = report.conditions[key];
    requireCondition(row && typeof row === 'object' && !Array.isArray(row) &&
      Object.keys(row).length === 2 && Object.hasOwn(row, 'score') &&
      Object.hasOwn(row, 'response_html'), `${key} condition missing`);
    matchReceipt(row.score, computed[key].score, key);
    requireCondition(row.response_html === computed[key].response_html,
      `${key} response does not match the model`);
  }
  const preferred = report.choice === 'tie' ? 'tie' : report.assignment[report.choice];
  return {preferred, withHistory: computed.with_history.score.after,
    withoutHistory: computed.without_history.score.after};
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node tools/verify-blind-trial.cjs <trial.json>');
    const file = process.argv[2];
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('Trial exceeds the 1 MiB limit');
    const result = verifyBlindTrial(JSON.parse(fs.readFileSync(file, 'utf8')));
    console.log(`PASS: recorded choice ${result.preferred}; with history ${result.withHistory.toFixed(5)}, without ${result.withoutHistory.toFixed(5)}`);
    console.log('This replays the scripted outputs. It cannot verify randomization, who rated them, or real-world benefit.');
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {verifyBlindTrial};
