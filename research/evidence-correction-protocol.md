# Reviewed fact corrections

## Apply a correction

In **Evidence memory**, enter an existing fact name and a replacement value. **Preview correction** lists every current assertion for that normalized name, including imported sources, and shows the proposed new source ID and value. The preview does not write state. **Apply reviewed correction** checks that the name, value, entire ledger, and source counter still match the reviewed snapshot. It then makes a new current user assertion and marks every previous assertion for that name superseded. Older sources stay in the ledger; other names stay untouched. A missing or historical-only name, unchanged current value, full 100-record ledger, or stale preview cannot be applied. The correction does not change the field's modeled μ or freeform messages.

For example, a current `favorite color = teal` becomes a superseded source after a reviewed correction to `amber`. If `teal` and `purple` are simultaneously current, both appear in the preview and become superseded together. The new source resolves the conflict explicitly. **Record fact** still creates an independent assertion and may create a conflict; the correction action does not silently change that behavior.

After applying, **Download correction receipt JSON** captures the complete ledger before and after, the name and value, new source ID, and application timestamp. It remains available until the ledger or input is edited. The same **Verify a shared answer receipt** panel checks it locally without importing it. From a checkout, run:

```bash
node tools/verify-evidence-receipt.cjs research/example-evidence-correction.json
python3 tools/differential-correction.py --seed 20261015 --runs 2000
```

The [synthetic receipt](example-evidence-correction.json) starts with two conflicting current color sources, one unrelated current record, and an older superseded color source. Verification confirms that the two current sources become superseded, the unrelated and older records are preserved, and source #5 becomes current. The format is `aru-evidence-correction-receipt`, version `1`, revision `aru-evidence-corrections-1`. Both browser and CLI reject an altered status, value, source ID, missing prior record without a matching recomputation, or extra result field. Older question and brief receipts remain supported.

A separately written Python oracle checks the correction transition against the extracted browser JavaScript on 6 fixed and 2,000 seeded generated ledgers. These vary conflicts, imported sources, Unicode compatibility names, historical entries, unrelated records, value changes, and source ordering. A deliberate status mutation checks that the comparator detects disagreement. The [committed report](example-correction-differential-report.json) records the seed, case count, result, and both local source hashes; CI regenerates it.

## Limits

The receipt is a consistency check for **supplied** before and after records. Someone can omit a prior source and recompute another consistent transition. It cannot authenticate the author, prove the original ledger was complete, or establish that a user assertion is factually true. Both snapshots can contain unrelated private values; inspect the JSON before sharing it. A successful synthetic challenge or differential check does not measure a human benefit or validate the symbolic field score.
