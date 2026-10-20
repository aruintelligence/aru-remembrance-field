import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recallMemories } from "../capsule/core.mjs";

const benchmark = JSON.parse(readFileSync(new URL("./fixtures/capsule-retrieval-benchmark.json", import.meta.url), "utf8"));

test("hand-labeled fictional questions preserve ranking, abstention, and source evidence", t => {
  const { capsule, cases } = benchmark;
  assert.equal(cases.length, 30);
  const counts = { top1: 0, partial: 0, no_match: 0, insufficient_question: 0 };
  for (const item of cases) {
    const result = recallMemories(capsule, item.question);
    assert.equal(result.kind, item.kind, item.question);
    if (item.kind !== "matched") {
      assert.deepEqual(result.matches, [], item.question);
      counts[item.kind]++;
      continue;
    }
    assert.equal(result.matches[0]?.id, item.top_id, item.question);
    assert.deepEqual(result.matches[0].unmatchedTerms, item.top_unmatched, item.question);
    counts.top1++;
    if (item.top_unmatched.length) counts.partial++;
    assert.ok(result.matches.length <= 3, item.question);
    for (const match of result.matches) {
      const source = capsule.memories.find(memory => memory.id === match.id);
      assert.ok(source, `${item.question}: source exists`);
      assert.equal(match.story, source.story, `${item.question}: story is verbatim`);
      const sourceWords = new Set(`${source.title} ${source.when} ${source.story}`
        .normalize("NFKC").toLocaleLowerCase("en").match(/[\p{L}\p{N}]+/gu));
      for (const word of match.matchedTerms) {
        assert.ok(sourceWords.has(word), `${item.question}: ${word} appears in the source`);
      }
      for (const word of match.unmatchedTerms) {
        assert.equal(sourceWords.has(word), false, `${item.question}: ${word} is absent from the source`);
      }
    }
  }
  t.diagnostic(`30/30 labeled outcomes: ${counts.top1} top-source checks, ${counts.partial} partial flags, ` +
    `${counts.no_match} no-match refusals, ${counts.insufficient_question} vague-question refusals.`);
});
