# Portable evidence question receipts and answer excerpts

The browser offers single-question receipts and cited excerpts in **Evidence memory**. The [multi-fact evidence brief](evidence-brief-protocol.md) adds a third full-snapshot receipt for 2–8 names:

| Export | Available for | Included records | What a replay checks |
| --- | --- | --- | --- |
| **Cited answer excerpt** (`aru-evidence-answer-excerpt`) | Known answers | Exactly the active assertions cited by that answer | The answer follows from those supplied sources. |
| **Full question receipt** (`aru-evidence-question-receipt`) | Answers and refusals | The entire ledger snapshot, up to 100 records | The result follows from that supplied snapshot. |

The excerpt limits disclosure of unrelated facts. Neither format proves that other ledger entries were not omitted before export or that a recorded assertion is true.

1. Record facts, enter a question, and select **Ask with sources**.
2. Read the result. For a known answer, select **Download cited answer excerpt JSON**; to preserve a refusal or include the full ledger, select **Download full question receipt JSON**.
3. From a local checkout, run:

   ```bash
   node tools/verify-evidence-receipt.cjs /path/to/aru-evidence-question-receipt.json
   ```

For no-private-data examples, run `node tools/verify-evidence-receipt.cjs research/example-evidence-excerpt.json` and `node tools/verify-evidence-receipt.cjs research/example-evidence-receipt.json`.

Both files contain the exact question, answer kind, any value and source IDs, and their supplied records. The excerpt also declares `scope: "cited-assertions-only"`. The verifier validates records, runs the repository's actual `resolveEvidenceQuestion` and `evidenceAnswerSummary` functions against them, and rejects a mismatch. An excerpt must contain **all and only** its cited active assertions within the file. The verifier rejects duplicate or malformed records and files over 1 MiB, and reports a SHA-256 hash of the local extracted question code. The hash identifies code bytes, not the origin of either receipt.

The same browser panel and CLI also replay `aru-evidence-brief-receipt` files with their ordered names, results, and complete supplied records. The [synthetic brief](example-evidence-brief.json) contains one sourced answer and three distinct refusals. It does not replace the privacy-limited cited answer excerpt for a single known fact.

The [reviewed correction receipt](evidence-correction-protocol.md) supplies complete before and after ledgers. The verifier recomputes which same-name sources become superseded and checks that the new source is the only current one for that name. It can verify a recorded transition, but cannot establish that the prior ledger was complete or authentic.

For a correction receipt, the browser also offers a separate **Preview applying correction here** action after verification. It permits **Apply reviewed receipt here** only when the local ordered ledger matches the receipt's complete starting snapshot and the browser would allocate its proposed source ID next. This is an explicit local write after review, not part of verification; diverged copies are refused. The CLI remains read-only.

An `aru-evidence-correction-chain` file wraps 2–8 individual correction receipts. The same browser panel and CLI verify each receipt and every exact before/after link; the browser can bundle selected files and apply a reviewed chain as one local operation to a matching starting ledger. See the [chain protocol](evidence-correction-chain-protocol.md) and [synthetic example](example-evidence-correction-chain.json). It carries repeated full snapshots and may reveal unrelated values.

The builder can also derive a [compact correction packet](evidence-correction-packet-protocol.md) from a checked chain. It carries changed names and new values with SHA-256 commitments instead of full snapshots. The browser checks it against its own starting ledger; the CLI requires a separate matching baseline file. A packet alone cannot be independently replayed.

Changing the question clears the displayed answer and disables both exports. Recording, importing, selecting, or deleting a ledger entry also invalidates the old answer and exports. A refusal cannot produce a cited answer excerpt. The app keeps the snapshot in memory only until another question or edit; it does not add either file to local storage. Downloading is an explicit action.

**Privacy:** An excerpt omits unrelated ledger facts but includes the question and cited values, which can still be sensitive. A full receipt may include sensitive facts unrelated to the question. Inspect either JSON before sharing it. Neither format is an evidence ledger import file.

**What a pass means:** The answer matches the records **in the supplied file** under the checked-out code. For example, an excerpt citing `teal` can pass even if an omitted current assertion says `amber`; the full ledger would then refuse to choose one. This is an explicit counterexample in `tests/field.test.cjs`. A pass does not prove completeness, origin, authorship, factual truth, or general question-answering ability. A person can edit the supplied records and answer and create another internally consistent file.
