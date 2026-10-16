# Score rules v3: direct correction counterexample

## Failure and rule

The archived v2 score could reward a correction for sharing words with the claim it corrected. With prior memory `favorite color teal`, input `My favorite color is not teal.` earned positive overlap even while the response renderer withheld the old phrase. This made the displayed μ move in the wrong direction for that narrow example. V3 applies the response renderer's direct polarity test to scoring: a prior memory with a shared word that appears immediately after `not` in exactly one of the two texts earns **no overlap**. If at least one of the last ten memories has such a mismatch, the named **Direct negation rule** adds `−0.03` once. No memory entry is deleted.

The test checks normalized Unicode words, not sentence meaning. For example, `notably teal` does not negate `teal`. The rule can miss `no longer teal`, `actually blue`, or a paraphrase, and can flag unrelated uses of a shared word. The last 22 memories contribute potential overlap while the last ten are checked for the penalty. A conflicting entry older than ten may still have its overlap suppressed without the penalty. Clamping can hide a nonzero term in the displayed score. This is a transparent heuristic, not a truth detector.

## Reproduce the counterexample

The [v3 one-step proof](example-proof-v3.json) fixes μ at `0.64000`, the clock at `1700000001000`, and the prior memory and input. In that exact state the frozen v2 evaluator assigns `+0.07500` overlap and ends at `0.70124`; v3 assigns zero overlap, `−0.03000` direct negation, and ends at `0.59624`. Both use the same `0.62624` no-history control. The [v3 trajectory](example-trajectory-v3.json) starts from a clean baseline and submits both lines in order: it ends at `0.58260` with history and `0.61260` without history. These different starting states explain the different final numbers.

From the repository root:

```bash
node tools/verify-proof.cjs research/example-proof-v3.json
node tools/verify-trajectory.cjs research/example-trajectory-v3.json
node tools/verify-memory-challenge.cjs research/example-memory-challenge-v3.json
node tools/verify-blind-trial.cjs research/example-blind-trial-v3.json
node tools/analyze-blind-trials.cjs --plan research/example-blind-trial-plan-v3.json research/example-blind-trial-v3.json
python3 tools/differential-field-v3.py --seed 20261015 --runs 2000
```

The four-control challenge adds the direct correction to repetition, unrelated context, and literal contradiction. The separately written Python scorer agrees with JavaScript on 21 fixed and 2,000 generated one-step cases, including corrections in either direction. The synthetic blind trial has a tie rating; its v2 predecessor scores history above control (`0.68518` versus `0.61260`) while v3 scores it below control (`0.58260` versus `0.61260`). These are deterministic software counterexamples and consistency checks, not measurements of readers or a claim of commercial value.

## Replay boundaries

New downloads declare `aru-field-heuristics-3`. The local CLI replays v1 and v2 files with hash-pinned [v1](../tools/field-model-v1.js) and [v2](../tools/field-model-v2.js) sources. The live browser verifies only current v3 score proofs and accepts only v3 fixed trial plans. The batch analyzer refuses mixed score or response revisions, because a changed scoring rule changes the meaning of its score direction. A valid receipt proves consistency with the supplied inputs and source revision; it cannot authenticate its author, establish that a reader rated a response, or validate the modeled field as a physical phenomenon.
