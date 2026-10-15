# Portable evidence question receipts

The browser can export a receipt for the most recent question in **Evidence memory**. This is a replayable record of what the exact-name question code returned for a particular ledger snapshot. It works for a sourced answer or a refusal such as `conflict`, `ambiguous`, or `missing`.

1. Record facts, enter a question, and select **Ask with sources**.
2. Read the result, then select **Download question receipt JSON**.
3. From a local checkout, run:

   ```bash
   node tools/verify-evidence-receipt.cjs /path/to/aru-evidence-question-receipt.json
   ```

For a no-private-data example, run `node tools/verify-evidence-receipt.cjs research/example-evidence-receipt.json`.

The receipt contains the exact question, the answer kind and any value or source IDs, and a **full snapshot of up to 100 ledger records**. The verifier validates the records, runs the repository's actual `resolveEvidenceQuestion` and `evidenceAnswerSummary` functions against them, and rejects a mismatch. It also reports a SHA-256 hash of the local extracted question code. A changed value, conflicting record, question, or citation that changes the answer fails verification. The verifier rejects duplicate or malformed records and files over 1 MiB.

Changing the question clears the displayed answer and disables its receipt. Recording, importing, selecting, or deleting a ledger entry also invalidates the old answer and receipt. The app keeps the receipt in memory only until another question or edit; it does not add the receipt to local storage. Downloading is an explicit action.

**Privacy:** The full snapshot may include sensitive facts unrelated to the question. Inspect the JSON before sharing it. The output is not suitable for public publication if your ledger contains private details. The receipt is a different format from an evidence ledger import and cannot be used as an import file.

**What a pass means:** The answer matches the records **in the supplied file** under the checked-out code. It does not prove that the snapshot contains every record from the original browser, that the file was made by this app, that the author is who they claim, that its values are true, or that the model has general question-answering ability. A person can edit both records and answer and generate another internally consistent receipt. The SHA-256 identifies the verifier's local code; it is not an authenticity signature on the receipt.
