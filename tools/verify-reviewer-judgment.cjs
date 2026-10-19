#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {createHash} = require("node:crypto");
const {parseUnambiguousJSON} = require("./unambiguous-json.cjs");

const SCENARIOS = [
  {id: "all_match", options: ["consistency", "truth", "custody"], correct: "consistency"},
  {id: "recorded_fail", options: ["all_pass", "one_failed", "no_check"], correct: "one_failed"},
  {id: "paired_difference", options: ["all_match", "chronology", "difference"], correct: "difference"},
  {id: "checker_disagreement", options: ["positive", "unconfirmed", "truth"], correct: "unconfirmed"},
  {id: "checkpoint", options: ["timestamp", "complete", "agreement"], correct: "agreement"}
];
const MAX_BYTES = 1024 * 1024;

function browserScriptSHA256() {
  const page = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const match = page.match(/<script>([\s\S]*?)<\/script>/);
  if (!match || page.indexOf("<script>", match.index + 1) !== -1) {
    throw new Error("Expected exactly one browser verifier script");
  }
  return createHash("sha256").update(match[1], "utf8").digest("hex");
}

function exact(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}

function verifyReviewerJudgment(report) {
  const names = ["format", "version", "revision", "browser_script_sha256", "order_method",
    "scenario_order", "answers", "score"];
  if (!exact(report, names) || report.format !== "aru-reviewer-judgment" ||
      report.version !== 1 || report.revision !== "aru-reviewer-judgment-1" ||
      report.browser_script_sha256 !== browserScriptSHA256() ||
      !["crypto_shuffle", "fixed_fallback"].includes(report.order_method) ||
      !Array.isArray(report.scenario_order) ||
      report.scenario_order.length !== SCENARIOS.length ||
      new Set(report.scenario_order).size !== SCENARIOS.length ||
      !report.scenario_order.every(id => SCENARIOS.some(item => item.id === id)) ||
      (report.order_method === "fixed_fallback" &&
        report.scenario_order.some((id, index) => id !== SCENARIOS[index].id)) ||
      !Array.isArray(report.answers) || report.answers.length !== SCENARIOS.length ||
      !exact(report.score, ["correct", "total"])) {
    throw new Error("Unsupported, incomplete, or code-mismatched judgment report");
  }
  let correct = 0;
  for (const [index, answer] of report.answers.entries()) {
    const scenario = SCENARIOS.find(item => item.id === report.scenario_order[index]);
    if (!exact(answer, ["scenario", "choice"]) || answer.scenario !== scenario.id ||
        !scenario.options.includes(answer.choice)) {
      throw new Error(`Invalid choice at decision ${index + 1}`);
    }
    if (answer.choice === scenario.correct) correct++;
  }
  if (report.score.correct !== correct || report.score.total !== SCENARIOS.length) {
    throw new Error("Recorded score does not match the selected choices");
  }
  return {correct, total: SCENARIOS.length, answers: report.answers,
    order_method: report.order_method};
}

function readReviewerJudgment(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Report must be a regular file of at most 1 MiB");
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_BYTES) throw new Error("Report exceeds 1 MiB");
  let parsed;
  try { parsed = parseUnambiguousJSON(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
  catch (_) { throw new Error("Report is not unambiguous UTF-8 JSON"); }
  return {bytes, result: verifyReviewerJudgment(parsed)};
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node tools/verify-reviewer-judgment.cjs <report.json>");
    const {result} = readReviewerJudgment(process.argv[2]);
    console.log(`PASS: ${result.correct}/${result.total} recorded choices match the fixed exercise key.`);
    console.log("This checks file structure and scoring under the archived page code; it cannot establish who answered or whether a person understood the exercise.");
  } catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
}

module.exports = {SCENARIOS, verifyReviewerJudgment, readReviewerJudgment};
