#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {createHash, createHmac} = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {isDeepStrictEqual} = require("node:util");
const {loadModel} = require("./benchmark-evidence.cjs");
const {selectedNames, profileHash} = require("./normalization-profile.cjs");
const {parseUnambiguousJSON} = require("./unambiguous-json.cjs");
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
  try { return parseUnambiguousJSON(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
  catch (error) {
    if (error.message === "Duplicate JSON object name") {
      throw new Error(`${label} has a duplicate JSON object name`);
    }
    throw new Error(`${label} is not valid unambiguous UTF-8 JSON`);
  }
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
  const selected = [baseline];
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
      selected.push(receipt);
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
  const report = {
    format: "aru-evidence-batch-audit", version: 1,
    model_sha256: model.hash,
    verifier_sha256: sha256(fs.readFileSync(require.resolve("./verify-evidence-receipt.cjs"))),
    auditor_sha256: sha256(fs.readFileSync(__filename)),
    reference_sha256: sha256(referenceBytes),
    checkpoint_sha256: checkpointBytes === null ? null : sha256(checkpointBytes),
    receipts, totals,
    normalization_sha256: profileHash(selectedNames(selected), model.normalize)
  };
  return report;
}

function browserScriptSHA256() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!script || html.indexOf("<script>", script.index + 1) !== -1) {
    throw new Error("Expected exactly one inline browser verifier script");
  }
  return sha256(Buffer.from(script[1], "utf8"));
}

function browserCaptureFromReport(report, version = 3) {
  if (![1, 2, 3].includes(version)) throw new Error("Unsupported browser capture version");
  if (version === 3 && !/^[0-9a-f]{64}$/.test(report.normalization_sha256)) {
    throw new Error("Version 3 capture requires a selected-name normalization profile");
  }
  return {
    format: "aru-evidence-browser-batch-capture", version,
    ...(version >= 2 ? {browser_script_sha256: browserScriptSHA256()} : {}),
    ...(version === 3 ? {normalization_sha256: report.normalization_sha256} : {}),
    reference_sha256: report.reference_sha256,
    checkpoint_sha256: report.checkpoint_sha256,
    receipts: report.receipts.map(item => ({index: item.index, sha256: item.sha256,
      verdict: item.verdict, duplicate_of: item.duplicate_of})),
    totals: report.totals
  };
}

function transitionCaptureFromReports(aReport, bReport, version = 2) {
  if (![1, 2].includes(version)) throw new Error("Unsupported transition capture version");
  const a = browserCaptureFromReport(aReport, version === 1 ? 2 : 3);
  const b = browserCaptureFromReport(bReport, version === 1 ? 2 : 3);
  if (a.browser_script_sha256 !== b.browser_script_sha256 ||
      a.receipts.length !== b.receipts.length || a.receipts.some((row, index) =>
        row.sha256 !== b.receipts[index].sha256 || row.duplicate_of !== b.receipts[index].duplicate_of)) {
    throw new Error("Transition sides must use the same verifier and ordered receipt bytes");
  }
  return {format: "aru-evidence-reference-transition-capture", version,
    capture_a: a, capture_b: b,
    changed_receipts: a.receipts.filter((row, index) => row.verdict !== b.receipts[index].verdict)
      .map(row => row.index)};
}

function openingKeyBytes(opening) {
  if (opening === null || typeof opening !== "object" || Array.isArray(opening) ||
      Object.keys(opening).length !== 3 ||
      opening.format !== "aru-evidence-transition-opening-key" || opening.version !== 1 ||
      typeof opening.key_hex !== "string" || !/^[0-9a-f]{64}$/.test(opening.key_hex)) {
    throw new Error("Expected a version 1 transition opening key with 32 random bytes");
  }
  return Buffer.from(opening.key_hex, "hex");
}

function sealedTransitionFromCapture(transition, keyBytes) {
  if (!Buffer.isBuffer(keyBytes) || keyBytes.length !== 32) throw new Error("Opening key must be 32 bytes");
  const {capture_a: a, capture_b: b} = transition;
  const commit = (role, index, digest) => digest === null ? null : createHmac("sha256", keyBytes)
    .update(`aru-sealed-transition-v1\n${role}\n${index}\n${digest}`, "ascii").digest("hex");
  const version = transition.version;
  if (![1, 2].includes(version)) throw new Error("Unsupported transition capture version");
  return {format: "aru-evidence-sealed-reference-transition-capture", version,
    browser_script_sha256: a.browser_script_sha256,
    ...(version === 2 ? {
      normalization_a_commitment: commit("normalization-a", 0, a.normalization_sha256),
      normalization_b_commitment: commit("normalization-b", 0, b.normalization_sha256)
    } : {}),
    reference_a_commitment: commit("reference-a", 0, a.reference_sha256),
    reference_b_commitment: commit("reference-b", 0, b.reference_sha256),
    checkpoint_a_commitment: commit("checkpoint-a", 0, a.checkpoint_sha256),
    checkpoint_b_commitment: commit("checkpoint-b", 0, b.checkpoint_sha256),
    receipts: a.receipts.map((row, index) => ({index: row.index,
      commitment: commit("receipt", row.index, row.sha256),
      verdict_a: row.verdict, verdict_b: b.receipts[index].verdict,
      duplicate_of: row.duplicate_of})),
    totals_a: a.totals, totals_b: b.totals, changed_receipts: transition.changed_receipts};
}

function minimumAddedSources(a, b, reproducesTarget) {
  const baseIds = new Set(a.records.map(record => record.id));
  const common = b.records.filter(record => baseIds.has(record.id));
  if (!isDeepStrictEqual(a.records, common)) {
    return {status: "unavailable", reason: "not-addition-only"};
  }
  const added = b.records.filter(record => !baseIds.has(record.id)).map(record => record.id);
  if (added.length > 6) return {status: "unavailable", reason: "too-many-additions"};
  const sets = [];
  let minimumSize = null;
  let totalSets = 0;
  let testedSubsets = 0;
  for (let size = 1; size <= added.length && minimumSize === null; size++) {
    for (let mask = 1; mask < 2 ** added.length; mask++) {
      const chosen = added.filter((_, index) => mask & (1 << index));
      if (chosen.length !== size) continue;
      testedSubsets++;
      const chosenIds = new Set(chosen);
      const hybrid = b.records.filter(record => baseIds.has(record.id) || chosenIds.has(record.id));
      if (!reproducesTarget(hybrid)) continue;
      minimumSize = size;
      totalSets++;
      if (sets.length < 3) sets.push(chosen);
    }
  }
  if (minimumSize === null) return {status: "unavailable", reason: "no-witness"};
  return {status: "witness", minimum_size: minimumSize, sets,
    total_sets: totalSets, tested_subsets: testedSubsets};
}

function additionWitness(a, b, receipt, model = loadModel()) {
  const answer = records => receipt.format === "aru-evidence-brief-receipt" ?
    model.brief(receipt.names, records).map(row => row.answer) :
    model.resolve(receipt.question, records);
  const target = answer(b.records);
  if (isDeepStrictEqual(answer(a.records), target)) return {status: "unchanged"};
  return minimumAddedSources(a, b, records => isDeepStrictEqual(answer(records), target));
}

function verdictAdditionWitness(a, b, receipt, model = loadModel()) {
  // This is the actual reference verdict, not merely the computed answer. A
  // full receipt can differ after an unrelated addition even if its answer is stable.
  const matches = records => {
    const next_source_id = Math.max(a.next_source_id, b.next_source_id);
    try { verifyEvidenceReceipt(receipt, model, {...b, records, next_source_id}); return true; }
    catch (_) { return false; }
  };
  const target = matches(b.records);
  if (matches(a.records) === target) return {status: "unchanged"};
  return minimumAddedSources(a, b, records => matches(records) === target);
}

function explainTransitionAdditions(referenceFile, referenceB, receiptFiles, report, other,
  {verdict = false} = {}) {
  const aBytes = readLimited(referenceFile, "Reference A");
  const bBytes = readLimited(referenceB, "Reference B");
  if (sha256(aBytes) !== report.reference_sha256 || sha256(bBytes) !== other.reference_sha256) {
    throw new Error("Reference bytes changed during answer-change analysis");
  }
  const a = parseJSON(aBytes, "Reference A");
  const b = parseJSON(bBytes, "Reference B");
  const model = loadModel();
  if (model.hash !== report.model_sha256 || model.hash !== other.model_sha256) {
    throw new Error("Browser answer model changed during answer-change analysis");
  }
  const verifierSHA = sha256(fs.readFileSync(require.resolve("./verify-evidence-receipt.cjs")));
  const auditorSHA = sha256(fs.readFileSync(__filename));
  if (verifierSHA !== report.verifier_sha256 || verifierSHA !== other.verifier_sha256 ||
      auditorSHA !== report.auditor_sha256 || auditorSHA !== other.auditor_sha256) {
    throw new Error("Verifier code changed during addition analysis");
  }
  return receiptFiles.map((file, index) => {
    const bytes = readLimited(file, `Receipt #${index + 1}`);
    if (sha256(bytes) !== report.receipts[index].sha256 ||
        sha256(bytes) !== other.receipts[index].sha256) {
      throw new Error("Receipt bytes changed during answer-change analysis");
    }
    if (report.receipts[index].verdict === "FAIL" || other.receipts[index].verdict === "FAIL") {
      return {index: index + 1, status: "unavailable", reason: "receipt-failed"};
    }
    const receipt = parseJSON(bytes, `Receipt #${index + 1}`);
    verifyEvidenceReceipt(receipt, model);
    return {index: index + 1, ...(verdict ? verdictAdditionWitness(a, b, receipt, model) :
      additionWitness(a, b, receipt, model))};
  });
}

function parseArgs(args) {
  let checkpointFile;
  let referenceB;
  let checkpointB;
  let reportFile;
  let captureFile;
  let transitionFile;
  let sealedFile;
  let openingKeyFile;
  let explainAdditions = false;
  let explainVerdicts = false;
  let json = false;
  const files = [];
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (["--checkpoint", "--reference-b", "--checkpoint-b", "--check-report",
         "--check-capture", "--check-transition", "--check-sealed", "--opening-key"].includes(item)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${item} requires a file`);
      if (item === "--checkpoint") {
        if (checkpointFile !== undefined) throw new Error("Duplicate --checkpoint option");
        checkpointFile = value;
      } else if (item === "--reference-b") {
        if (referenceB !== undefined) throw new Error("Duplicate --reference-b option");
        referenceB = value;
      } else if (item === "--checkpoint-b") {
        if (checkpointB !== undefined) throw new Error("Duplicate --checkpoint-b option");
        checkpointB = value;
      } else if (item === "--check-report") {
        if (reportFile !== undefined) throw new Error("Duplicate --check-report option");
        reportFile = value;
      } else if (item === "--check-capture") {
        if (captureFile !== undefined) throw new Error("Duplicate --check-capture option");
        captureFile = value;
      } else if (item === "--check-sealed") {
        if (sealedFile !== undefined) throw new Error("Duplicate --check-sealed option");
        sealedFile = value;
      } else if (item === "--opening-key") {
        if (openingKeyFile !== undefined) throw new Error("Duplicate --opening-key option");
        openingKeyFile = value;
      } else {
        if (transitionFile !== undefined) throw new Error("Duplicate --check-transition option");
        transitionFile = value;
      }
    } else if (item === "--json") {
      if (json) throw new Error("Duplicate --json option");
      json = true;
    } else if (item === "--explain-additions") {
      if (explainAdditions) throw new Error("Duplicate --explain-additions option");
      explainAdditions = true;
    } else if (item === "--explain-verdicts") {
      if (explainVerdicts) throw new Error("Duplicate --explain-verdicts option");
      explainVerdicts = true;
    } else if (item.startsWith("--")) throw new Error(`Unknown option ${item}`);
    else files.push(item);
  }
  if (files.length < 2) throw new Error("Usage: node tools/audit-evidence-batch.cjs <reference-a.json> <receipt.json>... [--checkpoint a.json] [--reference-b b.json --checkpoint-b b-checkpoint.json --check-transition capture.json | --check-sealed capture.json --opening-key key.json] [--explain-additions] [--explain-verdicts] [--json]");
  if ((checkpointB || transitionFile || sealedFile || explainAdditions || explainVerdicts) && !referenceB) throw new Error("Paired options require --reference-b");
  if (!!sealedFile !== !!openingKeyFile) throw new Error("--check-sealed and --opening-key must be supplied together");
  if (sealedFile && transitionFile) throw new Error("Choose only one transition capture to check");
  if (referenceB && (reportFile || captureFile)) throw new Error("Use --check-transition instead of a single-reference report or capture with --reference-b");
  return {referenceFile: files[0], receiptFiles: files.slice(1), checkpointFile,
    referenceB, checkpointB, reportFile, captureFile, transitionFile, sealedFile, openingKeyFile,
    explainAdditions, explainVerdicts, json};
}

function run(args = process.argv.slice(2)) {
  const {referenceFile, receiptFiles, checkpointFile, referenceB, checkpointB,
    reportFile, captureFile, transitionFile, sealedFile, openingKeyFile,
    explainAdditions, explainVerdicts, json} = parseArgs(args);
  const report = auditEvidenceBatch(referenceFile, receiptFiles, {checkpointFile});
  if (referenceB !== undefined) {
    const other = auditEvidenceBatch(referenceB, receiptFiles, {checkpointFile: checkpointB});
    const selectedTransitionFile = transitionFile || sealedFile;
    const selectedTransition = selectedTransitionFile ?
      parseJSON(readLimited(selectedTransitionFile, "Saved transition capture"), "Saved transition capture") : null;
    const transitionVersion = selectedTransition?.version === 1 ? 1 : 2;
    const transition = transitionCaptureFromReports(report, other, transitionVersion);
    if (transitionFile !== undefined) {
      const expected = parseJSON(readLimited(transitionFile, "Saved transition capture"), "Saved transition capture");
      try { assert.deepStrictEqual(transition, expected); }
      catch (_) { throw new Error("Saved transition capture differs from the recomputed references, ordered receipts, outcomes, or browser script"); }
    }
    const sealed = sealedFile === undefined ? null : sealedTransitionFromCapture(transition,
      openingKeyBytes(parseJSON(readLimited(openingKeyFile, "Opening key"), "Opening key")));
    if (sealed) {
      const expected = parseJSON(readLimited(sealedFile, "Sealed transition capture"), "Sealed transition capture");
      try { assert.deepStrictEqual(sealed, expected); }
      catch (_) { throw new Error("Sealed transition capture differs from the recomputed files, outcomes, or browser script"); }
    }
    const influence = explainAdditions ?
      explainTransitionAdditions(referenceFile, referenceB, receiptFiles, report, other) : null;
    const verdictInfluence = explainVerdicts ?
      explainTransitionAdditions(referenceFile, referenceB, receiptFiles, report, other,
        {verdict: true}) : null;
    if (json) console.log(JSON.stringify(influence || verdictInfluence ?
      {transition: sealed || transition, ...(influence ? {answer_influence: influence} : {}),
        ...(verdictInfluence ? {verdict_influence: verdictInfluence} : {})} : sealed || transition,
      null, 2));
    else {
      for (const [label, audit] of [["A", report], ["B", other]]) {
        console.log(`${label}: ${audit.totals.match} MATCH, ${audit.totals.differ} DIFFER, ${audit.totals.fail} FAIL.`);
      }
      console.log(`${transition.changed_receipts.length} changed receipt verdicts.`);
      if (influence) {
        for (const row of influence) {
          if (row.status === "witness") console.log(`#${row.index} answer witness: ${row.minimum_size} added source${row.minimum_size === 1 ? "" : "s"} per minimum set; ` +
            `${row.sets.map(ids => ids.map(id => `#${id}`).join(" + ")).join("; ")}` +
            `${row.total_sets > row.sets.length ? `; ${row.total_sets - row.sets.length} more` : ""}; ` +
            `${row.tested_subsets} subset${row.tested_subsets === 1 ? "" : "s"} tested.`);
          else console.log(`#${row.index} answer witness: ${row.status}${row.reason ? ` (${row.reason})` : ""}.`);
        }
        console.log("Witnesses model only added sources under these rules; they do not establish chronology, authorship, or truth.");
      }
      if (verdictInfluence) {
        for (const row of verdictInfluence) {
          if (row.status === "witness") console.log(`#${row.index} verdict witness: ${row.minimum_size} added source${row.minimum_size === 1 ? "" : "s"} per minimum set; ` +
            `${row.sets.map(ids => ids.map(id => `#${id}`).join(" + ")).join("; ")}` +
            `${row.total_sets > row.sets.length ? `; ${row.total_sets - row.sets.length} more` : ""}; ` +
            `${row.tested_subsets} subset${row.tested_subsets === 1 ? "" : "s"} tested.`);
          else console.log(`#${row.index} verdict witness: ${row.status}${row.reason ? ` (${row.reason})` : ""}.`);
        }
        console.log("Verdict witnesses replay this receipt's full-snapshot or excerpt rule against selected source additions; they do not establish factual truth or custody.");
      }
      const profile = transitionVersion === 2 ? " Selected-name profiles agree." :
        " Older capture has no originating browser normalization profile.";
      if (transitionFile !== undefined) console.log("TRANSITION CAPTURE MATCH: both supplied references, ordered files, outcomes, and browser script were reproduced." + profile + " Inspect A and B counts independently.");
      if (sealed) console.log("SEALED TRANSITION MATCH: opening key, both supplied references, ordered files, outcomes, and browser script reproduced." + profile + " Inspect A and B counts independently.");
      console.log("A and B are labels, not verified dates; consistency does not prove origin, completeness, or factual truth.");
    }
    if (transitionFile === undefined && !sealed && [report, other].some(audit =>
      audit.totals.differ || audit.totals.fail)) process.exitCode = 1;
    return transition;
  }
  let captureVersion;
  if (reportFile !== undefined) {
    const expected = parseJSON(readLimited(reportFile, "Saved report"), "Saved report");
    try { assert.deepStrictEqual(report, expected); }
    catch (_) { throw new Error("Saved report differs from the recomputed audit or ordered input bytes"); }
  }
  if (captureFile !== undefined) {
    const expected = parseJSON(readLimited(captureFile, "Browser capture"), "Browser capture");
    captureVersion = expected?.version;
    try { assert.deepStrictEqual(browserCaptureFromReport(report, captureVersion), expected); }
    catch (_) { throw new Error("Browser capture differs from the recomputed audit or ordered input bytes"); }
  }
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.receipts.length} selected: ${report.totals.match} MATCH, ${report.totals.differ} DIFFER, ${report.totals.fail} FAIL; ${report.totals.identical_copies} identical byte copies.`);
    for (const item of report.receipts) {
      console.log(`#${item.index} ${item.verdict}${item.reason ? ` (${item.reason})` : ""}${item.duplicate_of === null ? "" : `; identical to #${item.duplicate_of}`}`);
    }
    if (reportFile !== undefined) console.log("REPORT MATCH: the saved report was reproduced from the ordered files and current verifier bytes.");
    if (captureFile !== undefined) console.log("CAPTURE MATCH: the browser's file hashes and verdicts were reproduced from the ordered files." +
      (captureVersion === 1
        ? " Legacy v1 capture has no browser script fingerprint." :
        captureVersion === 2 ? " Browser verifier script fingerprint agrees; original runtime is unbound." :
          " Browser script and selected-name normalization profile agree."));
    console.log("Hashes bind these supplied file bytes; they do not prove origin, time, factual truth, independence, or completeness.");
  }
  if (reportFile === undefined && captureFile === undefined &&
      (report.totals.differ || report.totals.fail)) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  try { run(); }
  catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
}

module.exports = {auditEvidenceBatch, browserCaptureFromReport, transitionCaptureFromReports,
  sealedTransitionFromCapture, openingKeyBytes, additionWitness, verdictAdditionWitness,
  explainTransitionAdditions, run};
