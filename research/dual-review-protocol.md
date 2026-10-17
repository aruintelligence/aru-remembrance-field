# Dual-auditor review result

## Problem and mechanism

A saved capture can reproduce exactly while containing `DIFFER` or `FAIL` receipt rows. Node and the separately implemented Python auditor already replay the same original files, but a recipient had to run both and reconcile their outputs. The reviewer command runs both locally, requires both to accept the capture, compares their computed outcomes, and emits a small result that keeps **capture replay** and **receipt assessment** separate.

It now also compares normalization of the selected, parseable fact keys, questions, and brief names under the Node and Python installations. A mismatch withholds the positive result for older captures even if both individual audits returned `MATCH`; new captures require both auditors to reproduce the originating browser's selected-name profile. The [runtime portability example](runtime-portability-gate.md) reproduces that case and explains why a script hash cannot pin the original browser's Unicode runtime.

This is a reviewer aid and a developer interface. It does not make the two programs independently operated, establish that their shared rules are correct, or create a signature. The user controls the supplied files, checker code, and runtime. A matching checkpoint only checks the selected checkpoint against its selected reference; its earlier independent preservation cannot be inferred from the file.

## Use it

Requires Node.js 22+ and Python 3.12+. From this checkout or a matching offline verifier kit, supply one reference, 1–20 ordered original receipts, and **exactly one** saved capture option. For the included transition example:

```bash
node tools/review-evidence.cjs research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json research/example-evidence-receipt.json --checkpoint research/example-evidence-ledger-checkpoint.json --reference-b research/example-evidence-reference-conflict.json --check-transition research/example-evidence-reference-transition-capture.json --json
```

The sample returns exit 0 and a JSON result containing `replay: "MATCH"`, `auditors: {node: "matched", python: "matched"}`, `receipt_assessment: {a: "all_receipts_match", b: "recorded_differences"}`, A totals `2 MATCH, 0 DIFFER, 0 FAIL`, B totals `0 MATCH, 2 DIFFER, 0 FAIL`, and changed positions `[1, 2]`. Omit `--json` for a short human-readable version. The SHA-256 in `capture_sha256` identifies the exact saved capture bytes reviewed; it is not a signature or proof of who supplied the capture.

For a single audit, use `--check-capture capture.json` and one reference. For a private pair, use `--reference-b reference-b.json --check-sealed private-capture.json --opening-key opening-key.json`, with optional `--checkpoint` and `--checkpoint-b`. Transfer the opening key only to the intended verifier by a separate private channel. The command does not copy the key or originals into the result. It also accepts legacy v1 single captures, labeling `script_binding: "unavailable_legacy_v1"`; these cannot pin the browser script.

The result format `aru-evidence-review-result` version 1 has:

| Field | Interpretation |
| --- | --- |
| `capture_sha256`, `capture_kind` | Exact saved capture bytes and batch, transition, or private transition mode. |
| `replay` | `MATCH` only after **both** auditors accepted and their computed outcomes agreed; otherwise `UNCONFIRMED`. |
| `receipt_assessment`, `totals` | Recorded `MATCH`, `DIFFER`, and `FAIL` outcomes, separately for A and B when paired. `FAIL` takes precedence in the assessment. |
| `script_binding` | `matched` for supported captures; `unavailable_legacy_v1` for old single captures without a script fingerprint. |
| `changed_receipt_positions` | Paired positions whose verdict changed; the selected order is significant. |
| `checkpoint_selection` | Whether a matching checkpoint was supplied per side. It says nothing about who preserved it or when. |
| `selected_name_normalization` | `node_python_match` only for selected, bounded, parseable strings under the current two runtimes. |
| `browser_runtime_normalization` | `selected_profile_matched` for a new capture whose selected-name profile both auditors reproduced; `not_recorded_in_capture` for an older capture. Neither identifies all browser Unicode tables. |
| `not_established` | Authorship, independent custody, completeness, and factual truth remain unverified. |

On a failed replay the JSON result contains `UNCONFIRMED` and a bounded reason such as `auditor_rejected`, `auditor_disagreement`, `capture_changed`, `inputs_changed`, `normalization_disagreement`, or `normalization_check_failed`; it has **no totals or assessment**. Exit status is 1. Invalid arguments or malformed capture input fail before a result. The command does not print the child auditors' error output, which might contain paths. It prints no assertion names, values, filenames, raw evidence hashes, or opening key. Counts and the capture hash may still reveal information about a case. Review the saved capture itself before sharing it; ordinary captures contain raw file hashes that may permit guessing predictable private assertions.

This checks that each auditor computed the same report from the supplied files and independently accepted the saved capture. It reads the capture before and after both runs and refuses a changed capture. It now also snapshots the original files and compares their bytes after the auditor runs and compatibility check. This reduces concurrent-mutation risk, but the two processes still do not receive an atomic filesystem snapshot; a temporary swap and restoration could escape this check. Run against stable, separately held copies if independent custody matters. A compromised installation can replace both checkers or this wrapper; a self-consistent offline kit manifest does not authenticate its distributor.

## Reproduce boundaries

Run `node --test tests/dual-review.test.cjs tests/verifier-kit.test.cjs`. The tests cover ordinary, paired, private, legacy, recorded `FAIL`, swapped or missing originals, altered capture or script fingerprint, wrong key, ambiguous JSON, malformed inputs, and a deliberately disagreeing checker. The committed ordinary and paired fixtures can be independently replayed by the two underlying tools in `README.md`. A `MATCH` on the included paired fixture still records two B-side `DIFFER` rows; this is the false-confidence counterexample.

## Invention log and next proof

**Problem:** A matching capture can be misread as all evidence passing, and separate tool outputs are awkward to integrate.

**Proposed mechanism:** A bounded, capture-byte-bound decision envelope over two implementations, with separate replay and receipt states and a fail-closed disagreement path.

**Prior art to investigate:** software supply-chain provenance (including in-toto and SLSA), reproducible builds, multi-implementation differential testing, and evidence-chain tools. This implementation claims no signature, independent custody, novelty, or patentability.

**Unproven:** whether external reviewers understand the distinction, whether the two implementations share undetected semantic defects, whether the original evidence set is complete, and whether independently obtained references support the facts. The next useful study is a blind reviewer task using a matching capture that contains `FAIL`, with comprehension measured before and after the new result format.
