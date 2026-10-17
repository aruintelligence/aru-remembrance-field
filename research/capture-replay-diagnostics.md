# Capture replay diagnosis — invention and validation record

## Problem

A saved batch capture could fail replay while the browser reported only a broad difference. A person had to guess whether they had selected the wrong reference, checkpoint, receipt order, or page version, or whether recorded verdicts had changed. A matching capture could also contain `DIFFER` and `FAIL` audit rows, making a plain `PASS` label easy to misread.

## Implemented mechanism

The browser first recomputes the audit from the original selected files. It then compares the saved capture with that recomputed capture and reports bounded, ordered discrepancies for the verifier script, reference bytes, optional checkpoint, selected receipt count and position, individual receipt bytes and verdict, identical-file relationship, totals, and strict structure. It displays fixed labels and row numbers, never file contents, raw hashes, or arbitrary text from the capture. A new selection clears earlier findings. Acceptance still requires exact capture equality. A successful replay is labeled `CAPTURE MATCH`, with audit outcomes reported separately and an explicit warning when any audited receipt differs or fails.

The mechanism is a local explanation of *where two artifacts differ*. It cannot determine who changed them, which copy is authoritative, why bytes changed, whether the original set was complete, or whether any underlying assertion is true. The first 12 findings are displayed if many fields differ; the total count and remaining count are shown. No input is uploaded or placed in browser storage by the replay path.

## Reproducible checks

Use the synthetic reference, checkpoint, and receipts in `research/` to download a v2 capture and compare it in the page. Alter the reference hash, reverse the receipt entries, change one recorded verdict and a total, then compare again. The page lists separate reference, per-receipt, verdict, and total findings without exposing the synthetic values. Re-select the original capture to see earlier findings clear. The automated browser test exercises those cases, the legacy v1 notice, invalid structure, malformed files, and a stale asynchronous read. The Node and independent Python auditors still replay the refreshed v2 fixture.

## Prior art and next investigation

Before describing this as novel or seeking protection, compare its claim and threat model with existing evidence provenance systems, reproducible verification reports, software supply-chain attestations, and privacy-preserving diagnostic interfaces. No novelty or patentability conclusion has been reached. A high-value next step is an independently executable, versioned verifier bundle that a recipient can archive with a capture. It would need explicit code provenance and distribution trust, a migration story for older captures, independent implementation checks, and a clear distinction between software consistency and factual truth.
