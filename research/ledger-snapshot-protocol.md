# Versioned local evidence ledger snapshot

## Saved representation

The browser saves the evidence ledger and its next source ID in one `localStorage` value, `aru_fact_ledger_v1`:

```json
{"version":1,"claims":[],"next_source_id":1}
```

`claims` is an ordered array of up to 100 validated records. IDs are unique and lower than `next_source_id`, which is an integer from 1 through 1,000,000,001. Names and values must already be in the browser's canonical stored form. A malformed snapshot is rejected as a whole; the app does not silently load stale legacy keys in its place. The inspector warns that the ledger is unreadable, offers a download of its raw storage value, and pauses ordinary persistent writes. A reviewed full-state backup can replace the unreadable value; **Erase local state** is a separate explicit choice.

Existing browsers with the older `aru_fact_claims` and `aru_fact_counter` keys load them when no new snapshot exists. The next successful save writes the versioned snapshot, then tries to remove the old keys. If the page closes during cleanup, the new snapshot remains authoritative on the next load. The normal **Erase local state** path removes both old and new keys. Full-state exports keep their established version 1 file format, so older downloaded backups remain restorable.

## Correction application

After review and replay, a single correction, a full chain, or a compact packet checks that the current saved ledger still matches the receiver's in-memory starting ledger. A changed saved copy is refused, with a reload prompt. The final records and counter are written with one `setItem` call. If that call throws, the in-memory ledger is left unchanged. If the page closes before the call, the old saved ledger remains; if it closes after a completed call but before the UI update or old-key cleanup, the new snapshot supplies both values on reload. Session-only mode makes no write.

The [current HTML Standard](https://html.spec.whatwg.org/multipage/webstorage.html) defines `setItem` as setting one key/value pair and allows it to throw if the value cannot be stored. The [Web Storage specification](https://www.w3.org/TR/2021/SPSD-webstorage-20210128/) describes an individual operation as atomic with respect to failure, while explicitly not requiring physical disk flush before return. This design removes the two-key mismatch within the Web Storage API; it is not a guarantee against device failure, storage eviction, browser bugs, or a simultaneous write in another tab after the prewrite comparison. Keep downloaded backups for important records.

The full-state restore still writes several unrelated score and message keys. It attempts rollback when a write fails, including failures after the new ledger key was written. A crash during that broader multi-key restore can leave a partial mixture of score and message state, though the evidence ledger and its counter remain paired in their snapshot. The regression suite exercises old-key migration, interrupted cleanup, close-before/close-after correction boundaries, rejected snapshot writes, unreadable snapshots, reset, and restore rollback.
