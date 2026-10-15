"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { loadModel } = require("../tools/benchmark-evidence.cjs");
const { runFalsifier } = require("../tools/falsify-evidence.cjs");

test("seeded checks are reproducible and exercise distinct evidence properties", () => {
  const first = runFalsifier({seed: 0, runs: 25});
  const second = runFalsifier({seed: 0, runs: 25});
  assert.deepEqual(first, second);
  assert.equal(first.passed, true);
  assert.equal(first.checks, 25 * 13);
  assert.match(first.model_sha256, /^[0-9a-f]{64}$/);
});

test("fabricated answers on unsupported grammar produce a concrete counterexample", () => {
  const actual = loadModel();
  const broken = {...actual, resolve(question, claims) {
    if (question.startsWith("Who recorded ")) return {kind: "known", value: "invented", sources: [1]};
    return actual.resolve(question, claims);
  }};
  const report = runFalsifier({seed: 91, runs: 20, model: broken});
  assert.equal(report.passed, false);
  assert.equal(report.failure.property, "unsupported_grammar");
  assert.equal(report.failure.expected.kind, "unsupported");
  assert.equal(report.failure.actual.value, "invented");
  assert.equal(report.failure.case_index, 0);
  assert.equal(report.failure.question, "Who recorded garden orbit 35811?");
  assert.equal(report.failure.claims.length, 2);
});

test("mutating input records is detected even if the answer still matches", () => {
  const actual = loadModel();
  const broken = {...actual, resolve(question, claims) {
    claims[0].time++;
    return actual.resolve(question, claims);
  }};
  const report = runFalsifier({seed: 91, runs: 1, model: broken});
  assert.equal(report.passed, false);
  assert.equal(report.failure.property, "input_not_mutated");
  assert.equal(report.failure.claims_after[0].time, report.failure.claims[0].time + 1);
});

test("CLI JSON is machine-readable and rejects invalid limits", () => {
  const cli = path.join(__dirname, "..", "tools", "falsify-evidence.cjs");
  const result = spawnSync(process.execPath, [cli, "--seed", "7", "--runs", "3", "--json"], {encoding: "utf8"});
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks, 39);
  assert.equal(report.seed, 7);

  const invalid = spawnSync(process.execPath, [cli, "--seed", "4294967296"], {encoding: "utf8"});
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /32-bit unsigned integer/);
  assert.throws(() => runFalsifier({seed: 1, runs: 10001}), /1–10000/);
});
