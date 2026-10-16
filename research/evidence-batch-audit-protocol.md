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
