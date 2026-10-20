# Remembrance Capsule · retrieval check

The reader searches the written title, date label, and story in a decrypted gift. It never generates a new answer. Each result shows the actual story, the query words found in that story or its title/date, and any question words missing from that result. If every result is partial, the reader says so. A match is a lead to read, not proof that the story answers the question.

## Reproduce

From the repository root:

```bash
node --test tests/capsule-retrieval-benchmark.test.mjs
```

The complete fictional capsule, 30 questions, expected result kinds, expected first source, and expected missing words are in [`tests/fixtures/capsule-retrieval-benchmark.json`](../tests/fixtures/capsule-retrieval-benchmark.json). The labels are fixed in that file; the test runs the production `recallMemories` function against them. It also checks that returned story text is verbatim from the fixture and every displayed matched word occurs in the cited source.

## Observed result on this release

| Check | Correct / cases |
| --- | ---: |
| Expected first source for answerable or partial queries | 22 / 22 |
| Expected missing-word flags within those queries | 22 / 22 (including 5 partial queries) |
| No-match refusals | 4 / 4 |
| Vague-question refusals | 4 / 4 |
| Source and matched-word provenance | All returned cards in these 30 cases |

This is a small, hand-authored regression set, not an independent evaluation or a claim about real-world accuracy. The questions use mostly exact English words from the fictional stories. Paraphrases, synonyms, speech recordings, and implied facts are outside the matcher. A partial result can be useful while still failing to answer the reader's question. New story sets and blind human review are needed before claiming broader retrieval quality.
