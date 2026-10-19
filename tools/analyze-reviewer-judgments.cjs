#!/usr/bin/env node
"use strict";

const {createHash} = require("node:crypto");
const {SCENARIOS, readReviewerJudgment} = require("./verify-reviewer-judgment.cjs");

function analyze(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 100 ||
      files.some(file => typeof file !== "string" || !file)) {
    throw new Error("Provide 1–100 local judgment report files");
  }
  const byScenario = Object.fromEntries(SCENARIOS.map(item => [item.id,
    {correct: 0, selections: Object.fromEntries(item.options.map(option => [option, 0]))}]));
  const firstBytes = new Map();
  let exactCopies = 0, correct = 0, randomized = 0;
  for (const file of files) {
    const {bytes, result} = readReviewerJudgment(file);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const candidates = firstBytes.get(hash) || [];
    if (candidates.some(other => bytes.equals(other))) exactCopies++;
    else { candidates.push(bytes); firstBytes.set(hash, candidates); }
    correct += result.correct;
    if (result.order_method === "crypto_shuffle") randomized++;
    for (const row of result.answers) {
      byScenario[row.scenario].selections[row.choice]++;
      if (row.choice === SCENARIOS.find(item => item.id === row.scenario).correct) {
        byScenario[row.scenario].correct++;
      }
    }
  }
  return {format: "aru-reviewer-judgment-summary", version: 1, files: files.length,
    exact_byte_copies: exactCopies, reported_crypto_shuffles: randomized,
    decisions: files.length * SCENARIOS.length, correct, by_scenario: byScenario};
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const json = args.filter(item => item === "--json").length;
    if (json > 1 || args.some(item => item.startsWith("--") && item !== "--json")) {
      throw new Error("Usage: node tools/analyze-reviewer-judgments.cjs [--json] <report.json>...");
    }
    const result = analyze(args.filter(item => item !== "--json"));
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.files} report files; ${result.correct}/${result.decisions} keyed decisions; ${result.exact_byte_copies} exact byte copies.`);
      for (const [id, item] of Object.entries(result.by_scenario)) {
        console.log(`${id}: ${item.correct}/${result.files} keyed; choices ${JSON.stringify(item.selections)}.`);
      }
      console.log("These are file counts, not verified people or an unbiased sample. Reports can be edited; truth and custody are outside this exercise.");
    }
  } catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
}

module.exports = {analyze};
