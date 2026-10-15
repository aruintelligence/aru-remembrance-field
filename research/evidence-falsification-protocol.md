# Seeded evidence falsification lab

The evidence question resolver has a narrow contract: exact normalized names, source citations, and refusal when a single supported answer is unavailable. This lab tries to **break that contract** with many generated ledgers and questions. It runs the same resolver source used by `index.html`, with no browser storage or personal data.

```bash
node tools/falsify-evidence.cjs --seed 20261015 --runs 2000
node tools/falsify-evidence.cjs --seed 20261015 --runs 2000 --json
```

The fixed CI seed currently runs 2,000 generated cases and 26,000 property checks. Each generated case uses 1–4 active assertions with varied names, Unicode compatibility forms, spacing, source IDs, values, timestamps, and import flags. Thirteen checks then probe these relationships:

| Check | Required behavior |
| --- | --- |
| Complete sources | An answer cites every agreeing active source. |
| Unicode question | Fullwidth and case variants still find the exact normalized name. |
| Permutation | Reordering the ledger leaves the value and source set unchanged. |
| Irrelevant record | Another name cannot change the answer. |
| Agreeing source | A new matching assertion joins the citation set. |
| Conflict | A divergent active value forces a refusal. |
| Historical | Superseded-only records cannot produce an answer. |
| Selected source | One active record wins only after the others are superseded. |
| Possessive ambiguity | Both `name` and `my name` present force a refusal for `What is my name?`. |
| Unknown and near names | No value is fabricated for absent exact names. |
| Unsupported grammar | An unrecognized question cannot receive a value. |
| Length limit | A question over 200 characters is refused. |

Every resolver call also checks that it did not mutate the supplied records. Refusals must not contain an answer value. A failed check stops the run, exits with code `1`, and prints the seed, zero-based case index, property, question, claims, expected result, and actual result. The JSON mode makes the counterexample easy to preserve. Exit `0` means no failure was found; invalid options exit `2`.

To reproduce a failure, run the same seed and at least `case_index + 1` cases against the same code revision. The report records a SHA-256 hash of the extracted question code. The generator name `mulberry32-v1` identifies the deterministic sequence. Choose other unsigned 32-bit seeds and 1–10,000 cases to seek different counterexamples; keep the seed and report when discussing a finding.

This is a **metamorphic regression check**, not a random sample of real user questions. It exercises the listed relationships on a deliberately small family of synthetic names and values. A passing run does not prove factual truth, general language understanding, absence of all bugs, statistical accuracy, or the broader field theory. The checked code and the generated expectations share the written contract, so an omitted or mistaken contract can escape both. Independent labeled challenges and manual probes remain useful.
