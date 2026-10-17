# Local batch audit of shared answer receipts

The browser's **Audit a set of shared answers** control accepts one saved reference ledger, an optional separately held prior checkpoint, and 1–20 question, cited excerpt, or brief receipts. It reads the selected files on the device; no record is added to browser storage and the app does not upload the files. A reference, checkpoint, and each receipt are limited to 1 MiB; the selected receipts together are limited to 4 MiB.

The reference must be a valid `aru-evidence-ledger-baseline` v1 file. If a checkpoint is supplied, it must be a valid `aru-evidence-ledger-checkpoint` v1 file whose SHA-256 digest matches that reference's ordered records **and** next source ID. A malformed reference or checkpoint, an unavailable secure hash implementation, or a checkpoint mismatch stops the audit before any receipt is accepted. The selected checkpoint is meaningful as prior evidence only if it was preserved independently before the later files were received.

For each selected receipt, the browser checks the format, fields, records, and computed answer using the same `verifyEvidenceBundle` function as single-file verification. It then uses `compareEvidenceToReference` against the shared reference. A cited excerpt is checked against the answer computed from the entire reference and the exact cited records; a full question or brief receipt must carry the exact ordered reference snapshot. Per-file outcomes are:

| Outcome | Meaning |
| --- | --- |
| `MATCH` | The receipt passes replay and agrees with the selected reference under its scope. |
| `DIFFER` | The receipt passes replay but disagrees with the selected reference. |
| `FAIL` | The receipt cannot be read, parsed, or replayed as a supported answer receipt. |

The browser reads bytes and decodes strict UTF-8. The summary counts all selected files. It separately counts bytes that are exactly identical to a previous file, and each repeated row names the first file's number. This check does not identify semantically identical JSON with different whitespace or key order, and distinct files can still share an origin. The file name is displayed as text and is never used as evidence. Changing the reference, checkpoint, or receipt selection clears the previous audit and capture; a slow older read or hash cannot replace a newer result.

The audit checks only the selected set and the supplied reference. `MATCH` does not prove that any assertion is true, that an author is authentic, that the reference is complete, or that two files are independent. The [single receipt protocol](evidence-receipt-protocol.md) and [checkpoint protocol](evidence-ledger-checkpoint-protocol.md) describe the underlying checks. The automated browser tests cover mixed outcomes, omitted conflicts, repeated text, invalid/oversized files, a changed checkpoint, stale selections, and read-only behavior.

To inspect a verdict under two selected ledgers, use **Trace a verdict across two references** below the capture controls. The [reference transition protocol](reference-transition-protocol.md) documents its field-level, value-hidden explanation, synthetic before-and-after case, and limits. Its A and B labels do not establish which ledger came first.

## Download and replay a browser capture

After the browser audit, **Download audit capture** writes `aru-evidence-browser-batch-capture` version 2 JSON with SHA-256 of the exact loaded inline browser script and the raw bytes of the selected reference, optional checkpoint, and each receipt in selection order. It includes per-file verdict and first byte-identical index plus totals. It contains no filenames, records, questions, or answer values. It is available only when all selected files can be read within the 1 MiB/4 MiB bounds, secure Web Crypto hashing is available, and the inline script source can be read. Malformed or unsupported JSON can still be recorded as `FAIL`. A changed file selection disables the download. The browser stores no copy of the file contents in the capture or local storage.

To replay within the page, select the original reference, optional checkpoint, and receipts in the original order, then run **Audit selected receipts**. Choose the saved JSON under **Saved audit capture** and select **Compare saved capture**. The browser checks exact structure, all ordered byte hashes and verdicts, duplicate indices, totals, and the v2 loaded inline script hash. `CAPTURE MATCH` can reproduce `DIFFER` and `FAIL` outcomes in the audited receipts; the counts and audit rows are a separate result. A mismatch produces a bounded, local list of changed components (script, reference, checkpoint, individual receipt position/bytes/verdict/repeat relationship, totals, or structure). The list includes no assertion values, raw hashes, or untrusted fields from the capture. It says what differs, not who changed it or why. An invalid, unreadable, or oversized capture fails; changing any selected file clears the prior result, and an older slow read cannot replace a newer comparison. A capture made under an older browser script requires that older version for a v2 match. Version 1 is accepted with an explicit notice that it has no script fingerprint. The page reads the capture locally and does not add its contents to storage.

Keep the original selected files in order and use the CLI to replay the capture:

```bash
node tools/audit-evidence-batch.cjs research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json research/example-evidence-receipt.json --checkpoint research/example-evidence-ledger-checkpoint.json --check-capture research/example-evidence-browser-batch-capture.json
```

The CLI recomputes hashes and outcomes using the same declared receipt rules and rejects any difference in the capture's structure, files, order, verdicts, duplicate indices, totals, or inline browser script bytes in the current checkout. The included [synthetic v2 capture](example-evidence-browser-batch-capture.json) is checked in CI. Older [v1 captures](example-evidence-browser-batch-capture-v1.json) still replay with an explicit message that they lack a browser script hash. The capture does not include CLI code hashes; create a separate CLI report below if you also need to pin verifier and auditor bytes. A successful `--check-capture` means the capture was reproduced, **even if it records `DIFFER` or `FAIL`**. Check its counts. The script hash is not a signature or timestamp and does not pin HTML, CSS, external scripts, or the browser runtime. This cross-runtime replay tests software consistency, not a separate implementation of the answer model.

## Cross-check with an independently written Python auditor

The [Python checker](../tools/independent-evidence-batch.py) separately implements the question, excerpt, brief, reference, and checkpoint rules instead of importing the JavaScript model. It reads the same ordered files, computes raw-byte SHA-256 and exact byte repeats, and produces a result without filenames or answer values. Python 3.12 and its standard library are sufficient:

```bash
python3 tools/independent-evidence-batch.py research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json research/example-evidence-receipt.json --checkpoint research/example-evidence-ledger-checkpoint.json --check-capture research/example-evidence-browser-batch-capture.json
python3 tools/independent-evidence-batch.py reference.json answer-1.json answer-2.json --json
```

Without `--check-capture`, the command exits nonzero for any `DIFFER` or `FAIL` while still writing the JSON report. With it, a successful exit means all recorded outcomes, byte hashes, totals, and the v2 inline browser script fingerprint were independently reproduced, even when a supplied receipt failed. A v1 capture can still be checked but has no script fingerprint. The Python report also identifies its own source bytes with `python_verifier_sha256`; retaining both the code and original input files is necessary for later reproduction.

The automated cross-check covers a mixed batch with omissions, changed citations, invalid UTF-8, malformed JSON, unsupported formats, edited results, and exact versus differently spaced copies. It also runs 24 deterministic variations of source status, values, Unicode name normalization, and citations against both auditors. It checks agreement on these inputs; the two implementations follow the same hand-written specification and can share a mistaken rule. Canonical checkpoint examples use integer millisecond timestamps as the browser exports do. Captures and reports are unsigned and editable, and neither an independent implementation nor a matching digest establishes origin, completeness, or factual truth.

## Reproduce a batch with the command-line auditor

The [batch auditor](../tools/audit-evidence-batch.cjs) independently reads the ordered input files from disk and replays the existing receipt verifier against one reference. It rejects malformed reference/checkpoint files before opening receipts, requires regular files of at most 1 MiB, 1–20 receipts, and no more than 4 MiB of receipt bytes combined. Receipt files that fit those bounds receive `MATCH`, `DIFFER`, or `FAIL`; a malformed, unsupported, or internally inconsistent receipt gets `FAIL`. A valid receipt that disagrees with the reference gets `DIFFER`. If supplied, a checkpoint must match the reference before any receipt is evaluated.

```bash
node tools/audit-evidence-batch.cjs research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json research/example-evidence-receipt.json --checkpoint research/example-evidence-ledger-checkpoint.json --json > batch-report.json
node tools/audit-evidence-batch.cjs research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json research/example-evidence-receipt.json --checkpoint research/example-evidence-ledger-checkpoint.json --check-report batch-report.json
```

The version 1 JSON report records SHA-256 of the **raw bytes** of the reference, optional checkpoint, and each receipt in argument order. It includes each verdict and its stage (`invalid-json`, `unsupported-format`, `replay-failed`, `reference-mismatch`, or no error), the first earlier byte-identical file's one-based index, totals, and SHA-256 values for the extracted model, receipt verifier file, and batch auditor file. Exact byte comparisons confirm duplicates even in the hypothetical case of a hash collision. The report intentionally omits filenames, questions, records, and answers. Both batch paths reject invalid UTF-8.

`--check-report` recomputes the report from the same ordered inputs and current verifier code and requires exact structural equality with the saved JSON; changed bytes, changed order, changed code, or an edited verdict fail the check. To replay an older report after an intentional verifier update, retain or check out the original code version. The included [synthetic report](example-evidence-batch-audit-report.json) is checked in CI. An ordinary audit exits nonzero when any receipt differs or fails, while `--check-report` exits successfully when it reproduces the recorded report **even if that report contains failures**. Review the counts before accepting an audit.

The report itself is neither signed nor timestamped. A person who controls the original files, code, and report can produce a new internally matching set. Raw SHA-256 digests can permit offline guesses of predictable private facts. Keep the report private when that matters, preserve a prior checkpoint separately, and retain the original ordered files for a later replay. Passing tests and hashes are reproducibility checks of software behavior, not evidence of factual truth or submission completeness.
