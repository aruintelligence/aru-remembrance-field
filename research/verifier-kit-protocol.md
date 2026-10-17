# Offline verifier kit: preserve code for future capture replay

A version 2 browser batch capture records the SHA-256 fingerprint of the exact inline browser script running when it was made. A paired [transition capture](portable-transition-capture.md) records two such captures for the same ordered receipts. A [private transition capture](private-transition-sharing.md) uses keyed file commitments and retains that clear script fingerprint. A later page update changes the fingerprint even if its evidence rules stay the same. An archived kit keeps the matching browser page and the two command-line checkers in a separate folder so any of these captures can be replayed offline after the site changes.

## Create while the matching code is available

From a checkout of the repository version that matches the capture:

```bash
node tools/verifier-kit.cjs create /path/to/capture.json /path/to/new-verifier-kit
node /path/to/new-verifier-kit/tools/verifier-kit.cjs check /path/to/new-verifier-kit /path/to/capture.json
```

The destination must not exist. Creation validates the bounded version 2 capture structure and counts (or both version 2 sides of a transition capture), verifies the script fingerprint against this checkout, then writes only `index.html`, the Node auditor and its dependencies, the independently written Python checker, the kit tool, a README, and a deterministic SHA-256 manifest. It does not copy the capture or the selected reference, checkpoint, or receipt files. Keep those originals separately and privately, in selection order. Legacy version 1 single-reference captures have no browser script fingerprint and cannot be used to create a pinned kit.

## Replay from the archive

Using Node.js 22+ and Python 3.12+, from any directory:

```bash
node /path/to/new-verifier-kit/tools/verifier-kit.cjs check /path/to/new-verifier-kit /path/to/capture.json
node /path/to/new-verifier-kit/tools/audit-evidence-batch.cjs /path/to/reference.json /path/to/receipt-1.json /path/to/receipt-2.json --checkpoint /path/to/checkpoint.json --check-capture /path/to/capture.json
python3 /path/to/new-verifier-kit/tools/independent-evidence-batch.py /path/to/reference.json /path/to/receipt-1.json /path/to/receipt-2.json --checkpoint /path/to/checkpoint.json --check-capture /path/to/capture.json
```

If there was no checkpoint, omit the `--checkpoint` option. Include every original receipt in its original order. `KIT MATCH` means the folder's files match its manifest and its browser script matches the selected capture. Each auditor then recomputes the audit from the supplied originals. `CAPTURE MATCH` can reproduce recorded `DIFFER` or `FAIL` rows; inspect the counts and each row. The Node checker extracts its evidence model from the archived page. The Python checker implements the rules separately and reads that page only for the script fingerprint.

The kit manifest records seven allowlisted files, exact sizes, SHA-256 values, and the browser script fingerprint. It has no timestamp or user data. Building twice from identical code and a matching capture produces the same manifest. The checker rejects missing, extra, symlinked, or modified files. A modified capture script hash is rejected before kit creation, leaving no partial destination.

For a paired transition capture, use the same `create` and `check` commands with the transition JSON path. Supply A as the first reference, the same ordered receipts, B with `--reference-b`, and the optional A and B checkpoints. Run both archived auditors with `--check-transition /path/to/transition.json`. `TRANSITION CAPTURE MATCH` reproduces the recorded sides even if one contains `DIFFER` or `FAIL` rows; inspect each side's counts.

The archived auditors also accept `--explain-additions` with paired references. It recomputes the [bounded added-source answer witness](addition-witness-protocol.md) from the original files; the witness sets are not stored in the capture. An edited or reordered ledger yields an explicit unavailable state.

For a private capture, the same kit `create` and `check` operations validate its bounded structure and pin its browser script without reading the opening key. Those operations alone cannot recompute its keyed commitments. Give the key to the intended verifier separately and run both archived auditors with `--check-sealed /path/to/private-capture.json --opening-key /private/path/opening-key.json`, supplying both references, every ordered receipt, and the optional checkpoints. The kit never copies the capture, evidence, or key. Sharing the opening key with the capture lets others test guesses about private facts.

## Trust boundary and future work

The capture pins the inline browser script, not the surrounding HTML, CSS, Node or Python files, operating system, or browser runtime. The manifest records the packaged files' bytes **at packaging time**. A person who can replace a kit can also edit its manifest and checker; an internally matching kit does not prove authorship, original distribution, independent custody, time, or factual truth. Preserve a trusted copy separately if provenance matters. Raw file hashes may permit guesses of predictable private assertions. The selected originals are needed for replay, and the kit does not establish that the original set was complete.

The next research step is to evaluate independently authenticated distribution and revocation for published verifier versions, with a separate key and custody policy. That investigation must keep cryptographic origin claims separate from the truth of user-supplied assertions. No novelty or patentability claim is made here.
