#!/usr/bin/env node
"use strict";

const { loadModel } = require("./benchmark-evidence.cjs");

const GENERATOR = "mulberry32-v1";
const WORDS = ["harbor", "violet", "signal", "maple", "orbit", "quartz", "river", "garden"];
const VALUES = ["teal", "amber", "north", "seven", "<svg onload=alert(1)>"];

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

function fullwidth(text) {
  return text.replace(/[A-Za-z0-9]/g, char => String.fromCharCode(char.charCodeAt(0) + 0xFEE0))
    .replace(/ /g, "　");
}

function generatedCase(next, index) {
  const name = `${WORDS[next() % WORDS.length]} ${WORDS[next() % WORDS.length]} ${next() % 100000}`;
  const value = VALUES[next() % VALUES.length];
  const count = 1 + next() % 4;
  const keys = [name, name.toUpperCase(), name.replace(/ /g, "   "), fullwidth(name)];
  const claims = Array.from({length: count}, (_, i) => ({
    id: i + 1, key: keys[next() % keys.length], value,
    time: 1700000000000 + index * 1000 + i, status: "active", imported: (next() % 2) === 0
  }));
  return {name, value, claims, ids: claims.map(claim => claim.id)};
}

function sameAnswer(actual, expected) {
  if (!actual || actual.kind !== expected.kind) return false;
  if (expected.kind !== "known" && Object.hasOwn(actual, "value")) return false;
  if (Object.hasOwn(expected, "value") && actual.value !== expected.value) return false;
  if (Object.hasOwn(expected, "sources")) {
    if (!Array.isArray(actual.sources)) return false;
    const ordered = list => [...list].sort((a, b) => a - b);
    if (JSON.stringify(ordered(actual.sources)) !== JSON.stringify(ordered(expected.sources))) return false;
  }
  if (Object.hasOwn(expected, "names")) {
    if (!Array.isArray(actual.names)) return false;
    const normalize = name => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    const ordered = list => list.map(normalize).sort();
    if (JSON.stringify(ordered(actual.names)) !== JSON.stringify(ordered(expected.names))) return false;
  }
  if (["empty", "unsupported", "missing"].includes(expected.kind) &&
      (Object.hasOwn(actual, "sources") || Object.hasOwn(actual, "names"))) return false;
  return true;
}

function runFalsifier({seed = 20261015, runs = 1000, model = loadModel()} = {}) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF ||
      !Number.isInteger(runs) || runs < 1 || runs > 10000) {
    throw new Error("Seed must be a 32-bit unsigned integer; runs must be 1–10000.");
  }
  const next = random(seed);
  const report = {
    format: "aru-evidence-falsifier-report", version: 1, generator: GENERATOR,
    seed, runs_requested: runs, runs_completed: 0, checks: 0, model_sha256: model.hash,
    passed: true, failure: null
  };
  for (let index = 0; index < runs; index++) {
    const {name, value, claims, ids} = generatedCase(next, index);
    const question = `What is ${name}?`;
    const known = {kind: "known", value, sources: ids};
    const added = {id: ids.length + 1, key: fullwidth(name), value,
      time: 1700000000000 + index * 1000 + 9, status: "active", imported: true};
    const different = {id: ids.length + 1, key: name, value: value === "teal" ? "TEAL" : "teal",
      time: added.time, status: "active", imported: false};
    const scenarios = [
      ["complete_sources", question, claims, known],
      ["unicode_question", `What’s my ${fullwidth(name.toUpperCase())}?`, claims, known],
      ["permutation", question, [...claims].reverse(), known],
      ["irrelevant_record", question, [...claims, {...added, key: `other ${name}`}], known],
      ["agreeing_source", question, [...claims, added], {kind: "known", value, sources: [...ids, added.id]}],
      ["conflict_abstains", question, [...claims, different], {kind: "conflict", sources: [...ids, different.id]}],
      ["historical_abstains", question, claims.map(claim => ({...claim, status: "superseded"})),
        {kind: "historical", sources: ids}],
      ["selected_source", question, claims.map((claim, i) => ({...claim, status: i === 0 ? "active" : "superseded"})),
        {kind: "known", value, sources: [ids[0]]}],
      ["possessive_ambiguity", `What is my ${name}?`, [...claims, {...different, key: `my ${name}`}],
        {kind: "ambiguous", names: [name, `my ${name}`]}],
      ["unknown_name", `What is unseen ${name}?`, claims, {kind: "missing"}],
      ["near_name", `What is ${name} extra?`, claims, {kind: "missing"}],
      ["unsupported_grammar", `Who recorded ${name}?`, claims, {kind: "unsupported"}],
      ["length_limit", `${question} ${"x".repeat(201)}`, claims, {kind: "unsupported"}]
    ];
    for (const [property, query, records, expected] of scenarios) {
      const before = JSON.stringify(records);
      let actual;
      try { actual = model.resolve(query, records); }
      catch (error) { actual = {error: error.message}; }
      report.checks++;
      const mutated = JSON.stringify(records) !== before;
      if (mutated || !sameAnswer(actual, expected)) {
        report.passed = false;
        report.failure = {
          case_index: index, property: mutated ? "input_not_mutated" : property,
          question: query, claims: JSON.parse(before), expected, actual,
          ...(mutated ? {claims_after: records} : {})
        };
        break;
      }
    }
    report.runs_completed++;
    if (!report.passed) break;
  }
  return report;
}

function parseArgs(args) {
  const options = {};
  let json = false;
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
    seen.add(flag);
    if (flag === "--json") { json = true; continue; }
    if (flag !== "--seed" && flag !== "--runs") {
      throw new Error("Usage: node tools/falsify-evidence.cjs [--seed UINT32] [--runs 1..10000] [--json]");
    }
    const value = args[++i];
    if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${flag} needs a nonnegative integer`);
    options[flag === "--seed" ? "seed" : "runs"] = Number(value);
  }
  return {options, json};
}

function run(args) {
  const {options, json} = parseArgs(args);
  const report = runFalsifier(options);
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(`${report.passed ? "PASS" : "FAIL"}: ${report.runs_completed}/${report.runs_requested} generated cases; ` +
      `${report.checks} property checks; seed ${report.seed}; ${report.generator}\n` +
      `Model SHA-256: ${report.model_sha256}\n`);
    if (!report.passed) process.stdout.write(`${JSON.stringify(report.failure, null, 2)}\n`);
  }
  return report.passed ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}

module.exports = { runFalsifier, run };
