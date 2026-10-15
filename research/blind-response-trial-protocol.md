# Blind response trial protocol

## Question

For this scripted response layer, do readers prefer the response that used earlier context over the response generated without earlier memory? Preference is a human judgment about usefulness for a specific prompt. It is separate from the app's modeled μ score.

## One trial

1. Write 1–8 context lines (up to 500 characters per line) and one final prompt (up to 500 characters). Keep them non-sensitive if the result will be shared.
2. Open **Blind response trial** in the inspector and run the pair. The app starts both branches at μ = 0.6400 with a fixed clock. Both receive the same context in order. The control carries its score forward but discards prior memory and messages before every step. Only the other branch carries prior history.
3. Ask a reader who did not write the context to choose A, B, or tie/neither based on which response is more useful for the final prompt. Do not reveal the branch assignments or modeled scores until the choice is submitted. The response content itself may give clues about the branch, so this hides labels rather than guaranteeing complete blinding.
4. Reveal the assignment and download the JSON if the trial may be audited. Nothing is saved automatically. The report contains the full entered text and the rating.
5. Run `node tools/verify-blind-trial.cjs /path/to/aru-blind-response-trial.json` from a local checkout to recompute both score receipts and response strings. A changed context, score, or response fails. The verifier cannot authenticate the rating, randomization, person, or original file.

For a set of exported reports, run `node tools/analyze-blind-trials.cjs /path/to/trials/*.json` (or add `--json` before the paths for a machine-readable summary). Supply every completed trial. The analyzer checks each report with that verifier before counting it and stops without a partial scorecard if one fails. It reports history wins over all reports, control wins, ties, the history fraction among non-ties, and outcomes split by whether history appeared in A or B. A zero non-tie denominator is explicitly undefined. Byte-identical reports are counted and flagged, because separate ratings can produce identical files; deduplicating them automatically would erase possible participants. The dataset SHA-256 fingerprints the multiset of supplied file bytes, independent of file order. It is not a signature or proof of collection. Each file is limited to 1 MiB; the tool accepts up to 100 files and 16 MiB in total.

## A credible pilot

Before collecting ratings, publish a fixed set of prompts, a rule for choosing context, a target number of independent readers, and the primary outcome: the fraction choosing the history response among **all** rated trials, with ties shown separately. Keep every completed trial, including control wins and ties. Avoid selecting examples based on their μ difference or after seeing a reader's choice. A person should not rate the same prompt twice, and authors should not rate their own prompts. Report the raw counts for history wins, control wins, and ties, with the denominator and prompt set; include uncertainty intervals if making a broader claim. Inspect whether an apparent advantage survives prompts where history is unrelated or misleading.

The app only provides one local trial at a time. The batch tool calculates descriptive counts for supplied files; neither component collects participants, enforces the pilot procedures, estimates a population effect, or authenticates JSON. Even different file hashes do not establish distinct readers, and reported positions do not prove randomization. An independently run study would need consent and a separately managed data collection process. The included synthetic examples and software tests do not measure a human preference or establish a commercial benefit.
