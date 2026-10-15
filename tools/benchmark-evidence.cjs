#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");

const MAX_BYTES = 1024 * 1024;
const KINDS = new Set(["empty", "unsupported", "missing", "ambiguous", "historical", "conflict", "known"]);

function invalid(message) {
  throw new Error(`Invalid benchmark: ${message}`);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value, names, label) {
  for (const key of Object.keys(value)) if (!names.includes(key)) invalid(`${label} has unexpected field ${JSON.stringify(key)}`);
  for (const key of names) if (!(key in value)) invalid(`${label} is missing ${key}`);
}

function extract(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0 || source.indexOf(start, a + 1) !== -1) {
    throw new Error("The evidence model could not be isolated from index.html.");
  }
  return source.slice(a, b);
}

function loadModel() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const source = [
    extract(html, "function normalizeFactKey(", "function storedClaims("),
    extract(html, "function lookupFact(", "function askEvidence(")
  ].join("\n");
  const context = vm.createContext(Object.create(null));
  vm.runInContext(source, context, { timeout: 1000 });
  return {
    hash: createHash("sha256").update(source).digest("hex"),
    validClaim: claim => vm.runInContext("validFactClaim(claim)", Object.assign(context, { claim }), { timeout: 1000 }),
    resolve(question, claims) {
      context.question = question;
      context.claims = claims;
      const result = vm.runInContext("resolveEvidenceQuestion(question, claims)", context, { timeout: 1000 });
      // Copy only the answer fields. The model's conflict records are not emitted in full.
      if (result.kind === "known") return { kind: "known", value: result.value, sources: Array.from(result.sources) };
      if (result.kind === "conflict" || result.kind === "historical") {
        return { kind: result.kind, sources: Array.from(result.records, record => record.id) };
      }
      if (result.kind === "ambiguous") return { kind: result.kind, names: Array.from(result.names) };
      return { kind: result.kind };
    }
  };
}

function validate(challenge, model) {
  if (!object(challenge)) invalid("root must be an object");
  fields(challenge, ["format", "version", "title", "cases"], "root");
  if (challenge.format !== "aru-evidence-benchmark" || challenge.version !== 1) {
    invalid("expected format aru-evidence-benchmark, version 1");
  }
  if (typeof challenge.title !== "string" || !challenge.title.trim() || challenge.title.length > 120) {
    invalid("title must have 1–120 characters");
  }
  if (!Array.isArray(challenge.cases) || challenge.cases.length < 1 || challenge.cases.length > 100) {
    invalid("cases must contain 1–100 items");
  }
  const caseIds = new Set();
  for (const [index, item] of challenge.cases.entries()) {
    const label = `case ${index + 1}`;
    if (!object(item)) invalid(`${label} must be an object`);
    fields(item, ["id", "claims", "question", "expected"], label);
    if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.id) || caseIds.has(item.id)) {
      invalid(`${label} needs a unique lowercase id (letters, digits, _ or -)`);
    }
    caseIds.add(item.id);
    if (!Array.isArray(item.claims) || item.claims.length > 100) invalid(`${item.id}: claims must have at most 100 records`);
    const claimIds = new Set();
    for (const claim of item.claims) {
      if (!model.validClaim(claim) || claimIds.has(claim.id)) invalid(`${item.id}: invalid or duplicate claim`);
      claimIds.add(claim.id);
    }
    if (typeof item.question !== "string" || item.question.length > 500) {
      invalid(`${item.id}: question must be a string of at most 500 characters`);
    }
    const expected = item.expected;
    if (!object(expected) || !KINDS.has(expected.kind)) invalid(`${item.id}: unknown expected kind`);
    if (expected.kind === "known") {
      fields(expected, ["kind", "value", "sources"], `${item.id}.expected`);
      if (typeof expected.value !== "string" || !expected.value.trim()) invalid(`${item.id}: expected value must be nonempty`);
      if (!Array.isArray(expected.sources) || !expected.sources.length ||
          new Set(expected.sources).size !== expected.sources.length ||
          expected.sources.some(id => !claimIds.has(id))) {
        invalid(`${item.id}: expected sources must be distinct claim IDs in this case`);
      }
    } else {
      fields(expected, ["kind"], `${item.id}.expected`);
    }
  }
}

function evaluateBenchmark(challenge, model = loadModel()) {
  validate(challenge, model);
  const results = challenge.cases.map(item => {
    const actual = model.resolve(item.question, item.claims);
    const expected = item.expected;
    const correct = expected.kind === actual.kind && (expected.kind !== "known" ||
      (expected.value === actual.value &&
       JSON.stringify([...expected.sources].sort((a, b) => a - b)) ===
       JSON.stringify([...actual.sources].sort((a, b) => a - b))));
    return { id: item.id, expected, actual, correct, unsafe_answer: actual.kind === "known" && !correct };
  });
  const count = predicate => results.filter(predicate).length;
  return {
    format: "aru-evidence-benchmark-report", version: 1, title: challenge.title,
    model_sha256: model.hash,
    summary: {
      cases: results.length,
      correct: count(r => r.correct),
      answerable: count(r => r.expected.kind === "known"),
      correct_answers: count(r => r.expected.kind === "known" && r.correct),
      correct_abstentions: count(r => r.expected.kind !== "known" && r.correct),
      unexpected_abstentions: count(r => r.expected.kind === "known" && r.actual.kind !== "known"),
      unsafe_answers: count(r => r.unsafe_answer)
    },
    results
  };
}

function readLimited(file) {
  const fd = fs.openSync(file, "r");
  try {
    if (fs.fstatSync(fd).size > MAX_BYTES) invalid("file exceeds 1 MiB");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_BYTES) invalid("file exceeds 1 MiB");
    return buffer.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}

function run(argv) {
  const json = argv.includes("--json");
  const args = argv.filter(arg => arg !== "--json");
  if (args.length !== 1 || args[0].startsWith("--")) {
    throw new Error("Usage: node tools/benchmark-evidence.cjs [--json] path/to/challenge.json");
  }
  const file = args[0];
  const bytes = readLimited(file);
  let challenge;
  try { challenge = JSON.parse(bytes.toString("utf8")); }
  catch (_) { invalid("file is not valid JSON"); }
  const report = evaluateBenchmark(challenge);
  report.challenge_sha256 = createHash("sha256").update(bytes).digest("hex");
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const s = report.summary;
    process.stdout.write(`Evidence challenge: ${JSON.stringify(report.title)}\n` +
      `Exact cases: ${s.correct}/${s.cases} | Correct answers: ${s.correct_answers}/${s.answerable} | ` +
      `Correct abstentions: ${s.correct_abstentions} | Unexpected abstentions: ${s.unexpected_abstentions} | ` +
      `Unsafe answers: ${s.unsafe_answers}\n`);
    for (const r of report.results) {
      process.stdout.write(`${r.correct ? "PASS" : "FAIL"} ${r.id}: expected ${r.expected.kind}, got ${r.actual.kind}` +
        `${r.unsafe_answer ? " (unsafe answer or citation)" : ""}\n`);
    }
    process.stdout.write(`Challenge SHA-256: ${report.challenge_sha256}\nModel SHA-256: ${report.model_sha256}\n`);
  }
  return report.summary.correct === report.summary.cases ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}

module.exports = { evaluateBenchmark, loadModel, run };
