# Challenge the evidence answer boundary

This is an executable check of the **exact-name evidence recall** feature. It runs the same `normalizeFactKey`, `validFactClaim`, `lookupFact`, and `resolveEvidenceQuestion` functions used by `index.html` against labeled cases. It does not use a language model, look facts up on the internet, or verify that a user's assertions are true.

Run the included synthetic example with Node.js 22 or later:

```bash
node tools/benchmark-evidence.cjs research/evidence-challenge.json
node tools/benchmark-evidence.cjs --json research/evidence-challenge.json
```

The committed example has 12 cases: four expected answers and eight expected abstentions. The runner prints each case and a scorecard. It exits `0` if every case matches, `1` if any answer or abstention differs, and `2` for invalid input or a runtime error. `--json` writes a report to standard output for independent inspection. Both the challenge file and the extracted model code have SHA-256 hashes in that report, so a published score can identify the exact inputs and rules used.

## Bring an independent challenge

Copy `research/evidence-challenge.json` to a new file and replace its cases. A case supplies a fresh ledger, a question, and an expected result:

```json
{
  "format": "aru-evidence-benchmark",
  "version": 1,
  "title": "Independent recall challenge",
  "cases": [
    {
      "id": "favorite-color",
      "claims": [
        {"id": 7, "key": "favorite color", "value": "teal", "time": 1700000000000, "status": "active"}
      ],
      "question": "What is my favorite color?",
      "expected": {"kind": "known", "value": "teal", "sources": [7]}
    }
  ]
}
```

For an expected refusal, use `{"kind":"missing"}`, `unsupported`, `ambiguous`, `historical`, `conflict`, or `empty` as appropriate. A known answer requires its **exact value and all current source IDs**; source order does not matter. The case's `claims` follow the evidence ledger's record shape: positive unique integer `id`, nonempty `key` and `value`, millisecond `time`, and `status` of `active` or `superseded`. Each case is isolated from all others. IDs must be unique within a case and case IDs must be unique across the file. The runner checks the app's record limits, rejects malformed labels, and caps the file at 1 MiB, 100 cases, and 100 claims per case. Questions up to 500 characters are allowed so the app's 200-character rejection can be challenged.

The scorecard reports:

| Metric | Meaning |
| --- | --- |
| Exact cases | Expected kind matches; for `known`, value and complete source set match too. |
| Correct answers | Exact matches among cases labeled `known`. |
| Correct abstentions | Exact refusal kind among cases labeled with a refusal. |
| Unexpected abstentions | A refusal on a case labeled `known`. |
| Unsafe answers | An answer when a refusal was expected, or a known answer with a wrong value or source set. |

Other wrong refusal kinds fail the exact case count even though they do not count as unsafe answers. The JSON report includes `expected`, `actual`, and `correct` for each case. A response that cites a missing or extra source counts as unsafe even when its value is right.

For a useful outside test, write cases and labels **before** inspecting the runner's output. Include tempting unsupported phrasings, conflicting active entries, superseded-only names, near matches, and ambiguous `my …` names. Publish the challenge and report hashes with the case count; do not report only a percentage. If the cases contain personal facts, keep the file and JSON report private: both contain their values.

The included example and CI gate establish reproducible behavior on hand-authored synthetic cases. Passing them is not proof of independent factual accuracy, general question answering, or the project's broader field theory. Independent labels can be wrong, and the benchmark does not authenticate who authored them. The hashes identify bytes; they are not signatures or evidence that a challenge was held out.
