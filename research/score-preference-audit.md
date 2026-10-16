# Score versus reader preference audit

The blind trial asks a person to choose the more useful scripted response before seeing its condition label or modeled μ score. The batch analyzer now checks a separate, falsifiable question: **when one branch ends with a higher μ, does the recorded choice favor that branch?** Both branch scores evolve across the preceding context, so their final difference is not a measure of the last response's quality. This is an audit of the score's relationship to preferences in the supplied files, not a new score rule.

Run `node tools/analyze-blind-trials.cjs --plan plan.json trials/*.json` after collecting all planned ratings. The tool first replays each report's two score receipts and response strings. It rejects invalid reports, missing or excess planned ratings, mixed score or response revisions, and unplanned prompts before printing any scorecard. Then it groups each report by the sign of `with_history.score.after − without_history.score.after` (within `1e-10` is equal) and by the recorded history, control, or tie choice. The JSON `diagnostics` object contains the full three-by-three counts. For a fixed plan, each case ID also shows its score direction and how many decisive ratings aligned with or opposed that direction.

`decisive_score_choice_agreement` includes a report only when μ differs **and** the recorded choice is not a tie. Equal μ and reader ties are still counted in the three-by-three table and primary outcome. An aligned choice is not proof that the response is correct; an opposed choice is a candidate counterexample to treating a higher μ as a proxy for usefulness. The model never claimed to measure human preference, so inspect these disagreements rather than dropping them.

The primary preference fraction is still `history wins / all supplied ratings`, with ties in the denominator. Its reported 95% Wilson score interval uses `z = 1.959963984540054`, `n = all ratings`, and `x = history wins`. For `p = x/n`, the interval is `(p + z²/(2n) ± z√(p(1−p)/n + z²/(4n²))) / (1 + z²/n)`, clipped to `[0,1]`. This interval assumes independent Bernoulli ratings. Repeated readers, shared prompts, convenience sampling, missing submissions, or editable duplicate files weaken a population interpretation. It does not adjust for dependence within a planned case, selection bias, multiple analyses, or unauthenticated choices.

## Check whether one prompt drives the result

For a complete fixed plan, `plan.sensitivity.equal_case_history_win_fraction_all` averages each case's `history wins / received ratings`, with ties in each denominator. Each case gets one share of this diagnostic regardless of its number of ratings. `largest_case_rating_fraction` is the largest case's rating count divided by all ratings. `leave_one_case_out_equal_case_range` gives the minimum and maximum equal-case fractions after omitting each case in turn; it is `null` for a one-case plan. These are descriptive checks, **not** confidence intervals or replacements for the plan's primary all-ratings fraction. A difference between pooled and equal-case fractions flags sensitivity to the plan's rating allocation; a wide omission range flags sensitivity to particular prompts. Equal weighting cannot repair selective submission, repeated readers, or poor choice of prompts.

The test `node tests/blind-analyzer.test.cjs` includes a deliberately imbalanced synthetic plan: eight identical history choices on one prompt, one control choice on another, and one tie on a third. The primary pooled fraction is `8/10 = 80%`, whereas the equal-case fraction is `(1 + 0 + 0)/3 = 33.3%`; the largest case supplies 80% of ratings and the leave-one-case-out range is 0–50%. This checks that an apparently strong pooled outcome is exposed as prompt-sensitive. The choices are fabricated software test data, not observations from readers.

## Reproduce an audit counterexample

The [synthetic v2 report](example-blind-trial-v2.json) has a history score of `0.68518` and control score of `0.61260` for a negated color prompt, but its recorded choice is deliberately `tie`. To check that an opposed choice is surfaced, create a **synthetic test copy** with B selected (B is the control in this fixture):

```bash
node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync("research/example-blind-trial-v2.json","utf8"));r.choice="B";fs.writeFileSync("/tmp/aru-synthetic-score-opposition.json",JSON.stringify(r));'
node tools/analyze-blind-trials.cjs /tmp/aru-synthetic-score-opposition.json
```

The output should say modeled score higher with history: one control choice, and aligned `0/1`, opposed `1/1`. This demonstrates that the analyzer exposes disagreement. The B choice was fabricated for a software test. It is **not** a human judgment or evidence of model failure in real users. A real pilot needs independently collected ratings, a prespecified plan, all completed reports, and scrutiny of the cases where ratings and μ diverge.

The same context and prompt in the [v3 synthetic report](example-blind-trial-v3.json) end at `0.58260` with history versus `0.61260` without it. Its tie rating remains synthetic. This change of score direction demonstrates that a batch must not combine model revisions; it does not imply any change in human preferences.
