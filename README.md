# ĀRU Remembrance Field

**An interactive browser simulation of memory-field and coherence dynamics.**

[![Release](https://img.shields.io/github/v/release/aruintelligence/aru-remembrance-field?style=for-the-badge)](https://github.com/aruintelligence/aru-remembrance-field/releases/latest)
[![Live demo](https://img.shields.io/badge/Open-Live_Demo-06b6d4?style=for-the-badge)](https://aruintelligence.github.io/aru-remembrance-field/)
[![License: MIT](https://img.shields.io/badge/License-MIT-16a34a?style=for-the-badge)](LICENSE)
[![Research status](https://img.shields.io/badge/Status-Experimental-f59e0b?style=for-the-badge)](#research-scope)

Created by **Daniel Jacob Read IV** and stewarded by **ĀRU Intelligence Inc.**

> **Research scope:** This project is a symbolic, visual simulation. Its field variables and named states are software constructs, not measurements of consciousness, intelligence, psychology, or physical reality.

[![ĀRU Remembrance Field live simulation](assets/remembrance-field-preview.jpg)](https://aruintelligence.github.io/aru-remembrance-field/)

*The live field visualization. Select the image to open the interactive simulation.*

## What it demonstrates

The interface lets a visitor enter a remembrance, declaration, or question and observe a client-side visual system respond. It explores:

- A 72 × 72 animated scalar field
- A motion control that shows a static field for reduced-motion preferences, pauses work in hidden tabs, and caps active drawing at 30 frames per second
- A modeled coherence state
- Persistent browser state through `localStorage`
- An optional session-only switch that keeps new entries and score changes out of browser storage
- A reviewed full-state backup and restore for moving the simulation between browsers
- Threshold-driven visual transitions, including “dragon ignition”
- A response layer framed by Inward Physics™ concepts
- A dependency-free, inspectable browser implementation
- An in-app receipt for each modeled score change and a local JSON export
- A memory ablation lab that previews the same draft with and without prior history
- A full-sequence challenge that evolves separate with-history and no-history scores from a clean baseline
- A one-click three-control challenge with positive, neutral, and negative memory effects and a verifiable report
- A portable one-step proof capsule that can be recomputed from a local checkout
- A separate evidence ledger for exact-name fact recall, source IDs, conflicts, explicit resolution, and shareable cited-answer excerpts
- A composer action for asking recorded facts with sources, without changing the simulation score

“Remembrance,” “coherence,” “Eternal Quartz,” and “dragon ignition” are conceptual names within the prototype. They do not imply autonomous awareness or empirically validated physical mechanisms.

## Try it

Open the [live demonstration](https://aruintelligence.github.io/aru-remembrance-field/).

To run a local copy:

```bash
git clone https://github.com/aruintelligence/aru-remembrance-field.git
cd aru-remembrance-field
open index.html
```

On Windows, double-click `index.html`. No build step or server is required for the core experience.

The **Visual motion** switch stops the Canvas update loop when set to off. It follows your device's reduced-motion setting until you choose a different state with the switch. The field stays visible and still responds with a static image when you submit text. Hidden tabs also stop visual work. [Motion checks](research/visual-motion-protocol.md) describe the behavior and its limits.

## Inspect a transition

Open **Inspect model state and last change** after submitting text. The panel shows the previous modeled μ, the summed change, the new value, and each term in the calculation. Each term is visible even when its contribution is zero. The score is limited to the range 0.35–0.995.

The rules are fixed in `evaluateCoherence` in `index.html`: whole Unicode word matches for a short list of words, token-count bonuses, an intent bonus or penalty, overlap with earlier memory, contradiction and repetition penalties against earlier entries, and baseline drift. They are hand-written heuristics, not learned weights or a validated measure. The submitted text is evaluated **before** it enters the message and memory history, so a first entry cannot match itself or count as its own repetition. For example, on a fresh browser state, submitting `What?` changes μ from 0.6400 to 0.6362: +0.0100 for a question and −0.0138 for baseline drift, with zero prior-memory and repetition terms. [Score rules v2](research/whole-word-v2-protocol.md) shows counterexamples and how to replay both rule versions.

Entries and the score are saved in this browser's `localStorage`. The panel can download a JSON copy, including text you entered, restore it in another browser, or erase this app's local state. The app does not send entries to a server. Browser settings, extensions, or the device's other users may still affect local privacy, and clearing site data also removes the saved state. The separate evidence ledger also has its own portable merge import.

Turn on **Session-only** above the simulation before entering text you do not want saved. New messages, memory, scores, proof copies, and evidence records work during that page session but are not written to browser storage. Earlier saved state remains on the device and can still affect this session's score and answers. Leaving session-only mode asks before discarding its unsaved changes and reloads the earlier saved state; reloading or closing the page also discards them. An explicit JSON download contains current session text, so save or share one only deliberately. The explicit erase controls can still remove stored data. Full-state restore is unavailable while session-only mode is on. This switch does not prevent browser extensions, device software, or someone with access to the open page from observing text.

For a full restore, choose **Restore local state JSON** in the inspector and review the current and incoming score, memory, message, and evidence counts. **Replace with reviewed state** asks for confirmation before replacing this browser's modeled state, history, and evidence ledger. Download the current state first if you may need it: replacement does not merge entries. Version 1 full-state exports, including earlier downloads, are supported within the limits of 4 MiB per file, 256 KiB per memory or message text, 100 memories, 160 messages, and 100 evidence records. Invalid files are rejected before any write. If browser storage rejects a write, the app attempts to restore the previous stored keys and reports if rollback fails. A browser crash during the multi-key write is outside that guarantee. The downloaded file may contain sensitive text; anyone with a copy can edit it, so restore only files you trust. Derived memory tokens are rebuilt from text under the current model rules; the old transition display and proof copy are cleared because their provenance cannot be established by importing a file. Keep a separately downloaded proof if you need it. A local edit after preview requires a fresh preview.

## Test the memory claim

Open **Inspect model state and last change**, write a draft in the input area, and select **Compare draft without saving**. The panel calculates the next score and response twice, starting from the same current μ and timestamp. The control withholds earlier stored memory and user messages. It does not erase, submit, or change your draft. The two response previews use the same template and differ only through the score and memory-dependent themes and echoes. Editing the draft clears an older comparison.

After a normal submission, the last-change receipt also shows the matched control score and the immediate history effect (`with history − without history`). At the floor or ceiling, clamping can hide a difference between the underlying terms. This is a **one-step software ablation**: because both branches start from the already accumulated μ, it does not estimate a whole alternate lifetime of the field. The JSON export includes that control receipt.

The [ablation protocol](research/ablation-protocol.md) lists exact positive, negative, and contradiction probes, including expected numbers and limits on interpretation. These probes establish observable properties of the code, not a scientific validation of the project's broader theory.

For an independent code-level check of the v2 score, run `python3 tools/differential-field-v2.py --seed 20261015 --runs 2000`. A separately written Python implementation compares all seven score terms, delta, final μ, and clamp decision with the browser's JavaScript across 16 fixed and 2,000 generated cases. CI repeats this [differential challenge](research/score-differential-protocol.md). Agreement checks implementation consistency under these inputs; both implementations can still share a mistaken specification.

## Challenge the full sequence

Open **Full-sequence memory challenge** inside the inspector. Enter 2–24 lines, one input per line, and select **Run sequence**. Two independent scores start at μ = `0.6400`: one branch stores each earlier input as memory and a user message, while the control clears both histories at every step. The same fixed one-second clock and input order are used in both branches. The table shows both scores and their difference after each step. This is a fresh synthetic sequence, not a replay of your existing browser history, and it does not change the saved field, messages, or evidence ledger.

For example, `violet river` on two lines ends at `0.67938` with history and `0.61260` without it. `amber comet` followed by `violet river` has zero difference; `always` followed by `never` has a `−0.03000` difference. These are deterministic results of the scripted rules. The [trajectory protocol](research/trajectory-protocol.md) gives the exact controls and limits.

Select **Run three controls** in the same panel to run repeated, unrelated, and contradictory two-step sequences together. The table labels the observed result for each; the three cases should have positive, zero, and negative history effects respectively. It leaves your saved score, text, and ledger alone. **Download challenge report JSON** records all terms and outcomes. To replay its fixed inputs and verify each score from a local checkout:

```bash
node tools/verify-memory-challenge.cjs /path/to/aru-memory-challenge.json
```

Try the public [synthetic challenge report](research/example-memory-challenge.json) with that command. The verifier also rejects a missing or relabeled control, changed inputs, altered scores, or the wrong direction. These hand-picked controls demonstrate specific behaviors of the scripted rules. They do not measure real-world memory, consciousness, or usefulness.

Select **Download trajectory proof JSON**, then check the receipt from a local checkout:

```bash
node tools/verify-trajectory.cjs /path/to/aru-remembrance-trajectory-proof.json
```

The repository includes [v1](research/example-trajectory.json) and [v2](research/example-trajectory-v2.json) synthetic examples for a no-private-data check. The verifier selects the rules named by `model_revision` and recomputes every step and term, rejecting changed inputs or results. It checks internal consistency only: the file can be edited and recomputed by someone else. The sequence stays in the page until edited or closed; only an explicit download makes a proof file containing your lines.

## Verify a submitted transition

After submitting text, select **Download last proof JSON** in the inspector. The file captures the input, timestamp, starting score, the exact prior memories and user messages used by the scoring rule, and both score receipts. In a local checkout, run:

```bash
node tools/verify-proof.cjs /path/to/aru-remembrance-transition-proof.json
```

To try it without entering private text, run `node tools/verify-proof.cjs research/example-proof-v2.json`. It should report `0.62624` with and without history: `nevermore` is not the word `never`, so prior `always` does not trigger a contradiction. The [v1 example](research/example-proof.json) still reports `0.72624` with history and `0.62624` without it. Existing downloaded v1 proof and trajectory files remain verifiable using the frozen [v1 model source](tools/field-model-v1.js); new downloads use v2. Reloading a browser with saved memory recalculates its derived tokens under v2.

The verifier recalculates every score term against the repository's model source and exits with a failure if the recorded result disagrees. This checks **internal consistency**, not the authenticity of a downloaded file: someone who edits both its inputs and results can create a different consistent file. It is not a claim of scientific validation. Proof files contain your current input and up to 22 earlier memory texts and five prior user messages. They are saved locally, replaced by the next submission, and included in the full state export. Select **Erase proof copy** to remove that extra local copy without erasing the main memory; **Erase local state** removes everything. A 16 MiB limit protects the command-line verifier from oversized files.

## Evidence memory: recall with sources

Open **Evidence memory**, enter a fact name such as `favorite color` and a value such as `teal`, then select **Record fact**. Entering `FAVORITE  COLOR` and selecting **Recall by name** retrieves the recorded value and its local source number. Matching ignores case, repeated spaces, and Unicode compatibility forms in the *name*; it does not infer synonyms or the meaning of prose.

The **Ask what is recorded** box also accepts the narrow forms `What is favorite color?` and `What is my favorite color?` (including `What's`). It removes the question wrapper and looks for exact normalized names in the ledger. If both `favorite color` and `my favorite color` are recorded, the second question is ambiguous and returns no answer. Unknown names, unsupported wording, conflicting current values, and names with only superseded sources also return no answer. A successful answer cites the local source number and labels the value as a user assertion. Asking does not change the modeled score, messages, or storage; changing the ledger clears the old answer. The [question challenge](research/evidence-question-protocol.md) lists reproducible cases.

The main composer now has **Ask recorded facts** beside the simulation send button. Enter the same narrow question there and choose that action for an immediate sourced answer or a clear refusal. It does not submit text to the score or store a chat message. **Review sources & receipt** opens the evidence panel with the same question, where you can inspect records and download a cited answer excerpt or full receipt. Editing the question or ledger invalidates the quick result. The send arrow still runs the symbolic simulation; it does not claim to retrieve a fact.

You can also run a [labeled evidence challenge](research/evidence-benchmark-protocol.md) against the same recall functions from a local checkout:

```bash
node tools/benchmark-evidence.cjs research/evidence-challenge.json
node tools/benchmark-evidence.cjs --json /path/to/your-challenge.json
```

The included synthetic challenge checks 12 answer and refusal cases; each report shows correct answers, abstentions, unsafe answers, and source citations. A mismatch fails the command and the repository's CI. The JSON mode records case outcomes plus challenge and model hashes. Bring independently written cases to probe the boundary; a passing hand-authored sample is a regression check, not evidence of real-world factual accuracy.

The [seeded falsification lab](research/evidence-falsification-protocol.md) probes the same rules with generated Unicode names, conflicting and superseded sources, irrelevant additions, changed record order, ambiguous questions, and refusals:

```bash
node tools/falsify-evidence.cjs --seed 20261015 --runs 2000
```

CI checks 26,000 deterministic properties across those 2,000 cases. A failed property prints a reproducible counterexample; a passing run means no violation was found within this synthetic generator's scope. It does not measure real-world accuracy or validate the field theory.

After selecting **Ask with sources**, a known answer offers **Download cited answer excerpt JSON**. It includes only the assertions cited for that answer, omitting unrelated ledger facts. You can also download a **full question receipt** for any answer or refusal; that file includes every ledger record. Both formats use the [portable receipt protocol](research/evidence-receipt-protocol.md) and the same local verifier:

```bash
node tools/verify-evidence-receipt.cjs /path/to/aru-evidence-question-receipt.json
```

Try the [synthetic excerpt](research/example-evidence-excerpt.json) and [full receipt](research/example-evidence-receipt.json) with that command. The excerpt contains the question and cited assertions, which may themselves be private. It cannot establish that no conflicting or ambiguous records were omitted. The full receipt may expose unrelated private facts. Editing the question or ledger disables both old downloads; asking and downloading do not add another copy to browser storage. Verification checks that the answer follows from the supplied records and local code. It does not establish completeness, authenticity, or factual truth.

If you record a different value under that name, the ledger displays a conflict and refuses to return a single answer. **Use # as current** explicitly selects a source and keeps earlier records marked superseded. A later conflicting entry reopens the conflict. **Delete #** removes an individual record; deleting the chosen source never silently restores an older assertion. The ledger stops at 100 records and asks you to delete one before adding more.

This is a separate, deterministic feature. Fact records do not affect the freeform score or its transition proof. They stay in this browser, are included in the full state export, and are removed by **Erase local state**. Source numbers refer only to user entries in this browser; they are not independent evidence that the entered value is true. The [evidence ledger protocol](research/evidence-ledger-protocol.md) gives the test cases and limits.

To move the ledger to another browser, select **Download evidence JSON**. On the other browser, choose that file under **Import evidence JSON**. The preview lists every incoming value and its new local source number; **Apply reviewed import** merges those records with the existing ledger. It never replaces a local assertion or silently resolves a conflict. An import that would exceed 100 entries or contains an invalid record is rejected in full. A local edit after preview requires a fresh preview. The file can contain sensitive assertions, so share it only deliberately. Imported records are marked as such, but a file or its source numbers can be edited by anyone who has access to it.

Run the small regression suite with Node.js:

```bash
node tests/field.test.cjs
node tests/benchmark.test.cjs
node tests/falsifier.test.cjs
```

These cover first and repeated input scoring, matched and unrelated memory controls, negative history effects, full-sequence controls, the three-control challenge and proof replay, draft non-mutation, single-step proof detection, exact-name recall, constrained sourced questions and composer abstention, conflicts and resolution, portable ledger merging and rejection, reviewed full-state restore and rollback, session-only non-persistence and restore blocking, full question receipts, privacy-scoped answer excerpts and invalidation, safe text display, corrupted saved data, local data controls, benchmark failure modes, and falsifier sensitivity to faulty behavior.

## Research question

What becomes visible when persistent memory, visual field dynamics, and an explicit coherence variable are treated as primary interface elements rather than hidden implementation details?

## Implementation

- HTML, CSS, JavaScript, and Canvas
- Client-side state and visualization
- No training pipeline
- No claim of general intelligence
- No clinical, spiritual, or scientific diagnostic purpose

Any network-assisted behavior depends on browser and third-party availability and should be treated as optional rather than a guaranteed capability.

## Evidence and limitations

The repository demonstrates implemented interface behavior and simulated state transitions. It does not establish that remembrance is a physical substrate, that the coherence score measures a real person or system, or that threshold transitions constitute emergence.

Independent replication, accessibility improvements, and careful counterexamples are welcome.

## Related work

- [ĀRU Intelligence public profile](https://github.com/aruintelligence)
- [ĀML Core](https://github.com/aruintelligence/aml-core)
- [Inward Mathematics Simulator](https://github.com/aruintelligence/inward-mathematics-simulator)
- [Inward Physics research archive](https://thefirstlawofinwardphysics.blogspot.com/)
- [Daniel Jacob Read IV — ORCID](https://orcid.org/0009-0000-6133-1872)

## Citation

Citation metadata is provided in [`CITATION.cff`](CITATION.cff).

## License

Released under the [MIT License](LICENSE). Remembrance First™, Inward Physics™, and associated project names may be claimed marks of ĀRU Intelligence Inc.
