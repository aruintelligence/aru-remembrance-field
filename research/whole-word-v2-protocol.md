# Score rules v2: whole words and replayable counterexamples

This page documents the archived v2 revision. [V3](direct-negation-v3-protocol.md) is the live score model.

The field score is a scripted simulation. This revision corrects one mechanical error in its text matching: a word hidden inside a longer word no longer earns a bonus or triggers a contradiction. It does not infer meanings, truth, or consciousness.

## Reproduce the change

From the repository root, run `node tests/field.test.cjs`, then:

```bash
node tools/verify-proof.cjs research/example-proof.json
node tools/verify-proof.cjs research/example-proof-v2.json
node tools/verify-trajectory.cjs research/example-trajectory.json
node tools/verify-trajectory.cjs research/example-trajectory-v2.json
```

The tests evaluate both revisions directly with fixed μ = `0.64` and time = `1700000000000` ms. These examples isolate the named rule with otherwise empty history unless indicated. A term of zero may be serialized as `0` or `-0`; both mean no score contribution.

| Input and relevant prior state | v1 term | v2 term | Interpretation |
| --- | ---: | ---: | --- |
| `misremember`, matched word rule | +0.035 | 0 | `remember` is only a substring. |
| `untruth`, matched word rule | +0.024 | 0 | `truth` is only a substring. |
| `nevermore` after a memory saying `always`, contradiction rule | −0.030 | 0 | `nevermore` is not `never`. |
| `never` after a memory saying `always`, contradiction rule | −0.030 | −0.030 | A whole `never` retains the literal rule. |
| `rose-river` after a user message `rose river`, repetition rule | 0 | −0.030 | Punctuation now separates words consistently. |

For the `nevermore` transition at μ = `0.64`, v1 ends at `0.59624` with the `always` memory; v2 ends at `0.62624`, the same as its empty-history control. The [v2 proof](example-proof-v2.json) records every term. The [v2 trajectory](example-trajectory-v2.json) uses `always` → `nevermore` → `never`: the second step has zero history effect and the third step has `−0.03`. Both receipts are deterministic and can be rewritten to produce another internally consistent receipt; they do not authenticate an origin.

## Rule and migration

V2 applies Unicode NFKC normalization and lowercase conversion, then extracts contiguous Unicode letters, numbers, and combining marks as words. Its scoring keywords and contradiction pairs are still literal English words. Thus `ＣＡＦÉ river` has memory tokens `café` and `river`, but the model does not stem, translate, segment languages without spaces, or understand negation in context. A hyphen is a word boundary; an apostrophe also splits words. The `?` and fullwidth `？` mark a question. An intent phrase such as `i remember` still requires complete adjacent words.

The live app reads saved memory text and rebuilds derived tokens and comparison text on reload. V2 proof and trajectory downloads declare `aru-field-heuristics-2` and replay against [the frozen v2 source](../tools/field-model-v2.js), SHA-256 `0ac11a6362478c5fd25689bd7bfd23aa72304bce0b77140acf1a8c229972178f`. Older downloads declare `aru-field-heuristics-1` and replay against [the frozen v1 source](../tools/field-model-v1.js), SHA-256 `a36dd8b2f577f9c1010df1b79ad17861c2c421e6667b075841467743d2cd3039`. The verifier checks these digests before evaluating old receipts. New downloads declare v3. Exact score consistency does not establish file authenticity or human benefit.
