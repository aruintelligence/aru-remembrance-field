#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { loadModel } = require("./benchmark-evidence.cjs");

const MAX_BYTES = 1024 * 1024;
const MODEL_REVISION = "aru-evidence-questions-1";
const BRIEF_REVISION = "aru-evidence-briefs-1";
const CLAIM_FIELDS = new Set(["id", "key", "value", "time", "status", "imported"]);

function requireValid(condition, message) {
  if (!condition) throw new Error(`Invalid receipt: ${message}`);
}

function verifyBriefReceipt(receipt, model) {
  const keys = ["format", "version", "model_revision", "names", "records", "results"];
  requireValid(keys.every(key => Object.hasOwn(receipt, key)) &&
    Object.keys(receipt).every(key => keys.includes(key)) &&
    receipt.version === 1 && receipt.model_revision === BRIEF_REVISION,
    "unsupported brief format or model revision");
  requireValid(Array.isArray(receipt.names) && receipt.names.length >= 2 && receipt.names.length <= 8,
    "brief requires 2–8 names");
  const normalized = new Set();
  for (const name of receipt.names) {
    requireValid(typeof name === "string" && !!name.trim() && name === name.trim() &&
      name.length <= 120 && !/[\r\n]/.test(name), "invalid brief name");
    const key = name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    requireValid(!normalized.has(key), "duplicate brief name");
    normalized.add(key);
  }
  requireValid(Array.isArray(receipt.records) && receipt.records.length <= 100,
    "invalid brief record count");
  const ids = new Set();
  for (const record of receipt.records) {
    requireValid(model.validClaim(record) && Object.keys(record).every(key => CLAIM_FIELDS.has(key)) &&
      (record.imported === undefined || typeof record.imported === "boolean") && !ids.has(record.id),
      "invalid or duplicate record");
    ids.add(record.id);
  }
  const computed = model.brief(receipt.names, receipt.records);
  try { assert.deepStrictEqual(receipt.results, computed); }
  catch (_) { requireValid(false, "brief results or citations do not match the local model and supplied records"); }
  return {kind: "brief", names: computed.length, known: computed.filter(item => item.answer.kind === "known").length,
    records: ids.size, scope: "full-supplied-snapshot", model_sha256: model.hash};
}

function verifyEvidenceReceipt(receipt, model = loadModel()) {
  requireValid(receipt && typeof receipt === "object" && !Array.isArray(receipt), "object expected");
  if (receipt.format === "aru-evidence-brief-receipt") return verifyBriefReceipt(receipt, model);
  const excerpt = receipt.format === "aru-evidence-answer-excerpt";
  const keys = ["format", "version", "model_revision", "question", "records", "answer",
    ...(excerpt ? ["scope"] : [])];
  requireValid(keys.every(key => Object.hasOwn(receipt, key)) &&
    Object.keys(receipt).every(key => keys.includes(key)), "unexpected or missing receipt field");
  requireValid((receipt.format === "aru-evidence-question-receipt" || excerpt) && receipt.version === 1 &&
    receipt.model_revision === MODEL_REVISION, "unsupported format or model revision");
  if (excerpt) requireValid(receipt.scope === "cited-assertions-only", "unsupported excerpt scope");
  requireValid(typeof receipt.question === "string" && receipt.question.length <= 500, "invalid question");
  requireValid(Array.isArray(receipt.records) && receipt.records.length <= 100 &&
    (!excerpt || receipt.records.length > 0), "invalid record count");
  const ids = new Set();
  for (const record of receipt.records) {
    requireValid(model.validClaim(record) && Object.keys(record).every(key => CLAIM_FIELDS.has(key)) &&
      (record.imported === undefined || typeof record.imported === "boolean") && !ids.has(record.id),
      "invalid or duplicate record");
    ids.add(record.id);
  }
  const computed = model.resolve(receipt.question, receipt.records);
  try { assert.deepStrictEqual(receipt.answer, computed); }
  catch (_) { requireValid(false, "recorded answer does not match the local model and supplied records"); }
  if (excerpt) {
    requireValid(computed.kind === "known", "excerpt requires a sourced answer");
    requireValid(receipt.records.every(record => record.status === "active") &&
      receipt.records.length === computed.sources.length &&
      receipt.records.every(record => computed.sources.includes(record.id)),
    "excerpt must contain exactly its cited active assertions");
  }
  return { kind: computed.kind, sources: computed.sources || [], records: ids.size,
    scope: excerpt ? "cited-assertions-only" : "full-supplied-snapshot", model_sha256: model.hash };
}

function readLimited(file) {
  const fd = fs.openSync(file, "r");
  try {
    requireValid(fs.fstatSync(fd).size <= MAX_BYTES, "file exceeds 1 MiB");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    requireValid(length <= MAX_BYTES, "file exceeds 1 MiB");
    return buffer.subarray(0, length).toString("utf8");
  } finally { fs.closeSync(fd); }
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node tools/verify-evidence-receipt.cjs <receipt.json>");
    let receipt;
    try { receipt = JSON.parse(readLimited(process.argv[2])); }
    catch (error) { if (error instanceof SyntaxError) throw new Error("Invalid receipt: file is not valid JSON"); throw error; }
    const result = verifyEvidenceReceipt(receipt);
    if (result.kind === "brief") {
      console.log(`PASS: ${result.names} names; ${result.known} sourced answer${result.known === 1 ? "" : "s"}; ${result.names - result.known} refusal${result.names - result.known === 1 ? "" : "s"}; ${result.records} supplied records; scope ${result.scope}`);
    } else {
      console.log(`PASS: ${result.kind}; ${result.records} supplied records; ${result.sources.length} cited sources; scope ${result.scope}`);
    }
    console.log(`Local model SHA-256: ${result.model_sha256}`);
    console.log("This checks the answer against supplied records, not omitted ledger entries, origin, or factual truth.");
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { verifyEvidenceReceipt };
