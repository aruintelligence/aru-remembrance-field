"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { evaluateBenchmark } = require("../tools/benchmark-evidence.cjs");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "research", "evidence-challenge.json"), "utf8"));
const copy = () => structuredClone(fixture);

test("the committed challenge exercises answers, citations, and abstentions", () => {
  const report = evaluateBenchmark(fixture);
  assert.deepEqual(report.summary, {
    cases: 12, correct: 12, answerable: 4, correct_answers: 4,
    correct_abstentions: 8, unexpected_abstentions: 0, unsafe_answers: 0
  });
  assert.match(report.model_sha256, /^[0-9a-f]{64}$/);
});

test("a wrong value or omitted source is counted as an unsafe answer", () => {
  const wrongValue = copy();
  wrongValue.cases[0].expected.value = "blue";
  assert.equal(evaluateBenchmark(wrongValue).summary.unsafe_answers, 1);

  const missingCitation = copy();
  missingCitation.cases[2].expected.sources = [11];
  const report = evaluateBenchmark(missingCitation);
  assert.equal(report.summary.unsafe_answers, 1);
  assert.equal(report.results[2].correct, false);
  assert.deepEqual(report.results[2].actual.sources, [11, 12]);
});

test("an answer on an expected abstention and a missed answer are distinguished", () => {
  const unexpectedAnswer = copy();
  unexpectedAnswer.cases[3].claims[0].key = "favorite food";
  assert.equal(evaluateBenchmark(unexpectedAnswer).summary.unsafe_answers, 1);

  const missedAnswer = copy();
  missedAnswer.cases[0].question = "What is favorite food?";
  const report = evaluateBenchmark(missedAnswer);
  assert.equal(report.summary.unexpected_abstentions, 1);
  assert.equal(report.summary.unsafe_answers, 0);
});

test("invalid labels and duplicate source records fail before scoring", () => {
  const badLabel = copy();
  badLabel.cases[0].expected.sources = [999];
  assert.throws(() => evaluateBenchmark(badLabel), /expected sources/);

  const duplicate = copy();
  duplicate.cases[2].claims[1].id = 11;
  assert.throws(() => evaluateBenchmark(duplicate), /duplicate claim/);
});

test("the CLI emits a machine-readable report and exits nonzero for mismatches", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aru-evidence-"));
  try {
    const file = path.join(dir, "challenge.json");
    const changed = copy();
    changed.cases[0].expected.value = "blue";
    fs.writeFileSync(file, JSON.stringify(changed));
    const cli = path.join(__dirname, "..", "tools", "benchmark-evidence.cjs");
    const result = spawnSync(process.execPath, [cli, "--json", file], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.correct, 11);
    assert.equal(report.summary.unsafe_answers, 1);
    assert.match(report.challenge_sha256, /^[0-9a-f]{64}$/);

    fs.writeFileSync(file, "{");
    const malformed = spawnSync(process.execPath, [cli, file], { encoding: "utf8" });
    assert.equal(malformed.status, 2);
    assert.match(malformed.stderr, /not valid JSON/);

    fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1, 32));
    const oversized = spawnSync(process.execPath, [cli, file], { encoding: "utf8" });
    assert.equal(oversized.status, 2);
    assert.match(oversized.stderr, /exceeds 1 MiB/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
