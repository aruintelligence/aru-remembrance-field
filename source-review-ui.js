(function (root) {
  "use strict";

  // This is a comparison of an editable report with this page's own replay.
  // The report's assertion that Python ran is never treated as an attestation.
  const LIMITS = ["authorship", "independent_custody", "completeness", "factual_truth"];
  const keysAre = (value, keys) => value && typeof value === "object" &&
    !Array.isArray(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key));
  const mismatch = reason => ({state: "unconfirmed", reason});
  const WITHHELD = {
    capture_unconfirmed: "the saved capture did not replay",
    checker_rejected: "the separate checker rejected the inputs",
    checker_invalid_output: "the separate checker returned invalid output",
    checker_disagreement: "the two checker implementations disagreed",
    selection_changed_during_review: "the original files changed during review"
  };

  function compareSourceReport(report, capture, records, findings) {
    if (report?.format === "aru-independent-source-review" && report.version === 1 &&
        report.assessment === "UNCONFIRMED") {
      return mismatch(`The independent command withheld its map: ${Object.hasOwn(WITHHELD, report.reason) ?
        WITHHELD[report.reason] : "reason unknown"}. Inspect its output and run it again before comparing.`);
    }
    if (!keysAre(report, ["format", "version", "assessment", "capture_replay", "capture_binding",
      "receipt_assessment", "totals", "source_map", "not_established"]) ||
        report.format !== "aru-independent-source-review" || report.version !== 1) {
      return mismatch("Unsupported or malformed independent review report.");
    }
    if (report.assessment !== "MATCH") {
      return mismatch("The supplied report did not accept a source map. Re-run its independent command and inspect the reason.");
    }
    if (!Array.isArray(report.not_established) || report.not_established.length !== LIMITS.length ||
        LIMITS.some((item, index) => report.not_established[index] !== item)) {
      return mismatch("The report's trust limits differ from this review format.");
    }
    if (!["not_checked", "MATCH"].includes(report.capture_replay) ||
        (report.capture_replay === "not_checked" ? report.capture_binding !== null :
          !keysAre(report.capture_binding, ["script", "selected_name_runtime"]) ||
          !["matched", "unavailable_legacy_v1"].includes(report.capture_binding.script) ||
          !["selected_profile_matched", "not_recorded_in_capture"].includes(
            report.capture_binding.selected_name_runtime))) {
      return mismatch("The saved-capture field in the report is malformed.");
    }
    const map = report.source_map;
    if (!keysAre(map, ["format", "version", "selection", "source_ids", "rows"]) ||
        map.format !== "aru-source-removal-map" || map.version !== 1 ||
        !keysAre(map.selection, ["reference_sha256", "checkpoint_sha256",
          "normalization_sha256", "browser_script_sha256", "receipts"])) {
      return mismatch("The source map has an unsupported format or selection.");
    }
    const selection = map.selection;
    for (const [key, label] of [
      ["reference_sha256", "Reference file digest"],
      ["checkpoint_sha256", "Checkpoint selection or digest"],
      ["normalization_sha256", "Selected-name runtime profile"],
      ["browser_script_sha256", "Browser verifier script"]]) {
      if (selection[key] !== capture[key]) return mismatch(`${label} differs from the current audit.`);
    }
    if (!Array.isArray(selection.receipts) || selection.receipts.length !== capture.receipts.length ||
        !Array.isArray(findings) || findings.length !== capture.receipts.length) {
      return mismatch("The number of ordered receipts differs from the current audit.");
    }
    for (let index = 0; index < capture.receipts.length; index++) {
      const actual = selection.receipts[index], expected = capture.receipts[index];
      if (!keysAre(actual, ["index", "sha256", "verdict", "duplicate_of"]) ||
          actual.index !== expected.index || actual.sha256 !== expected.sha256) {
        return mismatch(`Receipt #${index + 1} file bytes or order differ from the current audit.`);
      }
      if (actual.verdict !== expected.verdict || actual.duplicate_of !== expected.duplicate_of) {
        return mismatch(`Receipt #${index + 1} outcome or identical-byte repeat differs.`);
      }
    }
    if (!Array.isArray(records) || !Array.isArray(map.source_ids) ||
        map.source_ids.length !== records.length) return mismatch("The number of source IDs differs.");
    for (let index = 0; index < records.length; index++) {
      if (map.source_ids[index] !== records[index].id) {
        return mismatch(`Source ID or order differs at position ${index + 1}.`);
      }
    }
    if (!Array.isArray(map.rows) || map.rows.length !== findings.length) {
      return mismatch("The source map's receipt rows are missing or reordered.");
    }
    for (let index = 0; index < findings.length; index++) {
      const row = map.rows[index], expected = findings[index];
      if (!keysAre(row, expected.skipped ? ["index", "verdict", "skipped"] :
        ["index", "verdict", "removals"]) ||
          row.index !== index + 1 || row.verdict !== expected.verdict) {
        return mismatch(`Receipt #${index + 1} source-map result differs.`);
      }
      if (expected.skipped) {
        if (row.skipped !== true) return mismatch(`Receipt #${index + 1} must stay unprobed after FAIL.`);
        continue;
      }
      if (!Array.isArray(row.removals) || row.removals.length !== records.length) {
        return mismatch(`Receipt #${index + 1} has missing source-removal trials.`);
      }
      for (let sourceIndex = 0; sourceIndex < records.length; sourceIndex++) {
        const source = records[sourceIndex], trial = row.removals[sourceIndex];
        if (!keysAre(trial, ["source_id", "verdict", "answer_changed"]) ||
            trial.source_id !== source.id) {
          return mismatch(`Receipt #${index + 1} source ID/order differs at trial ${sourceIndex + 1}.`);
        }
        const flipped = expected.flips.find(item => item.id === source.id);
        if (trial.verdict !== (flipped?.verdict || expected.verdict)) {
          return mismatch(`Receipt #${index + 1}, source #${source.id}: removal verdict differs.`);
        }
        if (trial.answer_changed !== expected.answerChanges.includes(source.id)) {
          return mismatch(`Receipt #${index + 1}, source #${source.id}: answer/citation change differs.`);
        }
      }
    }
    const totals = capture.totals;
    if (!keysAre(report.totals, ["match", "differ", "fail"]) ||
        ["match", "differ", "fail"].some(key => report.totals[key] !== totals[key])) {
      return mismatch("The receipt totals differ from this browser's audit.");
    }
    const assessment = totals.fail ? "recorded_failures" :
      totals.differ ? "recorded_differences" : "all_receipts_match";
    if (report.receipt_assessment !== assessment) {
      return mismatch("The report misstates the recorded receipt outcomes.");
    }
    return {state: "aligned", sourceCount: records.length, receiptCount: findings.length,
      totals: {match: totals.match, differ: totals.differ, fail: totals.fail},
      flips: findings.reduce((sum, row) => sum + (row.flips?.length || 0), 0),
      answerChanges: findings.reduce((sum, row) => sum + (row.answerChanges?.length || 0), 0),
      captureClaim: report.capture_replay};
  }

  if (typeof module !== "undefined" && module.exports) module.exports = {compareSourceReport};
  if (typeof document === "undefined") return;

  const reportInput = document.getElementById("independent-review-file");
  const compareButton = document.getElementById("independent-review-compare");
  const output = document.getElementById("independent-review-result");
  let request = 0;
  function show(state, message) {
    output.dataset.state = state;
    output.textContent = message;
  }
  function invalidate() {
    ++request;
    show("pending", "Selection changed. Audit the original files, then compare this report again.");
  }
  for (const id of ["reference-file", "checkpoint-file", "audit-receipts", "audit-capture-file"]) {
    document.getElementById(id).addEventListener("change", invalidate);
  }
  for (const id of ["review-desk-audit-run", "audit-run", "review-desk-compare", "audit-capture-verify"]) {
    document.getElementById(id).addEventListener("click", invalidate);
  }
  reportInput.addEventListener("change", () => {
    invalidate();
    compareButton.disabled = !reportInput.files?.[0];
    if (reportInput.files?.[0]) show("pending", "Report selected. Compare it with a completed audit of the same originals.");
  });

  compareButton.addEventListener("click", async () => {
    const file = reportInput.files?.[0];
    const data = sourceProbeData;
    const audit = lastEvidenceBatchCapture;
    if (!file || !data || !audit) {
      show("caution", "Run the browser audit with secure hashing before comparing a report.");
      return;
    }
    const reference = document.getElementById("reference-file").files?.[0];
    const checkpoint = document.getElementById("checkpoint-file").files?.[0];
    const receipts = Array.from(document.getElementById("audit-receipts").files || []);
    const current = () => reportInput.files?.[0] === file && sourceProbeData === data &&
      lastEvidenceBatchCapture === audit && reference === data.referenceFile &&
      checkpoint === data.checkpointFile && receipts.length === data.files.length &&
      receipts.every((item, index) => item === data.files[index]) &&
      document.getElementById("reference-file").files?.[0] === reference &&
      document.getElementById("checkpoint-file").files?.[0] === checkpoint &&
      document.getElementById("audit-receipts").files?.length === receipts.length &&
      receipts.every((item, index) => document.getElementById("audit-receipts").files[index] === item);
    if (!current()) { invalidate(); return; }
    const token = ++request;
    show("pending", "Reading the selected originals and comparing every source-removal trial…");
    try {
      const reportBytes = await readEvidenceAuditBytes(file, "Independent report");
      if (token !== request || !current()) return;
      const report = parseEvidenceAuditJSON(reportBytes.raw, "Independent report");
      const originals = [reference, ...receipts, ...(checkpoint ? [checkpoint] : [])];
      const hashes = await Promise.all(originals.map(async (item, index) => {
        const bytes = await readEvidenceAuditBytes(item, `Original file #${index + 1}`);
        return evidenceAuditSHA256(bytes.bytes);
      }));
      if (token !== request || !current()) return;
      const expectedHashes = [audit.payload.reference_sha256,
        ...audit.payload.receipts.map(row => row.sha256),
        ...(checkpoint ? [audit.payload.checkpoint_sha256] : [])];
      if (hashes.some((hash, index) => hash !== expectedHashes[index])) {
        show("unconfirmed", "An original file's bytes changed after the browser audit. Audit the originals again.");
        return;
      }
      if (reviewDeskReplay?.kind === "unconfirmed") {
        show("unconfirmed", "The saved capture failed its browser replay. Resolve that difference before using this comparison.");
        return;
      }
      const findings = sourceRemovalFindings(data.records, data.rows);
      if (token !== request || !current()) return;
      const result = compareSourceReport(report, audit.payload, data.records, findings);
      if (result.state !== "aligned") { show(result.state, `UNCONFIRMED: ${result.reason}`); return; }
      runSourceRemovalProbe();
      if (token !== request || !current()) return;
      const captureNote = reviewDeskReplay?.kind === "match" ?
        " A saved capture for these originals was replayed here; the report does not identify which capture it checked." : result.captureClaim === "MATCH" ?
          " The report claims a saved-capture replay; this page has not checked that capture." :
          " No saved capture was checked here.";
      show("aligned", `MAP ALIGNS: ${result.sourceCount} supplied sources × ${result.receiptCount} receipts; ` +
        `${result.flips} verdict flips and ${result.answerChanges} answer/citation changes. ` +
        `Recorded receipts: ${result.totals.match} MATCH, ${result.totals.differ} DIFFER, ${result.totals.fail} FAIL.` +
        captureNote + " This editable report does not prove the independent checker ran or that a claim is true.");
    } catch (error) {
      if (token === request && current()) {
        const message = error.message || "";
        const detail = /^(Independent report|Original file #\d+) (has a duplicate JSON object name\.|is not valid JSON\.|is not valid UTF-8\.|exceeds the 1 MiB limit\.)$/.test(message) ?
          message : "The report or selected originals could not be compared.";
        show("unconfirmed", `UNCONFIRMED: ${detail}`);
      }
    }
  });
})(globalThis);
