# Private transition sharing — protocol and invention log

## Problem and user path

A regular paired transition capture publishes plain SHA-256 hashes of its reference, checkpoint, and receipt files. A person who knows the likely wording of a private assertion can hash a guess and compare it with the capture without asking its holder. The optional private capture keeps the existing two-reference trace and its original files, but replaces those file hashes with keyed commitments. It is a sharing mode for an intended verifier, not an encrypted evidence store.

In **Trace a verdict across two references**, select A and optional A checkpoint, B and optional B checkpoint, and 1–20 ordered receipts. Select **Trace selected receipts**. Inspect the trace and both verdict counts. Select **Prepare private pair**, then download **Private capture** and **Opening key**. The browser generates a fresh 256-bit HMAC key for each preparation. The key is held in page memory, not saved to the app's local storage, and is cleared when the trace or file selection changes. Keep the key file separate from the capture. Giving both to the same public audience restores their ability to test guesses about private assertions. Losing the key prevents replay of that capture. A new pair for the same evidence has different commitments.

To compare later, reselect the original references, checkpoints, and receipt files in order; trace them again; choose the private capture and opening key files; select **Compare private capture**. The page recomputes every commitment and the verdicts and totals. A matching result can include `DIFFER` and `FAIL`: inspect each side's counts. A and B are comparison labels, not verified dates. No selected evidence or key is uploaded by the app. The saved files are strict UTF-8 JSON, at most 1 MiB each. A stale selection cannot authorize a comparison or download.

## Exact format and recomputation

The opening key JSON has exactly `{ "format": "aru-evidence-transition-opening-key", "version": 1, "key_hex": "..." }`, where `key_hex` is 64 lowercase hexadecimal characters representing 32 bytes. The private capture has format `aru-evidence-sealed-reference-transition-capture`, version 1, a clear `browser_script_sha256`, commitments for reference A/B and their optional checkpoints, ordered receipt commitments, per-side verdicts and totals, exact-byte repeat positions, and changed-verdict positions. Missing optional checkpoints have `null` commitments. It omits the key, raw file hashes, filenames, fact values, and questions; the visible verdict and repeat pattern may still reveal information.

For a file with SHA-256 hex digest `d`, calculate `HMAC-SHA256(key, ASCII("aru-sealed-transition-v1\n" + role + "\n" + index + "\n" + d))`. The role is `reference-a`, `reference-b`, `checkpoint-a`, `checkpoint-b`, or `receipt`; references and checkpoints use index `0`, and receipts use their one-based selection index. Thus identical receipt bytes at different positions have different commitments, while `duplicate_of` explicitly records exact-byte repetition. The browser uses Web Crypto; Node and Python independently compute the same format. The comparison requires exact nested fields, ordered positions, commitments, verdicts, totals, changed positions, and the inline browser script fingerprint. The browser script fingerprint is intentionally clear so a verifier can find a matching archived code version.

From the code version matching the capture, supply the private originals, capture, and separately obtained opening key:

```bash
node tools/audit-evidence-batch.cjs /path/to/reference-a.json /path/to/receipt-1.json /path/to/receipt-2.json --checkpoint /path/to/checkpoint-a.json --reference-b /path/to/reference-b.json --check-sealed /path/to/private-capture.json --opening-key /private/path/opening-key.json
python3 tools/independent-evidence-batch.py /path/to/reference-a.json /path/to/receipt-1.json /path/to/receipt-2.json --checkpoint /path/to/checkpoint-a.json --reference-b /path/to/reference-b.json --check-sealed /path/to/private-capture.json --opening-key /private/path/opening-key.json
```

Omit `--checkpoint` if A did not have one; add `--checkpoint-b /path/to/checkpoint-b.json` if B did. Both commands exit 0 on a matching private capture, **even if the recorded audit has `DIFFER` or `FAIL` rows**; without a capture check an audit with those rows exits 1. A mismatch or malformed input exits 1. Use `--json` only if you want a machine-readable private capture; in private-check mode it does not print the ordinary raw-hash transition object. `--explain-additions` separately recomputes the bounded answer witness and may reveal source IDs in its output. The offline verifier kit accepts the private capture to pin matching code without copying the key, capture, or originals. Its structural check is not an evidence replay; run both archived auditors to replay.

## Reproducible before and after

The synthetic repository references and receipts have two `MATCH` verdicts on A and two `DIFFER` verdicts on B. The ordinary fixture in `research/example-evidence-reference-transition-capture.json` includes the raw SHA-256 of the reference and each receipt, directly comparable to a guessed file. In `tests/sealed-transition.test.cjs`, the same fixture is converted in memory with a **fixed test-only key** to the private shape; the test checks the raw hashes are absent and that another key changes the commitments. Do not reuse that fixed key for real sharing. `tests/field.test.cjs` exercises a browser-generated random pair, then both independent CLI replays; it also tests an audit with a malformed receipt. Run:

```bash
node --test tests/sealed-transition.test.cjs tests/field.test.cjs tests/verifier-kit.test.cjs
```

The test suite rejects a wrong or malformed key, changed file bytes with the same verdict, swapped or missing receipts, changed references and checkpoints, a script fingerprint change, changed verdicts/totals, extra fields, an old capture format, and malformed JSON. It demonstrates **software consistency on synthetic cases**. It does not establish clinical, scientific, or human-factors performance, nor does it audit the cryptographic implementation or an end-to-end key distribution channel.

## Trust and privacy limits

HMAC is a shared-secret message authentication mechanism, not a signature. The capture alone makes offline guessing against the commitments impractical when the fresh key remains secret and the primitives and randomness work as assumed; it still discloses metadata and its script fingerprint. Someone with the key can test guesses. A recipient holding both files can also create a new internally consistent capture, so the match does not establish who made it. A hash or HMAC does not establish independent custody, chronological order, source completeness, or factual truth. A compromised browser, extension, operating system, download location, or verifier can disclose the key or original files. A saved checkpoint helps only if an independently held earlier copy exists. No guarantee about delivery of the two downloads is made.

## Invention log and next experiment

**Problem:** Share a reproducible verdict transition without publishing plain hashes of predictable private evidence. **Mechanism:** Domain-separated, position-bound HMAC commitments under a fresh, separately transferred opening key; reveal the bounded outcome pattern, then require original files for replay. **Prior art to investigate:** [NIST's HMAC specification](https://csrc.nist.gov/pubs/fips/198-1/final), the [W3C Web Crypto API](https://www.w3.org/TR/WebCryptoAPI/), keyed content fingerprints, selective disclosure, private set membership, authenticated provenance and reproducible build attestations. HMAC itself is established prior art; no patentability claim is made. **Unproven:** user comprehension of key separation, leakage from verdict patterns, real-world custody, adversarial browser behavior, and whether independent distribution of verifier code can be authenticated.

The highest-value follow-up is an authenticated, independently distributed verifier release with explicit publisher key custody and revocation, while keeping evidence truth separate from software origin. Run user comprehension and threat-model reviews before treating this private-sharing mode as suitable for sensitive production evidence.
