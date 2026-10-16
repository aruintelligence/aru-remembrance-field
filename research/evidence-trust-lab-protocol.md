# Five-case evidence trust lab

The **Run the evidence challenge** control near the top of the app opens a local synthetic demonstration. It creates a cited answer for `What is my favorite color?` from source #1, `favorite color = teal`, and constructs five variations. It calls the same `verifyEvidenceBundle`, `compareEvidenceToReference`, and `ledgerCheckpointSHA256` functions used by the file verifier. No entry from the visitor's ledger, score, messages, or storage is read or changed by the challenge. Secure browser hashing is required.

| Fixed case | Receipt replay | Saved reference | Earlier checkpoint | Decision |
| --- | --- | --- | --- | --- |
| Original answer | PASS | MATCH | MATCH | ACCEPT |
| Omitted current conflict | PASS | DIFFER | MATCH | REJECT |
| Receipt and reference changed together | PASS | MATCH | DIFFER | REJECT |
| Older superseded assertion | PASS | MATCH | MATCH | ACCEPT |
| Answer edited without its source | FAIL | SKIP | MATCH | REJECT |

The conflict case adds an active source #2 that says `amber` to the reference; the cited excerpt still contains only source #1. Its checkpoint matches the conflicted reference. The forged-pair case changes source #1 to `amber` in both the excerpt and candidate reference, while retaining the digest of the original `teal` reference. The historical case adds a superseded `amber` source #2 to a matching reference. The altered-answer case changes the receipt's reported value to `purple` but leaves its cited `teal` source intact.

Each result is calculated at click time. `SKIP` means the reference comparison was not run because the receipt already failed replay, as in the upload flow. The displayed `5/5` counts exact agreement with the fixed expected matrix; an unexpected result is shown as a lower count, not silently labeled success. The regression suite checks the displayed rows, repeats the action, confirms no personal state changes, and deliberately replaces the reference comparison function with a broken one to confirm that the displayed count drops to `4/5`.

The lab demonstrates failure modes of these deterministic rules, not a population study, an authenticated timestamp, or truth of a recorded assertion. A checkpoint adds evidence only if the checker preserved it independently before receiving the later reference. The existing [receipt protocol](evidence-receipt-protocol.md) and [checkpoint protocol](evidence-ledger-checkpoint-protocol.md) specify the file formats and independent CLI checks for a real saved case.
