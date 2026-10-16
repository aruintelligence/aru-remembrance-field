# Consecutive evidence correction chains

## Purpose and format

A single [reviewed correction receipt](evidence-correction-protocol.md) transfers one recorded change to a matching browser. A chain carries 2–8 consecutive receipts in one `aru-evidence-correction-chain` JSON file (version `1`, revision `aru-evidence-correction-chain-1`). It has exactly four fields: `format`, `version`, `model_revision`, and `receipts` in oldest-to-newest order. Each nested receipt keeps its own original `aru-evidence-correction-receipt` format and complete before/after ledger snapshots.

Every step must replay under the correction rule. The preceding `after_records` must exactly equal the next `before_records`, including record order, IDs, names, values, timestamps, statuses, and optional imported flags. The next new source ID must be the previous new source ID plus one. The verifier rejects a missing link, a fork, an altered result, a repeated step, or a reversed sequence. The browser and CLI accept at most 1 MiB per chain. Nothing is uploaded by the app.

## Make and use a chain

1. Keep a backup or a second browser with the evidence ledger from before the first change. After each correction in the first browser, download its receipt **before** editing the ledger again.
2. In **Verify a shared answer receipt**, choose 2–8 individual files under **Bundle consecutive corrections**. File selection order does not matter. Select **Verify and bundle sequence**; the app sorts by the proposed source IDs, replays the steps, and checks all links. **Download chain JSON** saves the portable bundle.
3. In the second browser, choose that chain JSON under the regular receipt file input, or select the same individual files in the builder. A pass enables **Preview applying correction here**. Review each old current value and replacement. **Apply reviewed receipt here** checks the initial ledger and next source ID again, replays every step, then writes only the final ledger and counter in a [single versioned snapshot](ledger-snapshot-protocol.md). A rejected write leaves the in-memory ledger unchanged. In Session-only mode the chain stays in memory and disappears on reload.

For a no-private-data example:

```bash
node tools/verify-evidence-receipt.cjs research/example-evidence-correction-chain.json
```

The [synthetic chain](example-evidence-correction-chain.json) first resolves two conflicting color sources with `amber` (#5), then corrects an unrelated note with source #6. The second `before_records` is the first `after_records`. The fixture uses canonical browser-style record fields and can be applied to a matching copy of its initial four-record ledger with next source ID #5. The regression suite also feeds its two files to the browser in reverse order, exports the bundle, applies it to a second copy, and reloads that copy. It challenges a fork recomputed to be individually valid, a missing ID, reversed and repeated steps, a local divergence, a stale preview, a rejected storage write, and Session-only mode.

## What this checks

A pass establishes that the **supplied** receipts form a continuous, internally consistent sequence under this code. The exact-match application guard establishes that the receiving browser's current ledger matches the first supplied snapshot at application time. It does not prove that the first snapshot included all original records, that the receipts came from a particular person or browser, that a recorded assertion is true, or that no events occurred and were later undone. Anyone can rewrite the full sequence and recalculate a different consistent bundle. This is not a network synchronization or conflict-resolution protocol; a diverged browser is refused rather than merged.

Each nested receipt contains two full snapshots. A chain repeats unrelated names and values across steps and can reveal more private data than a single cited answer excerpt. Inspect it before downloading or sharing. A browser storage operation is not a guarantee of physical disk durability; keep a separate backup of important records.

For a smaller transfer to a matching browser, the builder can also derive a [compact correction packet](evidence-correction-packet-protocol.md). It omits unrelated names and values, but requires the starting ledger to check its commitments; the full chain remains independently replayable from its supplied snapshots.
