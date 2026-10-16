# Ledger reference checkpoints

The app can export an `aru-evidence-ledger-baseline` (version 1) containing its complete ordered evidence records and `next_source_id`. Unlike **Download evidence JSON**, this reference is directly accepted as the second argument of the [receipt verifier](../tools/verify-evidence-receipt.cjs). It is a private, read-only export, not an import file. The export refuses a tab whose saved ledger has changed or is unreadable. Session-only mode exports the current in-memory ledger.

The companion `aru-evidence-ledger-checkpoint` (version 1) has exactly `format`, `version`, `encoding`, and `sha256`. Its encoding is `aru-evidence-ledger-checkpoint-1`. It contains no records, next source ID, date, or author. The browser requires secure Web Crypto hashing and refuses a changed ledger during the asynchronous calculation. Neither export changes the ledger, score, messages, or storage.

## Exact encoding

Validate at most 100 unique records with allowed fields, valid values, and source IDs less than `next_source_id` (a safe integer from 1 through 1,000,000,001). Let `H(s)` be lowercase hexadecimal SHA-256 of the UTF-8 bytes of string `s`:

```text
ledger_digest = H(JSON.stringify(["aru-ledger-commitment-1", records.map(r => [
  r.id, r.key, r.value, r.time, r.status,
  hasOwn(r, "imported") ? [r.imported] : []
])]))

checkpoint.sha256 = H(JSON.stringify([
  "aru-evidence-ledger-checkpoint-1", ledger_digest, next_source_id
]))
```

Record order, every field value, and the presence of the optional `imported` Boolean matter. The second hash includes the counter, which is not part of the earlier compact correction packet commitment. Both implementations use JSON serialization and UTF-8 with the same array encoding. The verifier rejects unsupported fields, duplicate sources, impossible counters, altered digests, and files over 1 MiB per input. The checkpoint is a digest of a *particular* reference, not a self-contained proof of what the ledger contained.

## Reproduce the example

The [synthetic baseline](example-evidence-reference-baseline.json), [checkpoint](example-evidence-ledger-checkpoint.json), and [cited excerpt](example-evidence-excerpt.json) match:

```bash
node tools/verify-evidence-receipt.cjs research/example-evidence-excerpt.json research/example-evidence-reference-baseline.json research/example-evidence-ledger-checkpoint.json
```

The verifier first checks that the supplied baseline matches the checkpoint, then replays the receipt and compares it against that baseline. It reports `CHECKPOINT MATCH` only when both checks pass. A conflicting source in the baseline makes the excerpt comparison fail even if the excerpt alone passes. A sender can also supply an internally consistent forged receipt and reference; a checkpoint held independently from before those files were received detects a changed reference. The tests mutate a record value, timestamp, status, optional field, source ID, and counter, and check a forged receipt plus reference.

To use this with your own data, save a checkpoint from **Evidence memory** and preserve it independently. Export the reference ledger for that same unchanged state, or receive a candidate copy later. Use the three-file command above with your receipt, candidate reference, and saved checkpoint. The browser's local receipt comparison remains an alternative when the original ledger is still in that browser.

The checkpoint does not establish a time, author, ownership, completeness, or factual truth. If an attacker can replace the checkpoint too, they can create another matching pair. SHA-256 is not encryption: small or predictable ledgers can be guessed and compared offline, so avoid sharing even the compact checkpoint when that disclosure matters. A `MATCH` is conditional on the independently held reference and the verifier's deterministic rules; it is not external validation of a claim.
