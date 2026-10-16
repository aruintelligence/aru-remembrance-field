#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const fs = require("node:fs");
const {loadModel} = require("./benchmark-evidence.cjs");
const {verifyEvidenceReceipt, verifyLedgerBaseline, verifyLedgerCheckpoint} =
  require("./verify-evidence-receipt.cjs");

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * MAX_FILE_BYTES;
const MAX_RECEIPTS = 20;
const ANSWER_FORMATS = new Set([
  "aru-evidence-question-receipt", "aru-evidence-answer-excerpt", "aru-evidence-brief-receipt"
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readLimited(file, label) {
  if (!fs.statSync(file).isFile()) throw new Error(`${label} must be a regular file`);
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      throw new Error(`${label} must be a regular file of at most 1 MiB`);
    }
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_FILE_BYTES) throw new Error(`${label} exceeds 1 MiB`);
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}

function parseJSON(bytes, label) {
  try { return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
  catch (_) { throw new Error(`${label} is not valid UTF-8 JSON`); }
}

function auditEvidenceBatch(referenceFile, receiptFiles, {checkpointFile} = {}) {
  if (typeof referenceFile !== "string" || !referenceFile ||
      !Array.isArray(receiptFiles) || receiptFiles.length < 1 ||
      receiptFiles.length > MAX_RECEIPTS ||
      receiptFiles.some(file => typeof file !== "string" || !file)) {
    throw new Error(`Provide one reference and 1–${MAX_RECEIPTS} answer receipt files`);
  }
  const referenceBytes = readLimited(referenceFile, "Reference ledger");
  const checkpointBytes = checkpointFile === undefined ? null : readLimited(checkpointFile, "Checkpoint");
  const model = loadModel();
  const baseline = parseJSON(referenceBytes, "Reference ledger");
  verifyLedgerBaseline(baseline, model);
  if (checkpointBytes !== null) {
    const checkpoint = parseJSON(checkpointBytes, "Checkpoint");
    verifyLedgerCheckpoint(baseline, checkpoint, model);
  }
  const receiptBytes = receiptFiles.map((file, index) => readLimited(file, `Receipt #${index + 1}`));
  if (receiptBytes.reduce((sum, bytes) => sum + bytes.length, 0) > MAX_TOTAL_BYTES) {
    throw new Error("Selected receipts exceed the 4 MiB combined limit");
  }
  const firstCopies = new Map();
  const totals = {match: 0, differ: 0, fail: 0, identical_copies: 0};
  const receipts = receiptBytes.map((bytes, index) => {
    const digest = sha256(bytes);
    const candidates = firstCopies.get(digest) || [];
    const first = candidates.find(candidate => candidate.bytes.equals(bytes));
    const duplicateOf = first ? first.index : null;
    if (first) totals.identical_copies++;
    else { candidates.push({bytes, index: index + 1}); firstCopies.set(digest, candidates); }

    let verdict = "FAIL";
    let reason = "invalid-json";
    try {
      const receipt = parseJSON(bytes, `Receipt #${index + 1}`);
      reason = "unsupported-format";
      if (!ANSWER_FORMATS.has(receipt?.format)) throw new Error("Unsupported answer receipt");
      reason = "replay-failed";
      verifyEvidenceReceipt(receipt, model);
      reason = "reference-mismatch";
      try { verifyEvidenceReceipt(receipt, model, baseline); verdict = "MATCH"; reason = null; }
      catch (_) { verdict = "DIFFER"; }
    } catch (_) { /* Keep the file's last failed stage without disclosing its contents. */ }
    totals[verdict.toLowerCase()]++;
    return {index: index + 1, sha256: digest, verdict, reason, duplicate_of: duplicateOf};
  });
  return {
    format: "aru-evidence-batch-audit", version: 1,
    model_sha256: model.hash,
    verifier_sha256: sha256(fs.readFileSync(require.resolve("./verify-evidence-receipt.cjs"))),
    auditor_sha256: sha256(fs.readFileSync(__filename)),
    reference_sha256: sha256(referenceBytes),
    checkpoint_sha256: checkpointBytes === null ? null : sha256(checkpointBytes),
    receipts, totals
  };
}

function parseArgs(args) {
  let checkpointFile;
  let reportFile;
  let json = false;
  const files = [];
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (item === "--checkpoint" || item === "--check-report") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${item} requires a file`);
      if (item === "--checkpoint") {
        if (checkpointFile !== undefined) throw new Error("Duplicate --checkpoint option");
        checkpointFile = value;
      } else {
        if (reportFile !== undefined) throw new Error("Duplicate --check-report option");
        reportFile = value;
      }
    } else if (item === "--json") {
      if (json) throw new Error("Duplicate --json option");
      json = true;
    } else if (item.startsWith("--")) throw new Error(`Unknown option ${item}`);
    else files.push(item);
  }
  if (files.length < 2) throw new Error("Usage: node tools/audit-evidence-batch.cjs <reference.json> <receipt.json>... [--checkpoint prior.json] [--json] [--check-report saved-report.json]");
  return {referenceFile: files[0], receiptFiles: files.slice(1), checkpointFile, reportFile, json};
}

function run(args = process.argv.slice(2)) {
  const {referenceFile, receiptFiles, checkpointFile, reportFile, json} = parseArgs(args);
  const report = auditEvidenceBatch(referenceFile, receiptFiles, {checkpointFile});
  if (reportFile !== undefined) {
    const expected = parseJSON(readLimited(reportFile, "Saved report"), "Saved report");
    try { assert.deepStrictEqual(report, expected); }
    catch (_) { throw new Error("Saved report differs from the recomputed audit or ordered input bytes"); }
  }
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.receipts.length} selected: ${report.totals.match} MATCH, ${report.totals.differ} DIFFER, ${report.totals.fail} FAIL; ${report.totals.identical_copies} identical byte copies.`);
    for (const item of report.receipts) {
      console.log(`#${item.index} ${item.verdict}${item.reason ? ` (${item.reason})` : ""}${item.duplicate_of === null ? "" : `; identical to #${item.duplicate_of}`}`);
    }
    if (reportFile !== undefined) console.log("REPORT MATCH: the saved report was reproduced from the ordered files and current verifier bytes.");
    console.log("Hashes bind these supplied file bytes; they do not prove origin, time, factual truth, independence, or completeness.");
  }
  if (reportFile === undefined && (report.totals.differ || report.totals.fail)) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  try { run(); }
  catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
}

module.exports = {auditEvidenceBatch, run};
