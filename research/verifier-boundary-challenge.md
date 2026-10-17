# Verifier boundary challenge

## Problem and finding

The browser and the independent Python auditor both compute answers, but using each language's default definition of whitespace created incompatible evidence rules. Before this change, a synthetic record named `city\u0085hall` and the question `What is city hall?` produced a browser `missing` answer: U+0085 is part of the name, rather than a space. The Python checker collapsed U+0085 as whitespace, computed `known`, and marked the browser's receipt `FAIL`. A carriage return in `What is my\rcity hall?` produced the reverse kind of risk: the browser refused the question as `unsupported`, while Python's old `.` regex matched across the carriage return and returned a cited `known` answer. Neither result is a finding about the real world; they are disagreements about deterministic software behavior.

Python now uses the browser rules' explicit whitespace set for trimming and `\s`, excludes the browser's four line terminators from the question capture, and uses ASCII letter pairs for this grammar instead of Python's broader case-insensitive matching. The browser script and the receipt format are unchanged. Older offline kits keep their original Python checker and may disagree on these inputs; preserve the kit version when reviewing an old decision.

## Use the challenge

Requires Node.js 22+ and Python 3.12+, with no package installation or network. From the repository root:

```bash
node tools/challenge-verifier-boundaries.cjs --seed 20261017 --runs 400 --json
node tools/review-evidence.cjs research/example-boundary-reference.json research/example-boundary-receipt.json --check-capture research/example-boundary-capture.json --json
```

The first command reads the **live** browser evidence functions from `index.html` and compares record validity and the computed answer against a separate Python process. It runs all 201 fixed cases first (33 whitespace/near-whitespace code points across six contexts, plus three case-folding grammar controls), then seeded variants. It reports the seed, case count, browser model hash, Python auditor hash, probe hash, and first full synthetic counterexample. Exit 0 means no disagreement **within those cases**; exit 1 means a disagreement, and exit 2 means the challenge could not run. `--runs` accepts 1–2000; `--seed` accepts an unsigned 32-bit integer. The command only generates synthetic records in memory and sends them to the local Python process. Save `--json` output if a particular run needs to be reviewed later.

The second command replays the three public synthetic files through the actual batch paths. Expected output: `replay: "MATCH"`, both auditors `matched`, `receipt_assessment: "all_receipts_match"`, and one `MATCH` in `totals`. The source value is explicitly a synthetic example. The audit says that these files and rules agree. It does not prove the assertion true, authenticate who made it, establish independent custody, or establish that the reference includes every relevant record.

## Reproduce the before and after

The previous checker is available at the earlier main commit `080e1664b2440e7c1ee37ef745304d380df40e7e`. With full Git history, compare it against this checkout without replacing the working checker:

```bash
mkdir -p /tmp/aru-boundary-before/tools
git show 080e1664b2440e7c1ee37ef745304d380df40e7e:tools/independent-evidence-batch.py > /tmp/aru-boundary-before/tools/independent-evidence-batch.py
git show 080e1664b2440e7c1ee37ef745304d380df40e7e:index.html > /tmp/aru-boundary-before/index.html
python3 /tmp/aru-boundary-before/tools/independent-evidence-batch.py research/example-boundary-reference.json research/example-boundary-receipt.json --json
python3 tools/independent-evidence-batch.py research/example-boundary-reference.json research/example-boundary-receipt.json --check-capture research/example-boundary-capture.json --json
```

Observed before: the old command exited 1, with the one receipt `FAIL` and reason `replay-failed`. Observed after: the current command exited 0 with one `MATCH`, reproducing the saved capture. The bounded challenge against the old auditor's probe found its **first** disagreement at case 28, U+000D in the possessive question: browser `unsupported`, old Python `known`. Against the corrected checker, seed `20261017` completed 400/400 with no disagreement; seeds `1` and `4294967295` each completed 2000/2000. These are regression observations, not a proof of equivalence for all Unicode, all receipts, or all environments.

```bash
node --test tests/verifier-boundaries.test.cjs
node --test tests/*.test.cjs
```

The focused tests also inject a faulty Python probe and require a first counterexample, then replay a saved capture with tampering, reordered files, changed script fingerprint, a legacy capture, and malformed input. The larger suite includes prior reference, checkpoint, privacy, and transition checks. A matching **legacy** capture labels its missing browser fingerprint; no subsequent run can restore a fingerprint the old file never contained. A capture can match while recording `DIFFER` or `FAIL` rows, so inspect `receipt_assessment` and totals before interpreting it.

## Invention log and next proof

**Problem:** agreement between two implementations on hand-selected examples can hide a boundary where one returns a cited answer and the other refuses it.

**Mechanism:** extract the live browser's answer model; generate deterministic language-boundary probes; compare against separately executed Python; stop with the first full synthetic witness and exact code hashes. Keep a public saved-capture fixture for the real reviewer path.

**Prior art to investigate:** differential testing, grammar-based fuzzing, Unicode and ECMAScript whitespace conformance suites, and cross-runtime parsing/security case studies. This implementation makes no novelty or patentability claim.

**Unproven:** broad semantic equivalence, third-party independence, user comprehension, correct real-world assertions, and custody of evidence. The later [runtime portability gate and multi-source challenge](runtime-portability-gate.md) cover competing records and expose an unpinned Unicode runtime. A high-value next step is a reviewer study using paired same-data/changed-data captures and a clear acceptance question; measure whether people distinguish capture consistency from factual support. Whole receipt structures and independently curated cases still need broader differential testing rather than treating a larger random count as certainty.
