#!/usr/bin/env node
"use strict";

// One fixed input snapshot, the extracted browser/Node rules, and a separate
// Python implementation. A mismatch withholds the map instead of voting.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const {isDeepStrictEqual} = require("node:util");
const {auditEvidenceBatch, browserCaptureFromReport} = require("./audit-evidence-batch.cjs");
const {verifyEvidenceReceipt} = require("./verify-evidence-receipt.cjs");
const {loadModel} = require("./benchmark-evidence.cjs");
const {parseUnambiguousJSON} = require("./unambiguous-json.cjs");
const {review} = require("./review-evidence.cjs");

const MAX_BYTES = 1024 * 1024;
const LIMITS = ["authorship", "independent_custody", "completeness", "factual_truth"];

function parseArgs(argv) {
  const files = [], options = {json: false};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") {
      if (options.json) throw new Error("Repeated --json");
      options.json = true;
    } else if (arg === "--checkpoint" || arg === "--check-capture") {
      const key = arg === "--checkpoint" ? "checkpoint" : "capture";
      const value = argv[++index];
      if (!value || value.startsWith("--") || options[key]) throw new Error(`${arg} requires one file`);
      options[key] = value;
    } else if (arg.startsWith("--")) throw new Error(`Unsupported option ${arg}`);
    else files.push(arg);
  }
  if (files.length < 2 || files.length > 21) {
    throw new Error("Supply a reference and 1–20 ordered answer receipts");
  }
  return {reference: files[0], receipts: files.slice(1), ...options};
}

function readBounded(file, label) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.size > MAX_BYTES) throw new Error(`${label} must be a regular file of at most 1 MiB`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error(`${label} must be a regular file of at most 1 MiB`);
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = fs.readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > MAX_BYTES) throw new Error(`${label} exceeds 1 MiB`);
    return bytes.subarray(0, used);
  } finally { fs.closeSync(fd); }
}

function parseFile(file) {
  return parseUnambiguousJSON(new TextDecoder("utf-8", {fatal: true}).decode(fs.readFileSync(file)));
}

function computed(receipt, records, model) {
  return receipt.format === "aru-evidence-brief-receipt" ?
    model.brief(receipt.names, records).map(item => item.answer) :
    model.resolve(receipt.question, records);
}

function matchesReference(receipt, records, model) {
  if (receipt.format !== "aru-evidence-answer-excerpt") {
    return isDeepStrictEqual(receipt.records, records);
  }
  if (!isDeepStrictEqual(receipt.answer, model.resolve(receipt.question, records))) return false;
  const byId = new Map(records.map(row => [row.id, row]));
  return receipt.records.every(row => isDeepStrictEqual(row, byId.get(row.id)));
}

function nodeProbe(referenceFile, receiptFiles, checkpointFile) {
  const audit = auditEvidenceBatch(referenceFile, receiptFiles,
    checkpointFile ? {checkpointFile} : {});
  const reference = parseFile(referenceFile);
  const model = loadModel();
  const rows = audit.receipts.map((item, index) => {
    if (item.verdict === "FAIL") return {index: index + 1, verdict: "FAIL", skipped: true};
    const receipt = parseFile(receiptFiles[index]);
    verifyEvidenceReceipt(receipt, model);
    if (matchesReference(receipt, reference.records, model) !== (item.verdict === "MATCH")) {
      throw new Error("The Node audit and source probe disagree on an original verdict");
    }
    const original = computed(receipt, reference.records, model);
    const removals = reference.records.map(source => {
      const records = reference.records.filter(row => row.id !== source.id);
      return {source_id: source.id, verdict: matchesReference(receipt, records, model) ? "MATCH" : "DIFFER",
        answer_changed: !isDeepStrictEqual(original, computed(receipt, records, model))};
    });
    return {index: index + 1, verdict: item.verdict, removals};
  });
  return {format: "aru-source-removal-map", version: 1,
    selection: {reference_sha256: audit.reference_sha256,
      checkpoint_sha256: audit.checkpoint_sha256,
      normalization_sha256: audit.normalization_sha256,
      browser_script_sha256: browserCaptureFromReport(audit).browser_script_sha256,
      receipts: audit.receipts.map(({index, sha256, verdict, duplicate_of}) =>
        ({index, sha256, verdict, duplicate_of}))},
    source_ids: reference.records.map(row => row.id), rows};
}

function reviewSourceMap(selection, {pythonScript = path.join(__dirname, "independent-source-probe.py")} = {}) {
  const originals = [selection.reference, ...selection.receipts,
    ...[selection.checkpoint, selection.capture].filter(Boolean)];
  const bytes = originals.map((file, index) => readBounded(file, `Selected file #${index + 1}`));
  if (bytes.slice(1, selection.receipts.length + 1).reduce((sum, item) => sum + item.length, 0) > 4 * MAX_BYTES) {
    throw new Error("Receipts exceed 4 MiB combined");
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "aru-source-review-"));
  const unconfirmed = reason => ({format: "aru-independent-source-review", version: 1,
    assessment: "UNCONFIRMED", reason, not_established: LIMITS});
  try {
    const copies = bytes.map((item, index) => {
      const file = path.join(temporary, `selected-${index}.json`);
      fs.writeFileSync(file, item, {mode: 0o600});
      return file;
    });
    const reference = copies[0];
    const receipts = copies.slice(1, selection.receipts.length + 1);
    const checkpoint = selection.checkpoint ? copies[selection.receipts.length + 1] : null;
    const capture = selection.capture ? copies[copies.length - 1] : null;
    let replay = null;
    if (capture) {
      replay = review([reference, ...receipts,
        ...(checkpoint ? ["--checkpoint", checkpoint] : []), "--check-capture", capture]);
      if (replay.replay !== "MATCH") return unconfirmed("capture_unconfirmed");
    }
    const node = nodeProbe(reference, receipts, checkpoint);
    const args = [pythonScript, reference, ...receipts,
      ...(checkpoint ? ["--checkpoint", checkpoint] : []), "--json"];
    const python = spawnSync("python3", args, {encoding: "utf8", timeout: 30000,
      maxBuffer: 4 * 1024 * 1024});
    if (python.error || python.status !== 0) return unconfirmed("checker_rejected");
    let independent;
    try { independent = JSON.parse(python.stdout); }
    catch (_) { return unconfirmed("checker_invalid_output"); }
    if (!isDeepStrictEqual(node, independent)) return unconfirmed("checker_disagreement");
    if (!originals.every((file, index) => {
      try { return readBounded(file, `Selected file #${index + 1}`).equals(bytes[index]); }
      catch (_) { return false; }
    })) return unconfirmed("selection_changed_during_review");
    const totals = node.selection.receipts.reduce((result, row) => {
      result[row.verdict.toLowerCase()]++;
      return result;
    }, {match: 0, differ: 0, fail: 0});
    return {format: "aru-independent-source-review", version: 1,
      assessment: "MATCH", capture_replay: capture ? "MATCH" : "not_checked",
      capture_binding: replay ? {script: replay.script_binding,
        selected_name_runtime: replay.browser_runtime_normalization} : null,
      receipt_assessment: totals.fail ? "recorded_failures" :
        totals.differ ? "recorded_differences" : "all_receipts_match",
      totals, source_map: node, not_established: LIMITS};
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
}

function run(argv = process.argv.slice(2)) {
  let selection;
  try { selection = parseArgs(argv); }
  catch (error) { console.error(`FAIL: ${error.message}`); return 2; }
  try {
    const result = reviewSourceMap(selection);
    if (selection.json) console.log(JSON.stringify(result, null, 2));
    else console.log(result.assessment === "MATCH" ?
      `SOURCE MAP MATCH: ${result.source_map.source_ids.length} supplied sources, ` +
        `${result.source_map.rows.length} receipts. Receipt assessment: ${result.receipt_assessment}. ` +
        `Capture replay: ${result.capture_replay}. This does not establish completeness or truth.` :
      `UNCONFIRMED: ${result.reason}. No source map was accepted.`);
    return result.assessment === "MATCH" ? 0 : 1;
  } catch (error) {
    console.error(`FAIL: ${error.message || "Could not review selected files"}`);
    return 2;
  }
}

if (require.main === module) process.exitCode = run();
module.exports = {parseArgs, nodeProbe, reviewSourceMap, run};
