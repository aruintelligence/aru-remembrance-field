# Reference transition lens — invention and validation record

## Problem and proposed mechanism

A `DIFFER` verdict says a receipt disagrees with a selected reference but does not tell the reviewer whether a changed reference introduced an omitted conflict, changed a cited record, or merely added an unrelated record to a full snapshot. A reviewer may also mistake a stable `MATCH` for an unchanged ledger. The reference transition lens replays the *same* selected receipts against two selected reference ledgers using the existing browser verifier. It compares computed answer kinds and citation IDs, and identifies added, removed, moved, or modified source IDs and the affected field names. It displays no fact names, values, question text, filenames, or raw hashes in its trace. It never exports a new assertion or modifies local storage.

The selected reference under **Compare with a saved reference** is labeled B; the second file is A. Their optional checkpoints are each validated before any receipt is traced. `A` and `B` do not prove chronology. Each card shows `A: MATCH/DIFFER/FAIL → B: MATCH/DIFFER/FAIL`. A `FAIL` means the receipt could not be replayed and no reference verdict can be inferred. A full receipt requires the entire ordered snapshot; an excerpt can remain `MATCH` when an unrelated record is added. The source difference list is bounded to 12 entries with an omitted count; results remain on this device and clear when a selected file changes. Inputs have the batch audit's 1 MiB per-file, 4 MiB combined, and 20-receipt limits.

The trace reports observed rule inputs and outcomes. It does not prove that a particular person made a change, that the reference was complete, that A came before B, or that an added source is true. A checkpoint supplies a consistency comparison; its custody and creation time are external facts. The lens can now download a [portable transition capture](portable-transition-capture.md) of hashes and verdicts; that capture is not a new answer receipt or a source-level explanation. Preserve both original ledgers, any independently held checkpoints, receipts, and matching verifier version if someone else must reproduce the comparison.

## Reproduce the before-and-after counterexample

In the page, open **Verify a shared answer receipt → Compare with a saved reference → Trace a verdict across two references**. Select `example-evidence-reference-baseline.json` as A and `example-evidence-ledger-checkpoint.json` as A's checkpoint. Select `example-evidence-reference-conflict.json` as B, with no B checkpoint. Select `example-evidence-excerpt.json` and `example-evidence-receipt.json` as the two receipts, then choose **Trace selected receipts**. Both move `MATCH → DIFFER`: source #2 was added, the computed answer changes from `known` to `conflict`, and the full receipt's exact snapshot no longer agrees. The A checkpoint matches; no provenance or truth conclusion follows.

The existing Node and independently written Python auditors can cross-check both sides. Run each command from the repository root; the B commands deliberately exit with status 1 for two `DIFFER` results:

```bash
node tools/audit-evidence-batch.cjs research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json research/example-evidence-receipt.json --checkpoint research/example-evidence-ledger-checkpoint.json
node tools/audit-evidence-batch.cjs research/example-evidence-reference-conflict.json research/example-evidence-excerpt.json research/example-evidence-receipt.json
python3 tools/independent-evidence-batch.py research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json research/example-evidence-receipt.json --checkpoint research/example-evidence-ledger-checkpoint.json
python3 tools/independent-evidence-batch.py research/example-evidence-reference-conflict.json research/example-evidence-excerpt.json research/example-evidence-receipt.json
```

For a negative control, add a record with a different fact name to B instead of a second `favorite color` source. The excerpt remains `MATCH` because its computed answer and cited source agree, while the full receipt becomes `DIFFER` because the ordered snapshot changed. A malformed receipt remains `FAIL` on both sides; a changed checkpoint blocks the trace before receipts are opened. Browser tests cover these controls, the reverse `DIFFER → MATCH` transition, private value hiding, and stale reads.

## Prior art and remaining work

Investigate evidence provenance viewers, version-control blame and semantic diffs, decision trace interfaces, and causal counterfactual tools before describing this mechanism as novel. This implementation does not search all possible subsets of changes to find a minimal causal explanation; the source list and computed answers describe observable differences under the declared rules. Independent usability testing is still needed to learn whether a reviewer understands scope, checkpoints, and unchanged verdicts. No patentability or scientific validation claim is made.
