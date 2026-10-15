#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODEL_REVISION = 'aru-field-heuristics-1';

function requireCondition(condition, label) {
  if (!condition) throw new Error(`Invalid proof: ${label}`);
}

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }

function checkShape(proof) {
  requireCondition(proof && typeof proof === 'object' && !Array.isArray(proof), 'object expected');
  requireCondition(proof.schema_version === 1, 'unsupported schema version');
  requireCondition(proof.model_revision === MODEL_REVISION, 'unsupported model revision');
  requireCondition(typeof proof.input === 'string', 'input must be text');
  requireCondition(finite(proof.evaluated_at), 'timestamp must be finite');
  requireCondition(finite(proof.start_mu) && proof.start_mu >= 0.35 && proof.start_mu <= 0.995, 'starting score out of range');
  requireCondition(Array.isArray(proof.prior_memory) && proof.prior_memory.length <= 22, 'at most 22 prior memories');
  requireCondition(Array.isArray(proof.prior_user_messages) && proof.prior_user_messages.length <= 5, 'at most five prior user messages');
  for (const m of proof.prior_memory) {
    requireCondition(m && typeof m.text === 'string' && Array.isArray(m.tokens) && m.tokens.every(t => typeof t === 'string') && finite(m.weight) && finite(m.time), 'invalid memory record');
  }
  for (const m of proof.prior_user_messages) {
    requireCondition(m && m.type === 'user' && typeof m.text === 'string', 'invalid user message');
  }
  requireCondition(proof.result && typeof proof.result === 'object', 'result missing');
}

function loadEvaluator() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('function tokenize(');
  const end = html.indexOf('/* ==================== PLASMA FIELD SIMULATION', start);
  requireCondition(start !== -1 && end > start, 'model source not found');
  const context = vm.createContext({});
  vm.runInContext(html.slice(start, end), context, { timeout: 1000 });
  return context;
}

function matchNumber(actual, expected, label) {
  requireCondition(finite(actual) && Math.abs(actual - expected) <= 1e-10, `${label} does not match the model`);
}

function matchReceipt(recorded, computed, label) {
  requireCondition(recorded && typeof recorded === 'object', `${label} receipt missing`);
  for (const key of ['before', 'delta', 'after']) matchNumber(recorded[key], computed[key], `${label}.${key}`);
  requireCondition(recorded.clamped === computed.clamped, `${label}.clamped does not match the model`);
  requireCondition(Array.isArray(recorded.terms) && recorded.terms.length === computed.terms.length, `${label}.terms length does not match`);
  computed.terms.forEach((term, i) => {
    requireCondition(recorded.terms[i] && recorded.terms[i].label === term.label, `${label}.terms[${i}] label does not match`);
    matchNumber(recorded.terms[i].value, term.value, `${label}.terms[${i}] value`);
  });
}

function verifyProof(proof) {
  checkShape(proof);
  const context = loadEvaluator();
  context.proof = proof;
  const computed = vm.runInContext(`({
    actual: evaluateCoherence(proof.input, {
      coherence: proof.start_mu, memory: proof.prior_memory,
      messages: proof.prior_user_messages
    }, proof.evaluated_at),
    control: evaluateCoherence(proof.input, {
      coherence: proof.start_mu, memory: [], messages: []
    }, proof.evaluated_at)
  })`, context, { timeout: 1000 });
  matchReceipt(proof.result.actual, computed.actual, 'actual');
  matchReceipt(proof.result.control, computed.control, 'control');
  matchNumber(proof.result.history_effect, computed.actual.after - computed.control.after, 'history effect');
  return { withHistory: computed.actual.after, withoutHistory: computed.control.after,
    effect: computed.actual.after - computed.control.after };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node tools/verify-proof.cjs <proof.json>');
    const file = process.argv[2];
    if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Error('Proof exceeds the 16 MiB verifier limit');
    const result = verifyProof(JSON.parse(fs.readFileSync(file, 'utf8')));
    console.log(`PASS: with history ${result.withHistory.toFixed(5)}, without history ${result.withoutHistory.toFixed(5)}, effect ${result.effect.toFixed(5)}`);
    console.log('Recomputed against the local model source. This checks consistency, not authenticity or scientific validity.');
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { verifyProof, loadEvaluator, matchReceipt, matchNumber, requireCondition };
