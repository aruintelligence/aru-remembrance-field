# Multi-fact evidence brief

## Defined behavior

In **Evidence memory**, enter 2–8 exact fact names, one per line, and select **Build evidence brief**. Each row independently checks the local ledger and shows either a value with all current source IDs or an explicit refusal: `missing`, `historical` (only superseded sources), or `conflict` (different active values). Names are matched by Unicode NFKC, lowercasing, and whitespace collapse. Duplicate normalized names are rejected, including compatibility variants. The brief does not infer synonyms, facts from conversation text, or whether an assertion is true. It does not alter the ledger, score, or messages.

The [public synthetic receipt](example-evidence-brief.json) requests four names. `favorite color` is `teal` with sources #1 and #2; `city` refuses because #3 and #4 conflict; `plan` refuses because #5 is superseded; `pet` is missing. Source #6 is unrelated and illustrates why a full-snapshot receipt needs privacy review. Run:

```bash
node tools/verify-evidence-receipt.cjs research/example-evidence-brief.json
python3 tools/differential-brief.py --seed 20261015 --runs 2000
```

The receipt declares `format: "aru-evidence-brief-receipt"`, `version: 1`, and `model_revision: "aru-evidence-briefs-1"`. It contains the ordered names, all supplied ledger records (up to 100), and the ordered results. The browser and CLI reject changed result values, source IDs, order, duplicate names or records, and invalid shapes. The browser reads the JSON locally without importing it into the visitor's ledger. Editing names or ledger data invalidates the current download until a new brief is built. Older single-question receipts and cited answer excerpts remain verifiable.

The separately written Python oracle compares exact-name results with the extracted JavaScript browser model across 8 fixed and 2,000 seeded generated cases. The generator varies normalized spelling, duplicate active assertions, conflicting values, superseded sources, missing names, irrelevant records, and record order. A deliberately changed result verifies that the comparator detects disagreement. The [committed differential report](example-brief-differential-report.json) pins the seed and local source hashes; CI regenerates it. Agreement on these synthetic cases checks software behavior, not broad language understanding.

## Proof boundary

The receipt checks **internal consistency with the records included in that file**. A person can omit a conflicting record, recompute the result, and produce another consistent receipt. No local verifier can authenticate the ledger's origin or establish that these user assertions are true. Brief receipts intentionally include unrelated entries, because a refusal such as `missing` cannot be justified from a cited-only excerpt. Review the full JSON before sharing it. Neither these checks nor the field's μ score establishes a benefit to users; a user study needs a prespecified task and independent ratings.
