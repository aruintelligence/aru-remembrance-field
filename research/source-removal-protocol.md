# Source-removal probe — local sensitivity of a supplied audit

## What it answers

The Review Desk previously told a reviewer whether receipts matched a supplied reference and whether a saved capture replayed. It did not show how much the answer depended on each supplied record. A full question receipt can change verdict merely because its exact snapshot changes, even when the computed answer stays the same. An excerpt can move from `DIFFER` to `MATCH` if a conflicting record is removed from the reference. Both observations matter when interpreting an audit.

After a successful audit, select **Probe one-source removals**. The page uses only the already validated reference and replayable receipts. It makes a temporary in-memory copy of the reference without source #1, recomputes each receipt's reference verdict and computed answer/citations, then repeats for each other source. The original reference, receipts, optional checkpoint, capture, and personal browser ledger are not changed or exported. The result is a card per receipt with the original verdict, counts of verdict flips and computed answer/citation changes, and an expandable exact list of source IDs. A `FAIL` receipt cannot be probed and says so. Changing selected files clears the result and requires another audit. No source names, values, questions, or raw file hashes appear in the probe output.

The probe does **not** check an altered reference against the original checkpoint: such a copy would differ by construction. If the checkpoint mismatches the original reference, the audit stops and this probe is unavailable. Without secure browser hashing, an audit can still run and the probe remains available; capture download is withheld separately.

## Reproduce two differences

Open the [live page](https://aruintelligence.github.io/aru-remembrance-field/), select **Review evidence files**, choose [the two-source conflicting reference](example-evidence-reference-conflict.json) and [the cited excerpt](example-evidence-excerpt.json), audit, then probe. The excerpt starts at `DIFFER`: the reference includes conflicting source #2. Withholding source #2 from a temporary copy yields `MATCH`, and the computed answer/citations change. Withholding source #1 leaves the verdict `DIFFER` while the computed answer/citations change. This is a counterexample to treating `MATCH` after evidence removal as proof of an improved claim.

Now choose [the two-source reference with an unrelated record](example-verdict-witness-reference-unrelated.json) and [the full question receipt](example-evidence-receipt.json), audit, then probe. The full receipt starts at `DIFFER` because the reference contains an extra source. Withholding unrelated source #2 yields `MATCH` while the computed answer and citations remain unchanged: this is a **verdict-only flip**. The selected file is not rewritten; the hypothetical copy retains the remaining record IDs and order. A full receipt binds the complete ordered snapshot, whereas an excerpt checks its answer and cited records against the supplied reference.

The existing independent batch auditors can verify the first scenario's two endpoints against checked-in files (the first commands exit `1` because they report a `DIFFER`, the second exit `0` for `MATCH`):

```bash
node tools/audit-evidence-batch.cjs research/example-evidence-reference-conflict.json research/example-evidence-excerpt.json --json
python3 tools/independent-evidence-batch.py research/example-evidence-reference-conflict.json research/example-evidence-excerpt.json --json
node tools/audit-evidence-batch.cjs research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json --json
python3 tools/independent-evidence-batch.py research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json --json
```

The one-source baseline fixture has the same remaining source record as the temporary copy. Its `next_source_id` differs because it is a separately checked-in ledger export; that field is not used by the answer or receipt comparison, but its raw file hash and any checkpoint would differ. The browser test directly checks the actual in-memory removal and the two distinct result dimensions.

## Boundaries and proof

At most 100 reference records and 20 receipts are already allowed by the existing intake. This probe checks one removal at a time, so it does not claim to find interactions between multiple omitted records or a minimal causal set. A stable verdict and answer under these removals does not imply robustness to edits, new sources, changed code, missing outside evidence, or coordinated manipulation. A source ID is a local label, not evidence of authorship or custody. A matching replay establishes consistency with supplied files and rules, not the truth of an assertion. A malicious party controlling both the reference and receipt can produce a consistent pair. The probe is explanatory, not a security guarantee or independent verifier.

Run `node tests/field.test.cjs` for the browser path. The tests exercise the `DIFFER → MATCH` conflict, a verdict-only full-snapshot change, a failed receipt that cannot be probed, input reselection invalidation, a mismatching checkpoint, no secure hashing, and lack of browser-storage writes. The [independent source review](independent-source-review.md) now recomputes the entire source map under Node and separately implemented Python rules using the same bounded file snapshot. It withholds a positive result on disagreement. The checks still follow the same written specification and cannot prove truth or completeness.

## Invention log

- **Problem:** a reviewer sees an outcome without knowing whether a selected record drives it, and can mistake a snapshot mismatch for a changed answer or a newly matching result after omission for stronger evidence.
- **Mechanism:** a bounded, local one-record removal sweep with separate verdict and computed-answer/citation comparisons, explicit skipped failures, and only source IDs in the view.
- **Prior art to investigate:** leave-one-out sensitivity analysis, counterfactual explanation methods, provenance graphs, database lineage, and evidence dependency visualizations. No comprehensive novelty or patentability review has been performed.
- **Unproven:** user comprehension, usefulness on real workflows, source completeness, independent custody, factual truth, and commercial demand.

The command-line, Python-checked map is implemented. A consented comprehension study can next test whether separating verdict and answer changes reduces mistakes; the present software tests do not measure people.
