# Compact correction packets

## Why this format exists

The [full correction chain](evidence-correction-chain-protocol.md) repeats a complete before/after ledger at every step. A receiver with the original ledger can instead use a compact `aru-evidence-correction-packet` (version `1`, revision `aru-evidence-correction-packet-1`). It contains exactly `format`, `version`, `model_revision`, `start_sha256`, and `steps`. Each of 2–8 steps has exactly `name`, `value`, `new_source_id`, `applied_at`, and `after_sha256`. These fields carry the proposed new assertion and a commitment to its result; prior and unrelated source records are not serialized.

The builder accepts individual full receipts in any selection order, sorts them by source ID, checks every transition and exact link under the existing rules, then derives both exports. The full chain can be checked from its supplied snapshots. A compact packet requires an *independently held matching starting ledger*. In the browser, choose the packet under **Verify a shared answer receipt** on a browser that already has the initial ledger. The read-only check hashes that ledger, computes each correction locally, checks the resulting hash and next source ID after every step, and enables a preview only if they all match. The preview lists the old current values from the receiver's own ledger. Apply reruns the entire check and refuses a changed ledger. It persists only the final ledger and counter through the [single versioned snapshot](ledger-snapshot-protocol.md); Session-only mode persists neither.

## Exact commitment encoding

For an ordered ledger `records`, SHA-256 is computed over UTF-8 bytes of this compact JSON value (no spaces):

```text
JSON.stringify(["aru-ledger-commitment-1", records.map(r => [
  r.id, r.key, r.value, r.time, r.status,
  hasOwn(r, "imported") ? [r.imported] : []
])])
```

The digest is 64 lowercase hexadecimal characters. Record order, exact text, timestamp, status, and presence or absence of the optional `imported` Boolean are significant. The browser's Web Crypto and the CLI's Node crypto use this same encoding. Records are validated as unique sources with allowed fields before hashing. An ID must equal the receiving browser's next allocated source ID; subsequent IDs advance by one. Changing an unrelated local value changes the initial commitment and refuses the packet. A packet and its matching baseline have a 1 MiB per-file limit in the CLI; the browser accepts a packet up to 1 MiB. The builder also checks its pretty-printed download size.

## Reproduce the public example

```bash
node tools/verify-evidence-receipt.cjs research/example-evidence-correction-packet.json research/example-evidence-ledger-baseline.json
```

The [synthetic packet](example-evidence-correction-packet.json) is derived from the [two-step chain](example-evidence-correction-chain.json); the [synthetic baseline](example-evidence-ledger-baseline.json) represents the receiver's four initial records and next source ID #5. The browser export and the Node verifier agree on every committed digest. The 671-byte packet is about 86% smaller than this example's 4,751-byte full chain. This is an example measurement, not a general compression guarantee. The regression suite also adds an untouched private source, verifies its name and value are absent from the packet, and shows that changing it on the receiver causes refusal.

## Limits and privacy

The packet reveals every changed name and **new** value, timestamp, ID, and SHA-256 of the full ledger at each stage. A hash is not encryption: an observer who can guess a small set of possible ledgers may test guesses offline. Do not share the baseline file or full receipts when the purpose of using the packet is to withhold unrelated values. Secure browser hashing is required; if unavailable, the full-chain export remains available.

A match proves only that the supplied steps replay on the particular starting ledger supplied to the checker and produce the packet's digests. It does not identify the sender, prove a recorded value true, prove that a historical event happened, or establish that the initial ledger was complete. Anyone who knows the starting ledger can construct another consistent packet. The packet alone cannot be independently verified, and a browser that diverged from the initial ledger is refused rather than silently merged. Browser storage does not guarantee physical disk durability; keep a separate backup of important records.
