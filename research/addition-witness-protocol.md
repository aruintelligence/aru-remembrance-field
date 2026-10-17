# Added-source answer witness — invention and verification record

## Problem and mechanism

A source difference list can show what changed between two selected references without showing which change mattered to a computed answer. For a **pure addition** from A to B, this lens filters B's ordered records to the unchanged A records plus each chosen subset of added source IDs. It recomputes the answer for every subset of size 1, then size 2, and so on until it has tested **all sets at the first successful size**. It reports the minimum size, up to three tied sets, the number of additional ties, and the number of subsets tested. A and B are labels, not verified chronology.

The test compares the complete answer object, including kind, private value internally, ordered citation IDs, and ambiguous-name candidates. It shows **only source IDs, counts, and fixed explanatory text**. Question receipts, scoped excerpts, and multi-answer briefs use their existing deterministic answer rules. A full receipt can become `DIFFER` because its exact snapshot changed even when its computed answer is unchanged; the display states that explicitly. A malformed or failed receipt receives no witness.

The bound is six added sources and at most 63 nonempty subsets per receipt. If the computed answer differs and a shared source was edited, removed, or reordered, or more than six sources were added, the tool says **unavailable**. An unchanged computed answer is reported as such without searching. It does not show a partial search result. The pure-addition precondition ensures that filtering B by the empty set exactly reconstructs A's ordered records and filtering by all additions exactly reconstructs B's. Changes only to `next_source_id` do not affect the answer calculation, but may still affect checkpoint interpretation.

## Use and reproduce

In **Trace a verdict across two references**, select A, B, and the same receipts. Each successfully replayed card shows its answer-change test below the observed source and verdict changes. For the synthetic baseline A and conflict reference B, source #2 alone reproduces B's `conflict` answer for the excerpt and full receipt. The paired capture from the same page still pins the selected files and script; it stores verdicts, **not** the witness sets. Reopen its matching page version and originals to recompute this view.

From this checkout, Node and an independently written Python implementation produce the same bounded explanation. Both commands below exit 0 because they reproduce the paired capture, although B has two `DIFFER` verdicts:

```bash
node tools/audit-evidence-batch.cjs research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json research/example-evidence-receipt.json --checkpoint research/example-evidence-ledger-checkpoint.json --reference-b research/example-evidence-reference-conflict.json --check-transition research/example-evidence-reference-transition-capture.json --explain-additions
python3 tools/independent-evidence-batch.py research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json research/example-evidence-receipt.json --checkpoint research/example-evidence-ledger-checkpoint.json --reference-b research/example-evidence-reference-conflict.json --check-transition research/example-evidence-reference-transition-capture.json --explain-additions
```

Add `--json` for a machine-readable `{transition, answer_influence}` object. Without `--explain-additions`, the original JSON transition format stays unchanged. The CLI checks that separately reread reference and receipt bytes still match the just-computed audit before printing an explanation. The browser recomputes in memory from the selected files and clears stale results on selection changes. Both routes check optional checkpoints before receipt analysis.

Tests cover one sufficient source, a pair where neither source alone reproduces B, tied minimum sets, a changed full snapshot with an unchanged answer, edits, deletions, reorders, the six-source limit, a multi-answer brief, malformed receipts, privacy of displayed output, and Node/Python agreement. The [reference transition protocol](reference-transition-protocol.md) explains verdict scope; the [portable transition capture](portable-transition-capture.md) explains byte and code binding.

## Trust and prior art

This is an exact minimum **within this declared six-source addition-only search space**. It is not a causal claim about people, the real world, independent evidence, time, or factual truth. Several equally small sets can work, and the first three are only a display bound; the total tie count remains visible. It does not verify that the supplied A reference was complete or that any assertion was independently held. Private facts are not displayed, but the existing capture hashes may allow guesses about predictable facts.

Prior art to investigate includes Zeller and Hildebrandt's [delta debugging](https://www.st.cs.uni-saarland.de/papers/tse2002/) for simplifying failure-inducing inputs and Wachter, Mittelstadt, and Russell's [counterfactual explanations](https://arxiv.org/abs/1711.00399). Our bounded deterministic subset test may be useful in this evidence workflow, but no novelty, patentability, commercial demand, or user comprehension has been established. Next research should test whether reviewers distinguish an answer witness from a verdict witness and whether a separately held checkpoint changes their interpretation.
