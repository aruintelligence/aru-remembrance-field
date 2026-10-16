# Memory ablation protocol

This protocol tests a narrow, falsifiable behavior of the ĀRU Remembrance Field: whether the code's **next** modeled score depends on earlier browser history. It does not test consciousness, human memory, or a physical field.

## Intervention

For each input, run `evaluateCoherence` twice with the same starting μ and millisecond timestamp. The first run receives the prior memory records and messages. The control receives empty memory and messages. Compare the resulting *clamped* scores (`with history − without history`). Both evaluations are pure; the browser's saved state changes only when the visitor submits the input normally.

The response previews follow the same intervention: they use each branch's resulting μ and the corresponding prior memory. A normal submission first evaluates and renders its response from prior history, then adds the current input to history. This prevents self-matching.

## Fixed probes

Use starting μ = `0.64` and timestamp `1700000000000` milliseconds. Each row is a separate fixture, not a sequence. The matched memory record has tokens `["violet", "river"]`, weight `2`, and that same timestamp. The contradiction fixture contains the prior memory text `always` and one prior user message `never`.

| Probe | Current input | Prior history | With history μ | Without history μ | Effect |
| --- | --- | --- | ---: | ---: | ---: |
| Positive | `violet river` | Matching memory record | 0.72624 | 0.62624 | +0.10000 |
| Negative control | `amber comet` | Same matching memory record | 0.62624 | 0.62624 | 0 |
| Adversarial rule | `never` | `always` memory and `never` user message | 0.55124 | 0.61124 | −0.06000 |

The positive probe's overlap term is `1 × 2 × 0.05 = 0.10`. All three rows include the baseline drift `−(0.008 + 0.64 × 0.009) = −0.01376`. The adversarial probe includes a `−0.015` intent term, a `−0.03` contradiction term, and a `−0.03` repetition term. The comparison therefore shows when prior history raises, leaves unchanged, or lowers this particular model score.

## Reproduce and challenge

Run `node tests/field.test.cjs` from the repository root. The fixed probes use a frozen timestamp and explicit in-memory fixtures. The test suite also checks that a draft comparison makes no storage writes, does not change the draft or score, and escapes restored text in response previews. In the [live demo](https://aruintelligence.github.io/aru-remembrance-field/), enter a phrase, submit it, then type that phrase again and use **Compare draft without saving** to inspect the immediate effect for your own state.

For a submitted transition, download its proof capsule and run `node tools/verify-proof.cjs /path/to/proof.json`. The capsule's `prior_memory` contains the last 22 records: enough for the score's 22-record overlap and 10-record contradiction and direct negation rules. Its `prior_user_messages` contains the last five user messages used by the repetition rule. The verifier recalculates all eight v3 terms in both branches at the recorded timestamp and checks the score, clamp, and difference. It selects the model revision named in the capsule, so retain that revision when archiving it. The capsule can be edited and recomputed; passing verification does not authenticate its origin or prove the broader theory.

The repository includes synthetic [v1](example-proof.json), [v2](example-proof-v2.json), and [v3](example-proof-v3.json) receipts so independent readers can run the verifier without providing personal data. CI runs all three alongside the regression suite. Their declared `model_revision` selects the appropriate scoring rules.

Counterexamples matter. Unrelated words should have no overlap effect. V2 and v3 match complete Unicode words: `nevermore` does not trigger the `never` contradiction against `always`; actual `never` does. [V3](direct-negation-v3-protocol.md) additionally flags `not teal` against prior `teal`. The archived v1 rules used substring matches. A threshold clamp can make the displayed effect zero even when unclamped terms differ. The contradiction and negation rules are literal word checks; they do not understand semantic contradiction. Response text is scripted and can change because a score crosses a display threshold, without any learned language understanding.

The one-step ablation holds the *current* score fixed. Since that score may already reflect past inputs, this particular comparison cannot identify the effect of removing all historical memory from inception. The separate [full-sequence challenge](trajectory-protocol.md) starts both branches at the same clean baseline and evolves them independently across user-chosen inputs. Neither experiment establishes a measurable benefit in a human task. That requires task-specific outcomes, blinded evaluation, and independent replication.
