#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {createHash} = require("node:crypto");
const {spawnSync} = require("node:child_process");
const {isDeepStrictEqual} = require("node:util");
const {loadModel} = require("./benchmark-evidence.cjs");

const GENERATOR = "aru-unicode-boundaries-v1";
const JS_SPACE = [9, 10, 11, 12, 13, 0x20, 0xa0, 0x1680,
  ...Array.from({length: 11}, (_, i) => 0x2000 + i), 0x2028, 0x2029,
  0x202f, 0x205f, 0x3000, 0xfeff];
const EXTRA = [0x85, 0x1c, 0x1d, 0x1e, 0x1f, 0x180e, 0x200b, 0x2060];
const CODEPOINTS = [...JS_SPACE, ...EXTRA];
const SCENARIOS = ["key_inner", "question_gap", "key_edges", "value_only",
  "possessive_gap", "line_in_question"];
const SPECIAL_GRAMMAR = [{codepoint: 0x17f, spelling: "iſ"},
  {codepoint: 0x130, spelling: "İs"}, {codepoint: 0x131, spelling: "ıs"}];
const SPACE_CASES = CODEPOINTS.length * SCENARIOS.length;
const SYSTEMATIC = SPACE_CASES + SPECIAL_GRAMMAR.length;

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
  const result = [];
  for (let i = 0; i < runs; i++) {
    const cp = i < SPACE_CASES ? CODEPOINTS[Math.floor(i / SCENARIOS.length)] :
      i < SYSTEMATIC ? SPECIAL_GRAMMAR[i - SPACE_CASES].codepoint :
      CODEPOINTS[next() % CODEPOINTS.length];
    const scenario = i < SPACE_CASES ? SCENARIOS[i % SCENARIOS.length] :
      i < SYSTEMATIC ? "grammar_case" :
      SCENARIOS[next() % SCENARIOS.length];
    const sep = String.fromCodePoint(cp);
    const base = `city hall ${i}`;
    const record = {id: 1, key: base, value: "Portland", time: 1700000000000 + i,
      status: "active", imported: false};
    let question = `What is ${base}?`;
    if (scenario === "key_inner") record.key = `city${sep}hall ${i}`;
    if (scenario === "question_gap") question = `What${sep}is ${base}?`;
    if (scenario === "key_edges") record.key = `${sep}${base}${sep}`;
    if (scenario === "value_only") record.value = sep;
    if (scenario === "possessive_gap") question = `What is my${sep}${base}?`;
    if (scenario === "line_in_question") question = `What is city${sep}hall ${i}?`;
    if (scenario === "grammar_case") question =
      `What ${SPECIAL_GRAMMAR[i - SPACE_CASES].spelling} ${base}?`;
    result.push({codepoint: cp, scenario, record, question});
  }
  return result;
}

function challenge({seed = 20261017, runs = 400, model = loadModel(),
  worker = path.join(__dirname, "probe-independent-evidence.py")} = {}) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff ||
      !Number.isSafeInteger(runs) || runs < 1 || runs > 2000) {
    throw new Error("Seed must be a uint32; runs must be 1–2000");
  }
  const cases = generate(seed, runs);
  const input = JSON.stringify({cases: cases.map(({record, question}) => ({record, question}))});
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error("Challenge input exceeds 2 MiB");
  const result = spawnSync("python3", [worker], {encoding: "utf8", input, timeout: 30000,
    maxBuffer: 4 * 1024 * 1024});
  if (result.error || result.status !== 0) {
    throw new Error("Independent Python probe did not complete");
  }
  let observations;
  try { observations = JSON.parse(result.stdout).results; }
  catch (_) { throw new Error("Independent Python probe returned invalid JSON"); }
  if (!Array.isArray(observations) || observations.length !== cases.length) {
    throw new Error("Independent Python probe returned the wrong number of cases");
  }
  const digest = name => createHash("sha256").update(fs.readFileSync(name)).digest("hex");
  const auditor = path.join(path.dirname(worker), "independent-evidence-batch.py");
  const report = {format: "aru-verifier-boundary-challenge", version: 1,
    generator: GENERATOR, seed, runs_requested: runs, systematic_cases: Math.min(SYSTEMATIC, runs),
    browser_model_sha256: model.hash,
    python_auditor_sha256: digest(auditor),
    python_probe_sha256: digest(worker), passed: true, runs_completed: 0, first_disagreement: null};
  for (const [index, item] of cases.entries()) {
    const before = JSON.stringify(item.record);
    const valid = !!model.validClaim(item.record);
    const js = {valid, answer: valid ? model.resolve(item.question, [item.record]) : null};
    if (JSON.stringify(item.record) !== before) throw new Error("Browser model mutated a synthetic record");
    const py = observations[index];
    if (!py || typeof py.valid !== "boolean" || !Object.hasOwn(py, "answer")) {
      throw new Error("Independent Python probe returned an invalid case");
    }
    report.runs_completed++;
    if (!isDeepStrictEqual(js, py)) {
      report.passed = false;
      report.first_disagreement = {case_index: index,
        codepoint: `U+${item.codepoint.toString(16).toUpperCase().padStart(4, "0")}`,
        scenario: item.scenario, record: item.record, question: item.question,
        browser: js, python: py};
      break;
    }
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
      throw new Error("Usage: node tools/challenge-verifier-boundaries.cjs [--seed UINT32] [--runs 1..2000] [--json]");
    }
    const value = argv[++i];
    if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${flag} needs a nonnegative integer`);
    options[flag === "--seed" ? "seed" : "runs"] = Number(value);
  }
  return {options, json};
}

function run(argv = process.argv.slice(2)) {
  const {options, json} = parseArgs(argv);
  const report = challenge(options);
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.passed ? "PASS" : "DISAGREEMENT"}: ${report.runs_completed}/${report.runs_requested} synthetic cases; seed ${report.seed}; ${report.generator}.`);
    console.log(`Browser model SHA-256: ${report.browser_model_sha256}`);
    console.log(`Python auditor SHA-256: ${report.python_auditor_sha256}`);
    if (!report.passed) console.log(JSON.stringify(report.first_disagreement, null, 2));
    else console.log("No disagreement found in this bounded challenge. Evidence truth and untested cases remain unverified.");
  }
  return report.passed ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = run(); }
  catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 2; }
}

module.exports = {generate, challenge, run, JS_SPACE, EXTRA, SCENARIOS};
