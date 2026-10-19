# Independent source review — reproduce the entire removal map

## Problem and mechanism

The in-page source-removal probe shows how each supplied reference record affects each selected receipt's verdict and computed answer/citations. Its explanation was originally produced only by the browser's own rules. A reviewer needs a separate implementation that can detect disagreements rather than simply repeating a browser result.

`tools/review-source-probe.cjs` takes the original reference, 1–20 ordered receipts, an optional checkpoint, and an optional saved single-reference batch capture. It rejects nonregular files and the existing 1 MiB per-file / 4 MiB combined receipt limits. It reads the originals into a private temporary directory, with restrictive file permissions, and runs both the Node auditor and `tools/independent-source-probe.py` on that fixed snapshot. The Python probe uses the separately written evidence rules in `tools/independent-evidence-batch.py`, not the JavaScript answer resolver. Each implementation replays the receipt first, then withholds one supplied source at a time, retaining remaining IDs and order. For every valid receipt it returns each source ID's resulting `MATCH` or `DIFFER` and whether the computed answer or citations changed. A `FAIL` receipt is labeled skipped. The command deletes the temporary files afterward and refuses a positive result if a final reread finds that the originals changed. It cannot detect a file changed and restored between reads.

The combined command compares the exact selection hashes, receipt order and verdicts, selected-name normalization profile, browser script fingerprint, source IDs, and all probe rows. `assessment: "MATCH"` means the two software implementations agreed on **this selected snapshot**. A changed, rejected, or malformed checker returns `UNCONFIRMED` without an accepted map. When `--check-capture` is supplied, the existing dual-auditor capture reviewer must first return `MATCH`; a mismatch stops the source review. The command preserves the separate `receipt_assessment` field, so a matching capture and matching source map can still include `DIFFER` or `FAIL` receipts. Version 1 captures explicitly report an unavailable script binding; version 2 lacks the selected-name runtime profile.

## Reproduce

From the repository root:

```bash
node tools/review-source-probe.cjs research/example-evidence-reference-conflict.json research/example-evidence-excerpt.json --json
node tools/review-source-probe.cjs research/example-verdict-witness-reference-unrelated.json research/example-evidence-receipt.json --json
node tools/review-source-probe.cjs research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json research/example-evidence-receipt.json --checkpoint research/example-evidence-ledger-checkpoint.json --check-capture research/example-evidence-browser-batch-capture.json --json
node tests/source-probe.test.cjs
```

The first report has `assessment: "MATCH"`, `receipt_assessment: "recorded_differences"`, and source #2's removal changes the excerpt from `DIFFER` to `MATCH` with `answer_changed: true`. In the second, removing unrelated source #2 changes the full-snapshot verdict from `DIFFER` to `MATCH` while `answer_changed: false`. The third replays the script- and runtime-bound saved capture and checks the matching checkpoint before accepting the map. The first two do not check a saved capture and say `capture_replay: "not_checked"`. The test suite also checks a matching capture that records a `FAIL`; its failed receipt stays unprobed and `receipt_assessment` remains `recorded_failures`.

For a direct independent Python report, run:

```bash
python3 tools/independent-source-probe.py research/example-evidence-reference-conflict.json research/example-evidence-excerpt.json --json
```

The combined command's `source_map` should equal this Python report for the same selected files and compatible runtimes. A report embeds raw file SHA-256 hashes and an inline-browser script digest; review it before sharing because predictable private facts can sometimes be guessed from raw hashes. It omits fact names, values, questions, and filenames. Preserve the original files, matching repository revision, and tool code for later recomputation. The JSON itself is unsigned and editable; its hash fields do not establish who made or held the files.

## Failure and scope limits

The focused tests reject or withhold on a wrong checkpoint, altered capture/script fingerprint, reordered or modified receipt, malformed JSON, missing file, rejecting Python process, and a deliberately disagreeing Python result. They check that duplicate bytes remain flagged and an invalid receipt is skipped. The existing capture tests cover older v1/v2 behavior. A positive map covers individual removals only. It does not find outside evidence, establish independent custody or chronology, test every combination of missing sources, or prove a claim is true. The two implementations share a written rule contract and may share an error; this is a reproducibility check, not formal verification or a security guarantee. Operating system access to the selected files and temporary directory remains a trust assumption.

## Invention log and next evidence

- **Problem:** a browser-only explanation gives no independent confirmation of which supplied records drive a verdict.
- **Mechanism:** two language implementations recompute a bounded, value-hidden removal map from identical input bytes; disagreement withholds the map, while a capture replay and receipt outcomes remain distinct.
- **Prior art to investigate:** database lineage, leave-one-out sensitivity, reproducible builds, independent execution, and counterfactual explanations. No patentability or novelty claim has been reviewed.
- **Unproven:** reviewer comprehension, use on real evidence, source completeness, custody, truth, and market demand.

The next highest-value proof is a consented, preregistered reviewer study using the synthetic conflict and verdict-only cases to measure interpretation errors. That would assess people; these software tests do not.
