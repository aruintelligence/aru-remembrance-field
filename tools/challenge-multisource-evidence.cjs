#!/usr/bin/env node
"use strict";

// Probe source competition against the existing browser and independent Python
// answer rules. Cases are synthetic and never read the user's ledger.
const fs = require("node:fs");
const path = require("node:path");
const {createHash} = require("node:crypto");
const {spawnSync} = require("node:child_process");
const {isDeepStrictEqual} = require("node:util");
const {loadModel} = require("./benchmark-evidence.cjs");

const GENERATOR = "aru-multisource-competition-v1";
const ROOT = path.join(__dirname, "probe-independent-evidence.py");
const KEY_VARIANTS = ["city hall", "CITY HALL", "city\u00a0hall", "ｃｉｔｙ hall",
  "city\u0085hall", "my city hall", "other", "\ufeffcity hall", "city\u200bhall"];
const QUESTIONS = ["What is city hall?", "What is my city hall?", "What is city\u00a0hall?",
  "What is city\u0085hall?", "What is other?", "Where is city hall?",
  "What is city\u2028hall?", "What's CITY HALL?"];
const BRIEFS = [["city hall", "other"], ["my city hall", "city hall"],
  ["city\u0085hall", "city hall", "other"]];

const record = (id, key, value = "Portland", status = "active") =>
  ({id, key, value, time: 1700000000000 + id, status, imported: false});

const FIXED = [
  {label: "empty-ledger", records: [], question: "What is city hall?"},
  {label: "empty-question", records: [record(1, "city hall")], question: " \ufeff "},
  {label: "one-source", records: [record(1, "city hall")], question: "What is city hall?"},
  {label: "unknown-name", records: [record(1, "city hall")], question: "What is other?"},
  {label: "consistent-sources", records: [record(1, "city hall"), record(2, "CITY\u00a0HALL")], question: "What is city hall?"},
  {label: "conflicting-sources", records: [record(1, "city hall"), record(2, "CITY\u00a0HALL", "Salem")], question: "What is city hall?"},
  {label: "superseded-only", records: [record(1, "city hall", "Portland", "superseded")], question: "What is city hall?"},
  {label: "old-conflict-resolved", records: [record(1, "city hall", "Salem", "superseded"), record(2, "city hall")], question: "What is city hall?"},
  {label: "two-possible-names", records: [record(1, "my city hall"), record(2, "city hall", "Salem")], question: "What is my city hall?"},
  {label: "historical-ambiguity", records: [record(1, "my city hall", "Salem", "superseded"), record(2, "city hall")], question: "What is my city hall?"},
  {label: "record-order", records: [record(2, "city hall"), record(1, "CITY HALL")], question: "What is city hall?"},
  {label: "distinct-raw-values", records: [record(1, "city hall", "Portland"), record(2, "city hall", "PORTLAND")], question: "What is city hall?"},
  {label: "unsupported-grammar", records: [record(1, "city hall")], question: "Where is city hall?"},
  {label: "control-character-name", records: [record(1, "city\u0085hall")], question: "What is city hall?"},
  {label: "normalized-name", records: [record(1, "ｃｉｔｙ hall")], question: "What is city hall?"},
  {label: "duplicate-id", records: [record(1, "city hall"), record(1, "other")], question: "What is city hall?"},
  {label: "invalid-whitespace-value", records: [record(1, "city hall", "\ufeff")], question: "What is city hall?"},
  {label: "brief-partial", records: [record(1, "city hall")], names: ["city hall", "other"]},
  {label: "brief-conflict", records: [record(1, "city hall"), record(2, "CITY HALL", "Salem")], names: ["city hall", "other"]},
  {label: "brief-history", records: [record(1, "city hall", "Portland", "superseded")], names: ["city hall", "other"]},
  {label: "brief-control-character", records: [record(1, "city\u0085hall")], names: ["city\u0085hall", "city hall", "other"]}
];

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function generate(seed, runs) {
  const next = random(seed);
  const pick = items => items[next() % items.length];
  const cases = FIXED.slice(0, runs).map(item => JSON.parse(JSON.stringify(item)));
  for (let index = cases.length; index < runs; index++) {
    const count = next() % 6;
    const records = [];
    for (let i = 0; i < count; i++) {
      const key = pick(KEY_VARIANTS);
      const value = pick(["Portland", "Salem", "PORTLAND", "\u0085"]);
      const status = pick(["active", "active", "superseded"]);
      records.push(record(i + 1, key, value, status));
    }
    if (records.length > 1 && next() % 13 === 0) records.at(-1).id = 1;
    if (records.length && next() % 17 === 0) records[0].key = "\ufeff";
    const brief = next() % 4 === 0;
    cases.push({label: `generated-${index}`, records,
      ...(brief ? {names: pick(BRIEFS)} : {question: pick(QUESTIONS)})});
  }
  return cases;
}

function challenge({seed = 20261017, runs = 500, model = loadModel(), worker = ROOT} = {}) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff ||
      !Number.isSafeInteger(runs) || runs < 1 || runs > 2000) {
    throw new Error("Seed must be a uint32; runs must be 1–2000");
  }
  const cases = generate(seed, runs);
  const input = JSON.stringify({cases: cases.map(({records, question, names}) =>
    names ? {records, names} : {records, question})});
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error("Challenge input exceeds 2 MiB");
  const result = spawnSync("python3", [worker], {input, encoding: "utf8", timeout: 30000,
    maxBuffer: 4 * 1024 * 1024});
  if (result.error || result.status !== 0) throw new Error("Independent Python probe did not complete");
  let observed;
  try { observed = JSON.parse(result.stdout).results; }
  catch (_) { throw new Error("Independent Python probe returned invalid JSON"); }
  if (!Array.isArray(observed) || observed.length !== cases.length) {
    throw new Error("Independent Python probe returned the wrong number of cases");
  }
  const digest = name => createHash("sha256").update(fs.readFileSync(name)).digest("hex");
  const report = {format: "aru-multisource-concordance-challenge", version: 1,
    generator: GENERATOR, seed, runs_requested: runs,
    fixed_cases: Math.min(FIXED.length, runs), browser_model_sha256: model.hash,
    python_auditor_sha256: digest(path.join(path.dirname(worker), "independent-evidence-batch.py")),
    python_probe_sha256: digest(worker), passed: true, runs_completed: 0,
    coverage: {invalid: 0, empty: 0, unsupported: 0, missing: 0, known: 0,
      historical: 0, conflict: 0, ambiguous: 0}, first_disagreement: null};
  for (const [index, item] of cases.entries()) {
    const before = JSON.stringify(item.records);
    const valid = item.records.length <= 100 &&
      new Set(item.records.map(record => record.id)).size === item.records.length &&
      item.records.every(record => !!model.validClaim(record));
    const js = item.names ? {valid, brief: valid ? model.brief(item.names, item.records) : null} :
      {valid, answer: valid ? model.resolve(item.question, item.records) : null};
    if (JSON.stringify(item.records) !== before) throw new Error("Browser model mutated synthetic records");
    const py = observed[index];
    if (!py || typeof py.valid !== "boolean" ||
        !Object.hasOwn(py, item.names ? "brief" : "answer")) {
      throw new Error("Independent Python probe returned an invalid case");
    }
    report.runs_completed++;
    if (!isDeepStrictEqual(js, py)) {
      report.passed = false;
      report.first_disagreement = {case_index: index, ...item, browser: js, python: py};
      break;
    }
    if (!valid) report.coverage.invalid++;
    else if (item.names) for (const row of js.brief) report.coverage[row.answer.kind]++;
    else report.coverage[js.answer.kind]++;
  }
  return report;
}

function parseArgs(argv) {
  const options = {};
  const seen = new Set();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
    seen.add(flag);
    if (flag === "--json") { json = true; continue; }
    if (flag !== "--seed" && flag !== "--runs") {
      throw new Error("Usage: node tools/challenge-multisource-evidence.cjs [--seed UINT32] [--runs 1..2000] [--json]");
    }
    const value = argv[++i];
    if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${flag} needs a nonnegative integer`);
    options[flag === "--seed" ? "seed" : "runs"] = Number(value);
  }
  return options;
}

function run(argv = process.argv.slice(2)) {
  const report = challenge(parseArgs(argv));
  if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.passed ? "PASS" : "DISAGREEMENT"}: ${report.runs_completed}/${report.runs_requested} synthetic cases; seed ${report.seed}; ${report.generator}.`);
    console.log(`Coverage: ${JSON.stringify(report.coverage)}`);
    if (!report.passed) console.log(JSON.stringify(report.first_disagreement, null, 2));
    else console.log("No disagreement found in this bounded challenge. Evidence truth and untested cases remain unverified.");
  }
  return report.passed ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = run(); }
  catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 2; }
}

module.exports = {generate, challenge, run, FIXED};
