#!/usr/bin/env node
"use strict";

// A small integration surface over the two independently implemented auditors.
// A reproduced capture and an all-MATCH audit are deliberately separate fields.
const fs = require("node:fs");
const path = require("node:path");
const {createHash} = require("node:crypto");
const {spawnSync} = require("node:child_process");
const {isDeepStrictEqual} = require("node:util");
const {parseUnambiguousJSON} = require("./unambiguous-json.cjs");

const MAX_CAPTURE_BYTES = 1024 * 1024;
const VALUE_FLAGS = new Set(["--checkpoint", "--reference-b", "--checkpoint-b",
  "--check-capture", "--check-transition", "--check-sealed", "--opening-key"]);
const CAPTURE_FLAGS = ["--check-capture", "--check-transition", "--check-sealed"];
const LIMITS = ["authorship", "independent_custody", "completeness", "factual_truth"];

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function parseArgs(argv) {
  const values = new Map();
  const auditorArgs = [];
  const files = [];
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") {
      if (json) throw new Error("Duplicate --json option");
      json = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--") || values.has(arg)) {
        throw new Error(`${arg} requires one file and cannot be repeated`);
      }
      values.set(arg, value);
      auditorArgs.push(arg, value);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unsupported option ${arg}`);
    } else {
      files.push(arg);
      auditorArgs.push(arg);
    }
  }
  const selected = CAPTURE_FLAGS.filter(flag => values.has(flag));
  if (files.length < 2 || files.length > 21 || selected.length !== 1) {
    throw new Error("Supply a reference, 1–20 ordered receipts, and exactly one saved capture option");
  }
  const kind = selected[0];
  if ((kind === "--check-capture") !== !values.has("--reference-b") ||
      (kind === "--check-sealed") !== values.has("--opening-key") ||
      (values.has("--checkpoint-b") && !values.has("--reference-b"))) {
    throw new Error("Paired captures require reference B; private captures also require an opening key");
  }
  return {values, kind, json, auditorArgs, captureFile: values.get(kind)};
}

function captureBytes(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_CAPTURE_BYTES) {
    throw new Error("Capture must be a regular file of at most 1 MiB");
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_CAPTURE_BYTES) throw new Error("Capture exceeds 1 MiB");
  return bytes;
}

function captureKind(bytes, option) {
  let capture;
  try { capture = parseUnambiguousJSON(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
  catch (_) { throw new Error("Capture is not unambiguous UTF-8 JSON"); }
  const formats = {
    "--check-capture": "aru-evidence-browser-batch-capture",
    "--check-transition": "aru-evidence-reference-transition-capture",
    "--check-sealed": "aru-evidence-sealed-reference-transition-capture"
  };
  if (capture?.format !== formats[option] ||
      (option === "--check-capture" ? ![1, 2].includes(capture.version) : capture.version !== 1)) {
    throw new Error("Capture format or version does not match the review option");
  }
  return {capture, legacy: option === "--check-capture" && capture.version === 1};
}

function auditProjection(report, format) {
  if (report?.format !== format || report.version !== 1 ||
      !Array.isArray(report.receipts) || !report.totals) {
    throw new Error("Auditor returned an unexpected report");
  }
  return {reference_sha256: report.reference_sha256,
    checkpoint_sha256: report.checkpoint_sha256,
    receipts: report.receipts, totals: report.totals};
}

function verdict(totals) {
  return totals.fail ? "recorded_failures" :
    totals.differ ? "recorded_differences" : "all_receipts_match";
}

function invoke(executable, script, args) {
  const result = spawnSync(executable, [script, ...args, "--json"],
    {encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024});
  if (result.error || result.status !== 0) return {status: "rejected"};
  try { return {status: "matched", report: JSON.parse(result.stdout)}; }
  catch (_) { return {status: "invalid_output"}; }
}

function review(argv, runners = null) {
  const selection = parseArgs(argv);
  const before = captureBytes(selection.captureFile);
  const {legacy} = captureKind(before, selection.kind);
  const base = {format: "aru-evidence-review-result", version: 1,
    capture_sha256: sha256(before),
    capture_kind: selection.kind === "--check-capture" ? "batch" :
      selection.kind === "--check-transition" ? "transition" : "private_transition"};
  const scripts = runners || [
    [process.execPath, path.join(__dirname, "audit-evidence-batch.cjs")],
    ["python3", path.join(__dirname, "independent-evidence-batch.py")]
  ];
  const [node, python] = scripts.map(([executable, script]) =>
    invoke(executable, script, selection.auditorArgs));
  let after;
  try { after = captureBytes(selection.captureFile); }
  catch (_) { return {...base, replay: "UNCONFIRMED", reason: "capture_changed"}; }
  if (!before.equals(after)) return {...base, replay: "UNCONFIRMED", reason: "capture_changed"};
  if (node.status !== "matched" || python.status !== "matched") {
    return {...base, replay: "UNCONFIRMED", reason: "auditor_rejected",
      auditors: {node: node.status, python: python.status}};
  }
  try {
    const left = selection.kind === "--check-capture" ?
      auditProjection(node.report, "aru-evidence-batch-audit") : node.report;
    const right = selection.kind === "--check-capture" ?
      auditProjection(python.report, "aru-evidence-independent-batch-audit") : python.report;
    if (!isDeepStrictEqual(left, right)) {
      return {...base, replay: "UNCONFIRMED", reason: "auditor_disagreement"};
    }
    const paired = selection.kind !== "--check-capture";
    const totals = paired ? {a: left.capture_a?.totals || left.totals_a,
      b: left.capture_b?.totals || left.totals_b} : left.totals;
    if (paired && (!totals.a || !totals.b || !Array.isArray(left.changed_receipts))) {
      throw new Error("Auditor returned an unexpected paired report");
    }
    return {...base, replay: "MATCH", auditors: {node: "matched", python: "matched"},
      script_binding: legacy ? "unavailable_legacy_v1" : "matched",
      receipt_assessment: paired ? {a: verdict(totals.a), b: verdict(totals.b)} : verdict(totals),
      totals, ...(paired ? {changed_receipt_positions: left.changed_receipts} : {}),
      checkpoint_selection: paired ? {a: totals.a &&
        (selection.kind === "--check-sealed" ? !!left.checkpoint_a_commitment :
          !!left.capture_a.checkpoint_sha256),
        b: totals.b && (selection.kind === "--check-sealed" ? !!left.checkpoint_b_commitment :
          !!left.capture_b.checkpoint_sha256)} : !!selection.values.get("--checkpoint"),
      not_established: LIMITS};
  } catch (_) { return {...base, replay: "UNCONFIRMED", reason: "invalid_auditor_output"}; }
}

function run(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const result = review(argv);
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.replay === "MATCH") {
    console.log(`DUAL REVIEW MATCH: Node and Python reproduced the ${result.capture_kind} capture (${result.capture_sha256}).`);
    const sides = result.capture_kind === "batch" ? [["Audit", result.totals]] :
      [["A", result.totals.a], ["B", result.totals.b]];
    for (const [label, totals] of sides) {
      console.log(`${label}: ${totals.match} MATCH, ${totals.differ} DIFFER, ${totals.fail} FAIL; ${totals.identical_copies} repeated file copies.`);
    }
    if (result.script_binding === "unavailable_legacy_v1") {
      console.log("Legacy v1 capture has no browser script fingerprint.");
    }
    console.log("Capture replay and receipt outcomes are separate. Authorship, independent custody, completeness, and factual truth remain unverified.");
  } else console.error(`REVIEW UNCONFIRMED: ${result.reason}. No receipt conclusion issued.`);
  if (result.replay !== "MATCH") process.exitCode = 1;
  return result;
}

if (require.main === module) {
  try { run(); }
  catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
}

module.exports = {parseArgs, auditProjection, review, run};
