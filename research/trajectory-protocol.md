# Full-sequence memory challenge

This experiment measures a defined property of the scripted ĀRU score over a controlled sequence. Both branches start at μ = `0.6400`. Each receives the same input on each step at a synthetic timestamp, beginning at `1700000000000` milliseconds and advancing exactly one second per step. The with-history branch stores each submitted input after scoring it, using the same memory update function as the live simulation. The control passes empty memory and messages into the scoring rule at every step. Each branch carries its *own* preceding score forward, so the final difference includes subsequent score drift and clamping effects.

The sequence does not read or write the browser's current score, messages, memory, evidence ledger, or storage. Automated reflections, visual effects, and response copy are outside this score-only experiment.

## Fixed controls

Start each row from a fresh μ of `0.6400` with the fixed clock. Enter one phrase per line in **Full-sequence memory challenge**.

| Sequence | With-history final μ | No-history final μ | Difference | What it checks |
| --- | ---: | ---: | ---: | --- |
| `violet river` → `violet river` | 0.67938 | 0.61260 | +0.06677 | A match raises overlap, while a repeated user message also applies a penalty. |
| `amber comet` → `violet river` | 0.61260 | 0.61260 | 0 | Unrelated history does not change this score. |
| `always` → `never` | 0.55274 | 0.58274 | −0.03000 | A literal contradiction lowers the with-history score. |

The [synthetic five-step v1 receipt](example-trajectory.json) combines these challenges and ends at `0.57755` with history and `0.54256` without history. The [v2 receipt](example-trajectory-v2.json) probes `always` → `nevermore` → `never`: the middle step has no contradiction, while the last step does. Run `node tools/verify-trajectory.cjs research/example-trajectory-v2.json` from the repository root, or use the path to a downloaded receipt. The verifier selects the declared model revision, recalculates each term, step score, and final difference, and CI runs both synthetic receipts. A changed recorded input or score fails unless other fields are also edited to make a new consistent receipt.

## Interpretation

This is a deterministic software intervention on hand-written scoring rules, not a test of consciousness, a physical field, real-world memory accuracy, or usefulness to people. The no-history branch also withholds prior user messages, which drive the repetition rule. The fixed one-second clock is for repeatability, not an account of actual elapsed time. The receipts contain the entered lines and are not authenticated. A credible human benefit claim would require a separate task, outcomes, controls, and independent replication.
