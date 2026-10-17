# Runtime portability gate for evidence review

## Why this matters

The browser script hash identifies source code; it does not identify the browser's Unicode tables. This matters for `normalizeFactKey`, which uses the JavaScript runtime's NFKC and lowercase behavior. The independent Python checker uses its runtime's Unicode data. On the tested environment, Node 24 reports Unicode 17.0 and Python 3.12 reports Unicode 15.0.0. For U+A7F1, Node normalizes the character to `s`, while Python retains the original character.

The included [synthetic reference](example-runtime-reference.json), [receipt](example-runtime-receipt.json), and [saved capture](example-runtime-capture.json) each contain a key and question using U+A7F1. Both underlying auditors return one `MATCH` under the tested runtimes: each is self-consistent with that same supplied key. Before the gate, the combined reviewer also returned `replay: "MATCH"` and `all_receipts_match`, even though the two programs interpreted the selected name differently. A different record named `s` could change the browser's answer if it were supplied. The files do not establish that such a record exists or was omitted; this is a semantic portability counterexample, not a factual claim.

## What changed

The reviewer takes bounded byte snapshots of its selected references, receipts, checkpoints, and private opening key before running the auditors. It checks the originals again after both runs and after its compatibility check. It compares every parseable, bounded fact key, question, and brief name selected from the references and receipts under the **live Node evidence function** and the separately executed Python auditor's normalizer. A mismatch returns `UNCONFIRMED` with `reason: "normalization_disagreement"` and no receipt assessment, even if both underlying capture checks accepted. Changed input bytes return `inputs_changed`. An unavailable or malformed probe returns `normalization_check_failed`, also without a positive assessment. No names or normalization outputs are put in the review result.

On `MATCH`, `selected_name_normalization: "node_python_match"` describes the compared selected strings, while `browser_runtime_normalization: "not_recorded_in_capture"` states the remaining limit. Parseable but malformed receipts can be recorded `FAIL`; names beyond the verifier's field bounds are not included in this selected-string check. An older capture remains replayable and is still explicitly labeled as lacking a script fingerprint. A matching capture can contain recorded `DIFFER` or `FAIL` rows. Inspect the assessment and totals separately.

This gate does **not** reconstruct the original browser runtime, prove full Unicode equivalence, validate omitted evidence, or establish authorship, custody, completeness, or truth. Node and Python on a different pair of Unicode versions may agree on U+A7F1; the test adapts to their actual behavior. A prior offline kit retains its earlier reviewer code. The new result format remains version 1 with additive fields on `MATCH` and new bounded failure reasons.

## Reproduce the result

From a current checkout with Node.js and Python 3.12:

```bash
node -p 'process.versions.unicode'
python3 -c 'import unicodedata; print(unicodedata.unidata_version)'
node tools/audit-evidence-batch.cjs research/example-runtime-reference.json research/example-runtime-receipt.json --check-capture research/example-runtime-capture.json --json
python3 tools/independent-evidence-batch.py research/example-runtime-reference.json research/example-runtime-receipt.json --check-capture research/example-runtime-capture.json --json
node tools/review-evidence.cjs research/example-runtime-reference.json research/example-runtime-receipt.json --check-capture research/example-runtime-capture.json --json
```

Observed here: Node `17.0`, Python `15.0.0`, each individual audit exited 0 with one `MATCH`; the new review exited 1 with `UNCONFIRMED / normalization_disagreement`. With `main` at commit `7073960005e65b040c690e61c89b593c750c9ccb`, the old reviewer exited 0 and reported `MATCH / all_receipts_match` on exactly the same three files. With full Git history, you can compare the old wrapper without changing the working checker:

```bash
git show 7073960005e65b040c690e61c89b593c750c9ccb:tools/review-evidence.cjs > tools/review-evidence-before.cjs
node tools/review-evidence-before.cjs research/example-runtime-reference.json research/example-runtime-receipt.json --check-capture research/example-runtime-capture.json --json
```

Remove that temporary `tools/review-evidence-before.cjs` after the comparison. The underlying auditors and the original files are otherwise unchanged. On a Node runtime whose normalization of U+A7F1 matches Python's, the new reviewer can return `MATCH`, with `browser_runtime_normalization: "not_recorded_in_capture"` still explicit.

Challenge the broader source-competition path separately:

```bash
node tools/challenge-multisource-evidence.cjs --seed 20261017 --runs 500 --json
node --test tests/runtime-portability.test.cjs
node --test tests/*.test.cjs
```

The seeded challenge runs 21 fixed controls and generated cases against the live browser answer functions and independent Python. It covers empty, unsupported, missing, known, historical, conflicting, ambiguous, and invalid record sets, including multi-record order and brief results. The first disagreement includes the complete synthetic records, query, both outputs, seed, and code hashes. It makes no user-data read or network request. Exit 0 means only that the cases it ran agreed; exit 1 means a counterexample, and exit 2 means the challenge could not complete. CI runs the documented 500-case seed. The focused tests also inject a faulty probe and mutate an original file during review to require `UNCONFIRMED`.

## Invention log and next proof

**Problem:** two auditors can both reproduce a capture while assigning different canonical names to the same evidence string, because the capture pins code but not runtime Unicode behavior.

**Mechanism:** a selected-string runtime compatibility gate inside the dual review, with no sensitive strings in its result and with original byte snapshots around the check. A separate source-competition challenge tests answer branches and records the first synthetic discrepancy.

**Prior art to investigate:** Unicode normalization versioning and stability, confusable-identifier defenses, reproducible execution environments, differential testing, and evidence provenance tools. No novelty or patentability claim is made.

**Unproven:** the Unicode runtime and normalization semantics of the browser that originally created a capture; equivalence for all possible strings or complete receipts; independent custody and factual truth. The next high-value protocol change is to pin a small, versioned normalization profile in a future capture and enforce it in the browser and both offline checkers, while keeping legacy captures explicitly unbound. That needs compatibility research and migration tests before changing the capture format.
