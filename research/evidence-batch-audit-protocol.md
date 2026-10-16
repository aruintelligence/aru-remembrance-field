# Local batch audit of shared answer receipts

The browser's **Audit a set of shared answers** control accepts one saved reference ledger, an optional separately held prior checkpoint, and 1–20 question, cited excerpt, or brief receipts. It reads the selected files on the device; no record is added to browser storage and the app does not upload the files. A reference, checkpoint, and each receipt are limited to 1 MiB; the selected receipts together are limited to 4 MiB.

The reference must be a valid `aru-evidence-ledger-baseline` v1 file. If a checkpoint is supplied, it must be a valid `aru-evidence-ledger-checkpoint` v1 file whose SHA-256 digest matches that reference's ordered records **and** next source ID. A malformed reference or checkpoint, an unavailable secure hash implementation, or a checkpoint mismatch stops the audit before any receipt is accepted. The selected checkpoint is meaningful as prior evidence only if it was preserved independently before the later files were received.

For each selected receipt, the browser checks the format, fields, records, and computed answer using the same `verifyEvidenceBundle` function as single-file verification. It then uses `compareEvidenceToReference` against the shared reference. A cited excerpt is checked against the answer computed from the entire reference and the exact cited records; a full question or brief receipt must carry the exact ordered reference snapshot. Per-file outcomes are:

| Outcome | Meaning |
| --- | --- |
| `MATCH` | The receipt passes replay and agrees with the selected reference under its scope. |
| `DIFFER` | The receipt passes replay but disagrees with the selected reference. |
| `FAIL` | The receipt cannot be read, parsed, or replayed as a supported answer receipt. |

The summary counts all selected files. It separately counts text that is exactly identical to a previous decoded file, and each repeated row names the first file's number. This check does not identify semantically identical JSON with different whitespace or key order, and distinct files can still share an origin. The file name is displayed as text and is never used as evidence. Changing the reference, checkpoint, or receipt selection clears the previous audit result; a slow older read cannot replace a newer result.

The audit checks only the selected set and the supplied reference. `MATCH` does not prove that any assertion is true, that an author is authentic, that the reference is complete, or that two files are independent. The [single receipt protocol](evidence-receipt-protocol.md) and [checkpoint protocol](evidence-ledger-checkpoint-protocol.md) describe the underlying checks. The automated browser tests cover mixed outcomes, omitted conflicts, repeated text, invalid/oversized files, a changed checkpoint, stale selections, and read-only behavior.

## Reproduce a batch with the command-line auditor

The [batch auditor](../tools/audit-evidence-batch.cjs) independently reads the ordered input files from disk and replays the existing receipt verifier against one reference. It rejects malformed reference/checkpoint files before opening receipts, requires regular files of at most 1 MiB, 1–20 receipts, and no more than 4 MiB of receipt bytes combined. Receipt files that fit those bounds receive `MATCH`, `DIFFER`, or `FAIL`; a malformed, unsupported, or internally inconsistent receipt gets `FAIL`. A valid receipt that disagrees with the reference gets `DIFFER`. If supplied, a checkpoint must match the reference before any receipt is evaluated.

```bash
node tools/audit-evidence-batch.cjs research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json research/example-evidence-receipt.json --checkpoint research/example-evidence-ledger-checkpoint.json --json > batch-report.json
node tools/audit-evidence-batch.cjs research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json research/example-evidence-receipt.json --checkpoint research/example-evidence-ledger-checkpoint.json --check-report batch-report.json
```

The version 1 JSON report records SHA-256 of the **raw bytes** of the reference, optional checkpoint, and each receipt in argument order. It includes each verdict and its stage (`invalid-json`, `unsupported-format`, `replay-failed`, `reference-mismatch`, or no error), the first earlier byte-identical file's one-based index, totals, and SHA-256 values for the extracted model, receipt verifier file, and batch auditor file. Exact byte comparisons confirm duplicates even in the hypothetical case of a hash collision. The report intentionally omits filenames, questions, records, and answers. The command-line auditor rejects invalid UTF-8; the browser's existing file reader decodes text, so use the CLI for exact byte binding.

`--check-report` recomputes the report from the same ordered inputs and current verifier code and requires exact structural equality with the saved JSON; changed bytes, changed order, changed code, or an edited verdict fail the check. To replay an older report after an intentional verifier update, retain or check out the original code version. The included [synthetic report](example-evidence-batch-audit-report.json) is checked in CI. An ordinary audit exits nonzero when any receipt differs or fails, while `--check-report` exits successfully when it reproduces the recorded report **even if that report contains failures**. Review the counts before accepting an audit.

The report itself is neither signed nor timestamped. A person who controls the original files, code, and report can produce a new internally matching set. Raw SHA-256 digests can permit offline guesses of predictable private facts. Keep the report private when that matters, preserve a prior checkpoint separately, and retain the original ordered files for a later replay. Passing tests and hashes are reproducibility checks of software behavior, not evidence of factual truth or submission completeness.
