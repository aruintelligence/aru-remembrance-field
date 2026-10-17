# Portable reference transition capture — invention and verification record

## Problem and mechanism

The two-reference lens explains a verdict change in the page, but a screenshot cannot bind the underlying references, receipts, selection order, outcomes, or verifier version. A paired transition capture saves **two version 2 browser batch captures** for the same ordered receipt files, one for reference A and one for B, plus the one-based positions whose verdicts changed. Both sides include the loaded inline browser script fingerprint, raw SHA-256 file hashes, optional checkpoint hash, ordered verdicts, exact-byte repeat indices, and totals. It includes no names, questions, assertions, filenames, or source-level explanation. The in-page lens supplies that explanation when a recipient reselects the originals.

From **Trace a verdict across two references**, choose A and its optional checkpoint, B and its optional checkpoint, and 1–20 receipts in one order. Select **Trace selected receipts**, then **Download transition capture**. Both checkpoints must agree with their respective ordered ledgers and next source IDs before a capture is available. The browser does not offer a capture when any input is unreadable, invalid UTF-8, oversized, the selected receipts exceed 4 MiB combined, secure hashing is unavailable, or the loaded inline script is unavailable. A readable malformed JSON receipt can be recorded as `FAIL` on both sides. The trace remains visible when capture creation is unavailable. Changing a selection clears the old capture.

To replay in the page, select the same original files and order, run the trace, choose the saved JSON under **Saved transition capture**, and select **Compare saved transition capture**. `TRANSITION CAPTURE MATCH` means the entire structure, both references/checkpoints, ordered receipt bytes, repeat relationships, verdicts, totals, changed positions, and script fingerprint reproduced. Read the A and B `MATCH`, `DIFFER`, and `FAIL` counts separately: a matching capture can faithfully record failures. A legacy version 1 single-reference capture cannot substitute for either version 2 side. The saved file is limited to 1 MiB and strict UTF-8; older asynchronous reads cannot replace a newer selection.

## Reproduce independently

From the repository version matching the capture's inline browser script, run these exact commands. They both exit 0 for the included synthetic transition **despite two `DIFFER` verdicts on side B**. Without `--check-transition`, the same transition audit exits 1 because B has two `DIFFER` results.

```bash
node tools/audit-evidence-batch.cjs research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json research/example-evidence-receipt.json --checkpoint research/example-evidence-ledger-checkpoint.json --reference-b research/example-evidence-reference-conflict.json --check-transition research/example-evidence-reference-transition-capture.json
python3 tools/independent-evidence-batch.py research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json research/example-evidence-receipt.json --checkpoint research/example-evidence-ledger-checkpoint.json --reference-b research/example-evidence-reference-conflict.json --check-transition research/example-evidence-reference-transition-capture.json
```

For a second checkpoint add `--checkpoint-b /path/to/b-checkpoint.json`. The Node auditor replays the JavaScript answer rules; the Python auditor implements those rules separately. Both recompute the paired object and require strict structural equality, rejecting unexpected fields, changed hashes or verdicts, missing/reordered receipts, totals, changed-position lists, and script fingerprints. The [offline verifier kit](verifier-kit-protocol.md) can be created directly from this transition capture to retain the matching code and both auditors without packing the evidence files or the capture itself.

## Trust, privacy, prior art, and what remains unproven

File hashes can support guesses about predictable private assertions. Share the capture deliberately. It is not signed or timestamped; someone controlling the inputs and code can replace the capture and make a different internally consistent one. The inline script hash does not bind the browser runtime or surrounding HTML/CSS; the kit manifest records the other code only at packaging time. A and B are labels, not verified dates. A matching replay says nothing about which reference is complete, who entered the assertions, their truth, or whether a checkpoint was preserved independently.

The [added-source answer witness](addition-witness-protocol.md) is a recomputed view from the original files and matching code. It is not included in this version 1 capture and must not be inferred solely from its hashes and verdicts.

Investigate paired provenance records, reproducible build manifests, decision diffs, content-addressed evidence packaging, and signed attestations before making any novelty claim. A future authenticated distribution layer needs an explicit key custody, rotation, and revocation policy and must keep code origin separate from the truth of supplied facts. The current feature has no demonstrated human usability, custody, or scientific validation and makes no patentability claim.
