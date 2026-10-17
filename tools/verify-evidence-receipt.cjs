#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { loadModel } = require("./benchmark-evidence.cjs");
const {parseUnambiguousJSON} = require("./unambiguous-json.cjs");

const MAX_BYTES = 1024 * 1024;
const MODEL_REVISION = "aru-evidence-questions-1";
const BRIEF_REVISION = "aru-evidence-briefs-1";
const CORRECTION_REVISION = "aru-evidence-corrections-1";
const CHAIN_REVISION = "aru-evidence-correction-chain-1";
const PACKET_REVISION = "aru-evidence-correction-packet-1";
const CLAIM_FIELDS = new Set(["id", "key", "value", "time", "status", "imported"]);

function requireValid(condition, message) {
  if (!condition) throw new Error(`Invalid receipt: ${message}`);
}

function verifyCorrectionReceipt(receipt, model) {
  const keys = ["format", "version", "model_revision", "name", "value", "new_source_id",
    "applied_at", "before_records", "after_records"];
  requireValid(keys.every(key => Object.hasOwn(receipt, key)) &&
    Object.keys(receipt).every(key => keys.includes(key)) &&
    receipt.version === 1 && receipt.model_revision === CORRECTION_REVISION &&
    Array.isArray(receipt.before_records) && receipt.before_records.length < 100 &&
    Array.isArray(receipt.after_records) && receipt.after_records.length <= 100,
    "unsupported correction format, model revision, or record count");
  const ids = new Set();
  for (const record of receipt.before_records) {
    requireValid(model.validClaim(record) && Object.keys(record).every(key => CLAIM_FIELDS.has(key)) &&
      (record.imported === undefined || typeof record.imported === "boolean") && !ids.has(record.id),
      "invalid or duplicate prior record");
    ids.add(record.id);
  }
  let computed;
  try {
    computed = model.correct(receipt.name, receipt.value, receipt.before_records,
      receipt.new_source_id, receipt.applied_at);
  } catch (error) { requireValid(false, error.message); }
  try { assert.deepStrictEqual(receipt.after_records, computed); }
  catch (_) { requireValid(false, "corrected ledger does not match the supplied prior records"); }
  const normalized = receipt.name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const superseded = receipt.before_records.filter(record => record.status === "active" &&
    record.key.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase() === normalized).length;
  return {kind: "correction", new_source_id: receipt.new_source_id, superseded,
    records: computed.length, scope: "full-supplied-snapshots", model_sha256: model.hash};
}

function verifyCorrectionChain(receipt, model) {
  const keys = ["format", "version", "model_revision", "receipts"];
  requireValid(keys.every(key => Object.hasOwn(receipt, key)) &&
    Object.keys(receipt).every(key => keys.includes(key)) &&
    receipt.version === 1 && receipt.model_revision === CHAIN_REVISION &&
    Array.isArray(receipt.receipts) && receipt.receipts.length >= 2 && receipt.receipts.length <= 8,
    "unsupported correction-chain format, revision, fields, or step count (2–8)");
  let previous = null;
  const steps = [];
  for (const item of receipt.receipts) {
    requireValid(item && typeof item === "object" && !Array.isArray(item) &&
      item.format === "aru-evidence-correction-receipt", "chain must contain only correction receipts");
    verifyCorrectionReceipt(item, model);
    if (previous) {
      try { assert.deepStrictEqual(item.before_records, previous.after_records); }
      catch (_) { requireValid(false, "correction chain has a missing, forked, duplicated, or reordered step"); }
      requireValid(item.new_source_id === previous.new_source_id + 1,
        "correction chain has a missing, forked, duplicated, or reordered step");
    }
    steps.push(item.new_source_id);
    previous = item;
  }
  return {kind: "chain", steps, records: previous.after_records.length,
    scope: "full-supplied-correction-sequence", model_sha256: model.hash};
}

function ledgerSHA256(records, model) {
  requireValid(Array.isArray(records) && records.length <= 100, "invalid baseline ledger size");
  const ids = new Set();
  const canonical = records.map(record => {
    requireValid(model.validClaim(record) && Object.keys(record).every(key => CLAIM_FIELDS.has(key)) &&
      (!Object.hasOwn(record, "imported") || typeof record.imported === "boolean") &&
      !ids.has(record.id), "invalid or duplicate baseline source");
    ids.add(record.id);
    return [record.id, record.key, record.value, record.time, record.status,
      Object.hasOwn(record, "imported") ? [record.imported] : []];
  });
  return createHash("sha256").update(JSON.stringify(["aru-ledger-commitment-1", canonical])).digest("hex");
}

function verifyLedgerCheckpoint(baseline, checkpoint, model = loadModel()) {
  requireValid(baseline && typeof baseline === "object" && !Array.isArray(baseline) &&
    Object.keys(baseline).length === 4 &&
    ["format", "version", "records", "next_source_id"].every(key => Object.hasOwn(baseline, key)) &&
    baseline.format === "aru-evidence-ledger-baseline" && baseline.version === 1 &&
    Array.isArray(baseline.records) && Number.isSafeInteger(baseline.next_source_id) &&
    baseline.next_source_id >= 1 && baseline.next_source_id <= 1e9 + 1,
    "checkpoint requires a reference ledger baseline with records and next_source_id");
  const ledgerDigest = ledgerSHA256(baseline.records, model);
  requireValid(baseline.records.every(record => record.id < baseline.next_source_id),
    "reference next source ID must exceed every record ID");
  requireValid(checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint) &&
    Object.keys(checkpoint).length === 4 &&
    ["format", "version", "encoding", "sha256"].every(key => Object.hasOwn(checkpoint, key)) &&
    checkpoint.format === "aru-evidence-ledger-checkpoint" && checkpoint.version === 1 &&
    checkpoint.encoding === "aru-evidence-ledger-checkpoint-1" &&
    typeof checkpoint.sha256 === "string" && /^[0-9a-f]{64}$/.test(checkpoint.sha256),
    "unsupported checkpoint format, encoding, or digest");
  const expected = createHash("sha256").update(JSON.stringify([
    "aru-evidence-ledger-checkpoint-1", ledgerDigest, baseline.next_source_id])).digest("hex");
  requireValid(checkpoint.sha256 === expected, "checkpoint differs from supplied reference ledger");
  return true;
}

function verifyCorrectionPacket(packet, model, baseline) {
  const keys = ["format", "version", "model_revision", "start_sha256", "steps"];
  requireValid(keys.every(key => Object.hasOwn(packet, key)) &&
    Object.keys(packet).every(key => keys.includes(key)) && packet.version === 1 &&
    packet.model_revision === PACKET_REVISION && /^[0-9a-f]{64}$/.test(packet.start_sha256) &&
    Array.isArray(packet.steps) && packet.steps.length >= 2 && packet.steps.length <= 8,
    "unsupported compact packet format, commitment, or step count (2–8)");
  requireValid(baseline && typeof baseline === "object" && !Array.isArray(baseline) &&
    Object.keys(baseline).length === 4 &&
    ["format", "version", "records", "next_source_id"].every(key => Object.hasOwn(baseline, key)) &&
    baseline.format === "aru-evidence-ledger-baseline" && baseline.version === 1 &&
    Array.isArray(baseline.records) && Number.isSafeInteger(baseline.next_source_id) &&
    baseline.next_source_id >= 1 && baseline.next_source_id <= 1e9 + 1,
    "matching baseline JSON with records and next_source_id required");
  let records = baseline.records;
  requireValid(ledgerSHA256(records, model) === packet.start_sha256,
    "starting ledger commitment differs from baseline");
  let counter = baseline.next_source_id;
  const steps = [];
  const stepKeys = ["name", "value", "new_source_id", "applied_at", "after_sha256"];
  for (const step of packet.steps) {
    requireValid(step && typeof step === "object" && !Array.isArray(step) &&
      stepKeys.every(key => Object.hasOwn(step, key)) &&
      Object.keys(step).every(key => stepKeys.includes(key)) &&
      /^[0-9a-f]{64}$/.test(step.after_sha256), "invalid compact correction step or commitment");
    requireValid(step.new_source_id === Math.max(counter, 1, ...records.map(record => record.id + 1)),
      "compact correction source ID differs from baseline's next ID");
    try {
      records = model.correct(step.name, step.value, records, step.new_source_id, step.applied_at);
    } catch (error) { requireValid(false, error.message); }
    requireValid(ledgerSHA256(records, model) === step.after_sha256,
      "resulting ledger commitment differs from compact packet");
    steps.push(step.new_source_id);
    counter = step.new_source_id + 1;
  }
  return {kind: "packet", steps, records: records.length,
    scope: "matching-baseline-only", model_sha256: model.hash};
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

function verifyLedgerBaseline(baseline, model = loadModel()) {
  requireValid(baseline && typeof baseline === "object" && !Array.isArray(baseline) &&
    Object.keys(baseline).length === 4 &&
    ["format", "version", "records", "next_source_id"].every(key => Object.hasOwn(baseline, key)) &&
    baseline.format === "aru-evidence-ledger-baseline" && baseline.version === 1 &&
    Array.isArray(baseline.records) && Number.isSafeInteger(baseline.next_source_id) &&
    baseline.next_source_id >= 1 && baseline.next_source_id <= 1e9 + 1,
    "reference ledger baseline JSON with records and next_source_id required");
  ledgerSHA256(baseline.records, model);
  requireValid(baseline.records.every(record => record.id < baseline.next_source_id),
    "reference next source ID must exceed every record ID");
  return true;
}

function compareWithReference(receipt, model, baseline, result) {
  if (baseline === null) return result;
  verifyLedgerBaseline(baseline, model);
  if (receipt.format === "aru-evidence-answer-excerpt") {
    const expected = model.resolve(receipt.question, baseline.records);
    try { assert.deepStrictEqual(receipt.answer, expected); }
    catch (_) { requireValid(false, "reference ledger gives a different answer or citations"); }
    const referenceById = new Map(baseline.records.map(record => [record.id, record]));
    for (const record of receipt.records) {
      try { assert.deepStrictEqual(record, referenceById.get(record.id)); }
      catch (_) { requireValid(false, `cited source #${record.id} differs from reference ledger`); }
    }
    return {...result, reference_match: true, reference_scope: "answer-and-cited-records"};
  }
  try { assert.deepStrictEqual(receipt.records, baseline.records); }
  catch (_) { requireValid(false, "supplied full snapshot differs from reference ledger"); }
  return {...result, reference_match: true, reference_scope: "exact-full-snapshot"};
}

function verifyEvidenceReceipt(receipt, model = loadModel(), baseline = null, checkpoint = null) {
  if (checkpoint !== null) verifyLedgerCheckpoint(baseline, checkpoint, model);
  requireValid(receipt && typeof receipt === "object" && !Array.isArray(receipt), "object expected");
  if (receipt.format === "aru-evidence-correction-packet") return verifyCorrectionPacket(receipt, model, baseline);
  if (receipt.format === "aru-evidence-correction-chain" || receipt.format === "aru-evidence-correction-receipt") {
    requireValid(baseline === null, "reference baseline is for question and brief receipts, or compact correction packets");
    return receipt.format === "aru-evidence-correction-chain"
      ? verifyCorrectionChain(receipt, model) : verifyCorrectionReceipt(receipt, model);
  }
  if (receipt.format === "aru-evidence-brief-receipt") {
    return compareWithReference(receipt, model, baseline, verifyBriefReceipt(receipt, model));
  }
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
  return compareWithReference(receipt, model, baseline,
    { kind: computed.kind, sources: computed.sources || [], records: ids.size,
      scope: excerpt ? "cited-assertions-only" : "full-supplied-snapshot", model_sha256: model.hash });
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
    return new TextDecoder("utf-8", {fatal: true}).decode(buffer.subarray(0, length));
  } finally { fs.closeSync(fd); }
}

if (require.main === module) {
  try {
    if (process.argv.length < 3 || process.argv.length > 5) {
      throw new Error("Usage: node tools/verify-evidence-receipt.cjs <receipt.json> [matching-baseline.json] [prior-checkpoint.json]");
    }
    const readJSON = (file, label) => {
      try { return parseUnambiguousJSON(readLimited(file)); }
      catch (error) {
        if (error.message === "Duplicate JSON object name") {
          throw new Error(`Invalid ${label}: duplicate JSON object name`);
        }
        if (error instanceof SyntaxError || error instanceof TypeError) {
          throw new Error(`Invalid ${label}: file is not valid unambiguous UTF-8 JSON`);
        }
        throw error;
      }
    };
    const receipt = readJSON(process.argv[2], "receipt");
    let baseline = null;
    if (process.argv[3]) baseline = readJSON(process.argv[3], "baseline");
    let checkpoint = null;
    if (process.argv[4]) {
      checkpoint = readJSON(process.argv[4], "checkpoint");
      requireValid(checkpoint !== null, "unsupported checkpoint format, encoding, or digest");
    }
    const result = verifyEvidenceReceipt(receipt, loadModel(), baseline, checkpoint);
    if (result.kind === "packet") {
      console.log(`MATCH: ${result.steps.length} compact corrections; sources ${result.steps.map(id => `#${id}`).join(" → ")}; ${result.records} resulting records; scope ${result.scope}`);
    } else if (result.kind === "chain") {
      console.log(`PASS: ${result.steps.length} consecutive corrections; sources ${result.steps.map(id => `#${id}`).join(" → ")}; ${result.records} resulting records; scope ${result.scope}`);
    } else if (result.kind === "correction") {
      console.log(`PASS: correction source #${result.new_source_id}; ${result.superseded} prior current source${result.superseded === 1 ? "" : "s"} superseded; ${result.records} resulting records; scope ${result.scope}`);
    } else if (result.kind === "brief") {
      console.log(`${result.reference_match ? "MATCH" : "PASS"}: ${result.names} names; ${result.known} sourced answer${result.known === 1 ? "" : "s"}; ${result.names - result.known} refusal${result.names - result.known === 1 ? "" : "s"}; ${result.records} supplied records; scope ${result.scope}${result.reference_match ? `; reference ${result.reference_scope}` : ""}`);
    } else {
      console.log(`${result.reference_match ? "MATCH" : "PASS"}: ${result.kind}; ${result.records} supplied records; ${result.sources.length} cited sources; scope ${result.scope}${result.reference_match ? `; reference ${result.reference_scope}` : ""}`);
    }
    if (process.argv[4]) console.log("CHECKPOINT MATCH: the supplied reference ledger matches the separately provided digest.");
    console.log(`Local model SHA-256: ${result.model_sha256}`);
    console.log("This checks supplied records or the explicit matching baseline, not their origin or factual truth.");
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { verifyEvidenceReceipt, verifyLedgerCheckpoint, verifyLedgerBaseline };
