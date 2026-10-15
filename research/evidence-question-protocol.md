# Sourced question challenge

This challenge tests a small, deterministic question interface over the browser-local evidence ledger. It recognizes `What is [name]?` and `What is my [name]?`, including `What's` and case/space variants. It matches normalized fact names only. It never consults the freeform field messages or a model trained on outside information.

Use a fresh browser state or erase local state between independent rows. Open **Evidence memory**, record the named facts, enter the question in **Ask what is recorded**, and select **Ask with sources**.

You can also enter the same question in the main composer and select **Ask recorded facts**. This uses the same exact-name resolver and displays the same answer or refusal without changing the freeform score, messages, or storage. **Review sources & receipt** copies the current question to the evidence panel, where its existing receipt buttons apply. An edited question or ledger invalidates the quick result; the simulation send arrow remains a separate action.

| Recorded facts | Question | Expected result |
| --- | --- | --- |
| `favorite color` = `teal` | `What’s my FAVORITE  COLOR?` | Return `teal`, local source #1, and the user-assertion caveat. |
| `favorite color` = `teal` | `What is my favorite color and my age?` | No exact name; no answer. |
| `favorite color` = `teal` | `Who knows my favorite color?` | Unsupported question form; no answer. |
| `favorite color` = `teal`; `my favorite color` = `amber` | `What is my favorite color?` | Ambiguous between two stored names; no answer. **Recall by name** can ask for either exact name. |
| `favorite color` = `teal`; `favorite color` = `amber` | `What is my favorite color?` | Conflicting current sources #1 and #2; no answer. |
| Previous row, then explicitly select source #1 | Same question | Return `teal`, source #1; source #2 remains superseded. |
| Previous row, then delete selected source #1 | Same question | Only superseded records remain; no answer. |

The regression suite runs these cases in `tests/field.test.cjs`, including a source from a merged evidence file and entered markup rendered as text. Asking makes no storage writes or score changes. A ledger edit clears a displayed answer so the old value cannot appear current without asking again.

This is constrained parsing, not natural-language understanding. It does not infer synonyms, answer questions with multiple names, verify whether a user assertion is true, or authenticate a local source ID. These cases establish behavior on the specified challenges; they do not measure general question-answering performance or a human benefit.
