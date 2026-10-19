# Reviewer judgment lab — protocol and invention record

## The system and the gap

The Remembrance Field is a browser simulation with a local evidence ledger. People can export sourced answer receipts, compare them with a separately selected reference and checkpoint, save a bounded batch capture, replay it in the page, and run Node and independently written Python auditors. Paired transitions show which receipt verdict changed and which additions suffice to reproduce a changed answer or verdict. The offline kit preserves the exact page and checking tools. This is useful for a person sharing a recorded claim and a reviewer trying to understand what the supplied files and rules actually establish.

The browser ledger, selected reference, checkpoint, receipt files, browser script, independent auditor, and person interpreting an output are distinct boundaries. The strongest existing work is byte-bound replay, explicit `MATCH`/`DIFFER`/`FAIL` rows, counterexamples to misleading consistency, and two implementations that withhold a positive combined review when they disagree. The three consequential limits are: (1) selected assertions can be false, incomplete, or selectively omitted; (2) a matching hash or checkpoint supplied alongside a file says nothing by itself about authorship, age, or independent custody; (3) a correct software result can still be misread as a factual endorsement. This lab targets the third limit. It does not solve the first two.

## Mechanism and use

Open **Verify a shared answer receipt → Reviewer judgment** in the existing page. Start or restart, read one synthetic summary at a time, choose a conclusion, then lock it. Five scenarios cover a clean replay, a matching capture that records `FAIL`, a paired transition with `DIFFER`, disagreeing checkers, and a matching checkpoint supplied alongside a reference. Scenario order is shuffled with WebCrypto when available; otherwise the fixed order is used. The choice labels and their option order are fixed. Answers and explanations remain hidden until the fifth locked choice. The end view shows the user's selected conclusion and the supported conclusion for every item.

This is an optional practice exercise. It never reads evidence files or local storage and does not send a network request. Its choices exist in page memory only until **Download choices JSON** is used; that button is enabled only if the browser can hash the exact inline script. The download contains the five scenario IDs and choices, score, order, reported ordering method, format revision, and browser script SHA-256. It contains no name, time, personal ledger, source text, or generated participant identifier. A holder can edit or copy it. The ordering method is a reported field, not a trusted record of randomization. Do not treat a report as consent, unique participation, a real person, or independent custody.

From the matching checkout or offline verifier kit, run:

```bash
node tools/verify-reviewer-judgment.cjs research/example-reviewer-judgment.json
node tools/analyze-reviewer-judgments.cjs --json research/example-reviewer-judgment.json
```

The checked-in report is **deliberately simulated**: four keyed choices out of five, with the `recorded_fail` answer set to the misleading “every receipt passed” option. It is a parser and scoring fixture, not an observed reviewer. The standalone verifier requires exactly five known scenarios once each, choices aligned with their recorded order, an exact fixed order when WebCrypto was unavailable, the keyed score, and the current page script fingerprint. It rejects malformed or duplicate-name JSON and files over 1 MiB. A different page revision needs its own archived kit; changing the browser script invalidates a current-code report even if the exercise text did not change. The verifier's key is separately encoded, but the report and the page are both public and forgeable. `PASS` means the bytes fit this scoring rule.

The analyzer accepts 1–100 locally held reports, verifies each first, then counts choices by scenario, keyed decisions, exact byte copies, and reports *claiming* a WebCrypto shuffle. Counts are **files**, not people. An exact copy flag cannot distinguish a repeated export from coincidentally identical choices; no copy flag does not establish unique respondents. Local holders decide whether and how to share reports. The analyzer's JSON output is for review and future integration, not a human study result.

## Reproducible false-confidence case

The [synthetic unsupported receipt](example-judgment-fail-receipt.json) and [saved capture](example-judgment-fail-capture.json) use the same [reference](example-evidence-reference-baseline.json) and [valid excerpt](example-evidence-excerpt.json) as other project examples. Run:

```bash
node tools/review-evidence.cjs research/example-evidence-reference-baseline.json research/example-evidence-excerpt.json research/example-judgment-fail-receipt.json --check-capture research/example-judgment-fail-capture.json --json
```

The reproducible result is `replay: "MATCH"`, `receipt_assessment: "recorded_failures"`, and totals of one `MATCH`, zero `DIFFER`, and one `FAIL`. The replay agrees with the recorded failure; it does not turn that failed receipt into a passing one. Previously the tools exposed this distinction, but the page had no private decision exercise with delayed feedback or code-bound choice export to test whether a reviewer noticed it. Now the second prompt directly tests that distinction. This example is synthetic and says nothing about real reviewer behavior.

## Checks, limits, and next experiment

The browser tests exercise all five choices, a four-of-five debrief, no local-storage writes, no report before completion, restart, and the no-hashing path. Node tests reject a changed score, script fingerprint, revision, schema, choice, order, incomplete report, malformed JSON, and duplicate JSON names; they count exact file copies and reject an invalid batch member. The archived kit test runs the scorer and analyzer outside the repository. The counterexample test asserts both `MATCH` replay and a `recorded_failures` assessment. Existing batch and independent checker tests continue to check changed, missing, reordered, and legacy captures separately; a scored practice report itself is never an audit capture.

For an actual comprehension study, specify recruitment, consent, a sampling frame, a preregistered primary measure, a balanced comparison interface, and accessibility review **before** collecting reports. Give each participant equivalent scenarios with and without the explanatory view, counterbalance order, preserve raw answers with permission, and report denominators, exclusions, and uncertainty. The current five-item practice key and optional editable exports are insufficient for causal claims; they can also teach answers on repeat attempts. No human data were collected here.

**Invention log.** Problem: correct audit tooling can produce false confidence when a reader confuses replay with receipt validity or factual truth. Proposed mechanism: a private, delayed-feedback interpretation exercise with a small code-bound portable report and strict file-level aggregation, anchored to an actual `MATCH` plus `FAIL` counterexample. Prior art to investigate: human comprehension tests for explainable AI and security warnings, adversarial evaluation of provenance interfaces, and evidence review training tools. What remains unproven: improvement in human decisions, representativeness of these five prompts, real deployment demand, source authenticity, independent custody, completeness, and underlying truth. No novelty or patentability claim has been established.

After a consented study demonstrates value, the next integration would be a versioned developer endpoint for submitting *opt-in* reports with a separately managed participant token and rate controls. Its design must solve consent, duplicate submissions, retention, and code provenance first. No endpoint or participant identity is present in this release.
