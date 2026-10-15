# Independent v2 score differential challenge

The browser's proof verifier replays the JavaScript score model from `index.html`. This challenge adds a separately written Python 3.12 implementation of the v2 formulas. It evaluates identical inputs, starting scores, timestamps, memory records, and prior user messages in both languages, then compares the seven named terms, delta, result, and clamp flag. The Python implementation does not import the JavaScript scoring functions.

From the repository root:

```bash
python3 tools/differential-field-v2.py --seed 20261015 --runs 2000
python3 tools/differential-field-v2.py --seed 20261015 --runs 2000 --json
```

The committed CI seed checks **2,016 cases**: 16 fixed boundary probes plus 2,000 deterministic generated cases. Fixed probes include `misremember`, `untruth`, `nevermore` after `always`, actual `never`, punctuation repetition, compatibility Unicode, combining marks, nine and nineteen words, clamps, and the memory and message windows. Generated cases vary score, word combinations, punctuation, case, age, weight, prior messages, and memory lengths. The comparison allows an absolute numeric difference of `1e-10` for floating-point behavior across languages; labels and clamp flags must match exactly. Before running, a deliberate `+0.001` mutation of a reference term checks that the comparator reports a difference.

The [committed JSON report](example-score-differential-report.json) records seed, case counts, tolerance, result, mutation-probe outcome, and SHA-256 hashes of both local source files. CI regenerates and compares it byte for byte. On a mismatch, the command exits nonzero and prints the first synthetic input, state, and both receipts as a reproducible counterexample. Change `--seed` to explore other deterministic cases; `--runs` accepts 1–2,000.

**Scope:** This establishes agreement between two implementations of the one-step scoring function for the tested software states. It does not independently replay the memory update function or full trajectories. Both implementations were written for the same hand-authored rules and can share a bad premise or omitted behavior. Generated phrases are synthetic, not representative user data. The challenge does not test the Canvas, browser storage, fact ledger, consciousness, physical fields, human benefit, or empirical validity. V1 legacy proofs are checked separately by their archived verifier and fixtures.
