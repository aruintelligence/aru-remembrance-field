# Review Desk — guided evidence decision path

## Problem and mechanism

The existing Remembrance Field combines a visual memory simulation with a substantial local evidence system. A reviewer can select a reference ledger, optional separately preserved checkpoint, and 1–20 ordered answer receipts; replay saved captures in the browser; and run Node and independent Python auditors outside it. Strong prior work checks selected bytes, replay rules, duplicate inputs, normalization, changed verifier code, and explicit receipt outcomes. However, the live page placed those controls inside a long technical panel, with the reference selector far from the audit controls. A new reviewer could miss that `CAPTURE MATCH` may include `DIFFER` or `FAIL` receipt rows.

The **Review Desk** is a short entry point in that existing page. The top button opens and focuses a three-gate view. Gate 1 shows whether a reference, ordered receipt set, and optional checkpoint are selected and offers direct jumps to the original file inputs. Gate 2 runs the existing browser audit, presents its `MATCH`/`DIFFER`/`FAIL` totals and identical-byte repeats, and links to the detailed per-receipt table. Gate 3 offers capture download or comparison using the existing bounded capture path. It reports a saved capture replay separately, labels unsupported or mismatched captures `UNCONFIRMED`, and identifies legacy v1/v2 missing bindings. The desk clears earlier assessments on any change to the selected reference, checkpoint, receipt order, or saved capture. It uses the original verifier functions and never copies personal fact values into its summary.

Each gate is keyboard reachable, has a text status and clear focus treatment, and uses a single-column layout when a phone is narrow. The expanded evidence panel now has more vertical space. The same work remains possible through the detailed controls below the desk. There is no network submission or automatic evidence import.

## Try and reproduce

In the page, select **Review evidence files**. Under **Supplied files**, choose [the baseline reference](example-evidence-reference-baseline.json), then select [the valid excerpt](example-evidence-excerpt.json) followed by [the synthetic unsupported receipt](example-judgment-fail-receipt.json). Optionally select [the matching checkpoint](example-evidence-ledger-checkpoint.json) if it was kept independently for this demonstration. Select **Audit selected files**. The outcomes gate reads **1 MATCH, 0 DIFFER, 1 FAIL** and points to the failed row; a failed receipt does not become a pass because the capture can reproduce it. Download the new capture, select that saved file under **Choose capture**, and compare. The capture gate says `CAPTURE MATCH` while the outcome gate still says `1 FAIL`.

For a checked-in capture without the optional checkpoint, the same distinction is reproducible outside the page:

```bash
node tools/review-evidence.cjs research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json research/example-judgment-fail-receipt.json --check-capture research/example-judgment-fail-capture.json --json
```

The result is `replay: "MATCH"`, `receipt_assessment: "recorded_failures"`, and totals of one `MATCH`, zero `DIFFER`, one `FAIL`. Before this change the underlying result and batch table existed, but the page had no immediate three-gate explanation at the entry point; now the same files produce distinct, adjacent outcome and replay statuses. This is a software and interface demonstration, not evidence that a real reviewer interprets it correctly.

## Trust boundaries and negative cases

The selected reference and checkpoint are bytes supplied by the user. Their agreement cannot establish that the checkpoint was independently held earlier. A saved capture binds a script fingerprint and, in current version 3, selected-name runtime interpretation; neither binds the publisher, a witness, a full historical runtime, or missing evidence. A replaying capture can contain failed or differing receipts. An individual `MATCH` checks the supplied reference under these rules, not the assertion's factual truth. A hash does not establish authorship or custody. The desk's permanent limit row states those boundaries.

The browser tests prove the UI's behavior on a matching capture with a failed receipt; a changed script fingerprint producing `UNCONFIRMED`; file reselection clearing all previous gate results; a mismatching checkpoint stopping the audit before any receipt is assessed; and an environment without secure hashing retaining outcome visibility while withholding a capture. Existing tests exercise missing and reordered files, changed rules and scripts, malformed JSON and ambiguous names, stale asynchronous reads, and legacy capture modes. Node and independent Python tests replay the same stored examples. None establishes factual truth or security against a malicious browser or installation.

## Invention log and next proof

**Problem:** technically accurate audit controls can still prompt false confidence if a reviewer treats capture replay as approval of all receipts. **Mechanism:** a three-gate review surface whose state derives from the existing auditor and is invalidated by input changes, with fixed trust limits beside the result. **Prior art to investigate:** evidence review dashboards, chain-of-custody interfaces, safety-case argument structures, and layered security warning design. No novelty or patentability search has been completed. **Unproven:** whether this arrangement improves real reviewer decisions, real-world data completeness, authorship, independent custody, commercial demand, and factual truth.

The next high-value proof is a consented, preregistered comprehension comparison between the earlier detailed panel and the guided desk using the same adversarial capture. The existing optional judgment exercise can provide practice prompts and editable local reports, but it is not itself a controlled human study. Any shared or aggregated data needs explicit consent, retention rules, and safeguards against duplicate responses before collection.
