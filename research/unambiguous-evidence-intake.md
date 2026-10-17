# Unambiguous evidence intake — verification and invention log

## Problem

Before this change, a receipt with `"version": 0, "version": 1` could receive `MATCH` from the standalone Node verifier. The earlier value vanished during ordinary JSON parsing. The same problem applies to names within nested records, references, checkpoints, captures, and opening keys. Another parser might choose the first value, the last value, or reject the file. [RFC 8259, section 4](https://www.rfc-editor.org/rfc/rfc8259.html#section-4) explicitly describes the interoperability problem. A byte hash binds the file, but it cannot make an ambiguous interpretation reliable.

## Mechanism and user path

The browser and Node parse the original JSON text once for syntax, then scan its object members before trusting the parsed value. Each member name is decoded with the platform JSON parser, so `"version"` and `"\u0076ersion"` count as the **same** name. A `Set` is scoped to each object, so two separate receipt records may both have an `id`. Python uses `object_pairs_hook`, which receives every member before a dictionary can discard duplicates. All three reject repeated names anywhere in the supplied JSON tree. The browser and Node scanners bound nesting to 128 levels; existing evidence formats use much less. The validator never displays a private member name in the rejection.

The guard covers browser evidence receipt verification, reference comparison, batch audit, transition replay, saved captures, private capture and opening key comparison, correction-chain files, evidence imports, and full-state imports. It also covers standalone Node evidence receipts and references, both batch auditors, and offline kit captures and manifests. A batch can still include a malformed or ambiguous receipt as a **`FAIL` row** in a saved capture; `CAPTURE MATCH` means that failure reproduced, not that the receipt passed. An ambiguous reference or checkpoint stops the audit before receipt verdicts are computed. A receipt must have one unambiguous interpretation to earn `MATCH`.

Ordinary exported JSON has unique names and keeps its byte-based capture format. Raw file bytes are still hashed or keyed as before; the guard does not normalize, rewrite, or import a file. The browser script and Node auditor changed, so version 2 captures made by the earlier page need their matching archived verifier kit. A legacy version 1 capture still lacks a script fingerprint and must be interpreted accordingly.

## Reproduce the before and after

From this checkout, create a synthetic receipt with two version fields. Ordinary `JSON.parse` yields the same object as the original, exposing why a duplicate can be missed:

```bash
python3 - <<'PY'
from pathlib import Path
original = Path('research/example-evidence-receipt.json').read_text()
Path('/tmp/aru-ambiguous-receipt.json').write_text(original.replace('"version": 1,', '"version": 0, "version": 1,', 1))
PY
node tools/verify-evidence-receipt.cjs /tmp/aru-ambiguous-receipt.json research/example-evidence-reference-baseline.json
node tools/audit-evidence-batch.cjs research/example-evidence-reference-baseline.json /tmp/aru-ambiguous-receipt.json
python3 tools/independent-evidence-batch.py research/example-evidence-reference-baseline.json /tmp/aru-ambiguous-receipt.json
```

Before the guard, the first command exited **0** with `MATCH: known` for this exact synthetic file. With the guard, it exits **1** and says `Invalid receipt: duplicate JSON object name`. Both batch commands exit **1** and report `0 MATCH, 0 DIFFER, 1 FAIL`. Replacing `"version"` with `"\u0076ersion"` or duplicating a nested `"value"` is also rejected. The test suite checks that quoted text resembling a member name and the same member name in separate objects remain valid. It tests references, checkpoints, ordinary and private captures, opening keys, and archived kit behavior.

Run `node --test tests/unambiguous-json.test.cjs tests/field.test.cjs tests/verifier-kit.test.cjs` for focused coverage and `node --test tests/*.test.cjs` for the full regression suite. CI runs the focused test too.

## Trust, prior art, and next work

This closes one parser ambiguity. It does not prove that an assertion is true, that a file was authored by a particular person, or that another JSON implementation interprets every number and Unicode edge case identically. File hashes and keyed commitments still depend on the selected bytes and code version. No claim of a new JSON parser, scientific validation, market demand, or patentability is made.

**Invention log:** The problem is a plausible `MATCH` on a receipt with two incompatible member values. The mechanism is a bounded original-text duplicate-name check before evidence replay and a separate Python member-pair hook. Prior art to investigate includes RFC 8259, JSON Canonicalization Scheme [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html), and signature formats that demand unambiguous JSON. What remains unproven is broad cross-language equivalence beyond the tested evidence schema and how users understand a `CAPTURE MATCH` that records `FAIL`. The next high-value task is a full parser differential challenge over bounded JSON inputs and a reviewer study on the distinction between replay consistency and evidence truth.
