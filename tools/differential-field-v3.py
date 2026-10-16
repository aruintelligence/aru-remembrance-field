#!/usr/bin/env python3
"""Compare the browser's v3 score to a separately written Python reference.

This checks deterministic software behavior, not a physical or human outcome.
The Python evaluator never imports the JavaScript scoring functions.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import subprocess
import sys
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
AT = 1_700_000_000_000
TOLERANCE = 1e-10
BONUSES = {
    "awareness": .04, "remember": .035, "remembrance": .04, "memory": .024,
    "sovereign": .024, "consciousness": .03, "truth": .024, "presence": .02,
    "ignite": .018, "witness": .02, "inward": .02,
}
TERMS = ["Matched word rules", "Length rule", "Intent rule", "Prior memory overlap",
         "Contradiction rule", "Direct negation rule", "Prior repetition rule", "Baseline drift"]


def words(text):
    normalized = unicodedata.normalize("NFKC", text).lower()
    found, current = [], []
    for char in normalized:
        if unicodedata.category(char)[0] in "LNM":
            current.append(char)
        elif current:
            found.append("".join(current))
            current = []
    if current:
        found.append("".join(current))
    return found


def tokens(text):
    return [word for word in words(text) if len(word) > 2]


def clean(text):
    return " ".join(words(text))


def direct_polarity_mismatch(current, stored):
    current_words, stored_words = words(current), words(stored)
    current_negated = {current_words[i + 1] for i in range(len(current_words) - 1)
                       if current_words[i] == "not"}
    stored_negated = {stored_words[i + 1] for i in range(len(stored_words) - 1)
                      if stored_words[i] == "not"}
    return any((word in current_negated) != (word in stored_negated)
               for word in set(tokens(current)) & set(tokens(stored)))


def memory(text, at=AT, weight=1):
    return {"text": text, "tokens": tokens(text), "weight": weight, "time": at}


def intent(text):
    sequence = words(text)
    padded = " " + " ".join(sequence) + " "
    has = lambda phrase: " " + phrase + " " in padded
    if "?" in text or "？" in text:
        return "question"
    if any(map(has, ("i am", "i feel", "i remember", "i know", "i believe", "this is"))):
        return "identity"
    if any(map(has, ("why", "how", "what if", "explain", "show", "help", "explore"))):
        return "exploration"
    if any(map(has, ("always", "never", "must", "cannot"))):
        return "absolute"
    return "fragment" if len(sequence) <= 4 else "statement"


def evaluate(case):
    text, state, at = case["input"], case["state"], case["at"]
    before = state["coherence"]
    current = set(words(text))
    text_tokens = tokens(text)
    history = state["memory"]
    labels_and_values = []

    # Keep rule order explicit so rounding and term attribution are testable.
    bonus = sum(value for word, value in BONUSES.items() if word in current)
    labels_and_values.append((TERMS[0], bonus))
    labels_and_values.append((TERMS[1], (.012 if len(text_tokens) > 8 else 0) +
                              (.016 if len(text_tokens) > 18 else 0)))
    labels_and_values.append((TERMS[2], {"question": .01, "exploration": .014,
                                        "absolute": -.015}.get(intent(text), 0)))

    overlap = 0
    for entry in history[-22:]:
        if direct_polarity_mismatch(text, entry["text"]):
            continue
        left, right = set(text_tokens), set(entry.get("tokens") or [])
        similarity = len(left & right) / max(len(left), len(right), 1)
        age_hours = max(0, (at - entry["time"]) / 3_600_000)
        overlap += similarity * (entry.get("weight") or 1) * math.exp(-age_hours / 42) * .05
    labels_and_values.append((TERMS[3], overlap))

    recent = [set(words(entry["text"])) for entry in history[-10:]]
    contradiction = 0
    for now_word, previous_word, cost in (("always", "never", .03),
                                           ("never", "always", .03),
                                           ("true", "false", .02),
                                           ("false", "true", .02)):
        if now_word in current and any(previous_word in entry for entry in recent):
            contradiction += cost
    labels_and_values.append((TERMS[4], -contradiction))

    direct_negation = any(direct_polarity_mismatch(text, entry["text"])
                          for entry in history[-10:])
    labels_and_values.append((TERMS[5], -.03 if direct_negation else 0))

    user_messages = [entry for entry in state["messages"] if entry["type"] == "user"][-5:]
    repeats = sum(clean(entry.get("text") or "") == clean(text) for entry in user_messages)
    labels_and_values.append((TERMS[6], -repeats * .03))
    labels_and_values.append((TERMS[7], -(.008 + before * .009)))

    delta = 0
    for _, value in labels_and_values:
        delta += value
    raw = before + delta
    after = max(.35, min(.995, raw))
    return {"before": before, "delta": delta, "after": after,
            "terms": [{"label": label, "value": value} for label, value in labels_and_values],
            "clamped": after != raw}


def fixed_cases():
    def case(name, text, coherence=.64, history=None, messages=None):
        return {"id": name, "input": text, "state": {"coherence": coherence,
                "memory": history or [], "messages": messages or []}, "at": AT}
    return [
        case("substring-remember", "misremember"),
        case("substring-truth", "untruth"),
        case("literal-remember", "remember"),
        case("nevermore-after-always", "nevermore", history=[memory("always")]),
        case("never-after-always", "never", history=[memory("always")]),
        case("direct-negation", "My favorite color is not teal.",
             history=[memory("favorite color teal", weight=2)]),
        case("reversed-negation", "favorite color teal",
             history=[memory("favorite color not teal", weight=2)]),
        case("unrelated-negation", "not blue",
             history=[memory("favorite color teal", weight=2)]),
        case("not-substring", "notably teal",
             history=[memory("favorite color teal", weight=2)]),
        case("direct-negation-window", "not teal",
             history=[memory("teal", weight=2)] * 11),
        case("all-contradictions", "always never true false",
             history=[memory("never always false true")]),
        case("punctuation-repetition", "rose-river",
             messages=[{"type": "user", "text": "rose river"}]),
        case("unicode-compatibility", "ＣＡＦÉ river", history=[memory("café river", weight=2)]),
        case("combining-mark", "cafe\u0301 river", history=[memory("café river", weight=2)]),
        case("fullwidth-question", "What？"),
        case("nine-words", " ".join(f"word{i}" for i in range(9))),
        case("nineteen-words", " ".join(f"word{i}" for i in range(19))),
        case("ceiling-clamp", "remember truth", .995,
             history=[memory("remember truth", weight=6) for _ in range(22)]),
        case("floor-clamp", "never", .35, history=[memory("always")]),
        case("history-window", "violet river", history=[memory("violet river", weight=2)] * 23),
        case("user-message-window", "rose river", messages=[{"type": "user", "text": "rose river"}] * 6),
    ]


def generated_cases(seed, runs):
    rng = random.Random(seed)
    vocabulary = ("remember", "misremember", "truth", "untruth", "never", "nevermore",
                  "always", "true", "false", "memory", "river", "violet", "rose",
                  "café", "ＣＡＦÉ", "記憶", "I", "am", "what", "if", "help", "ignite", "signal",
                  "not", "teal", "color", "favorite")

    def phrase():
        parts = [rng.choice(vocabulary) for _ in range(rng.randint(1, 21))]
        return rng.choice((" ", "-", " / ", "  ")).join(parts) + rng.choice(("", "?", "！"))

    cases = []
    for index in range(runs):
        text = phrase()
        at = AT + rng.randint(0, 500_000)
        history = []
        for _ in range(rng.choice((0, 1, 2, 4, 8, 23))):
            prior = rng.choice((text, "always", "never", "false", "café river", phrase()))
            offset = rng.choice((0, 3_600_000, 42 * 3_600_000, 200 * 3_600_000, -3_600_000))
            history.append(memory(prior, at - offset, rng.choice((.5, 1, 2, 4, 6))))
        messages = [{"type": rng.choice(("user", "user", "field")),
                     "text": rng.choice((text, "rose river", phrase()))}
                    for _ in range(rng.randint(0, 8))]
        coherence = rng.choice((.35, .36, .64, .9, .985, .995, rng.uniform(.35, .995)))
        cases.append({"id": f"generated-{index + 1}", "input": text,
                      "state": {"coherence": coherence, "memory": history, "messages": messages},
                      "at": at})
    return cases


NODE_EVALUATOR = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const {loadEvaluator} = require('./tools/verify-proof.cjs');
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!Array.isArray(cases) || cases.length > 2500) throw new Error('Invalid case count');
const model = loadEvaluator('aru-field-heuristics-3');
model.cases = cases;
const output = vm.runInContext('cases.map(c => evaluateCoherence(c.input, c.state, c.at))',
  model, {timeout: 10000});
process.stdout.write(JSON.stringify(output));
"""


def compare(expected, actual):
    if not isinstance(actual, dict):
        return "receipt is not an object"
    for field in ("before", "delta", "after"):
        value = actual.get(field)
        if type(value) not in (int, float) or not math.isfinite(value) or not math.isclose(
                expected[field], value, rel_tol=0, abs_tol=TOLERANCE):
            return f"{field}: Python {expected[field]!r}; JavaScript {value!r}"
    if type(actual.get("clamped")) is not bool or expected["clamped"] != actual["clamped"]:
        return f"clamped: Python {expected['clamped']}; JavaScript {actual.get('clamped')}"
    terms = actual.get("terms")
    if not isinstance(terms, list) or len(terms) != len(expected["terms"]):
        return "term count differs"
    for index, (left, right) in enumerate(zip(expected["terms"], terms)):
        if not isinstance(right, dict) or left["label"] != right.get("label"):
            return f"term {index} label differs"
        value = right.get("value")
        if type(value) not in (int, float) or not math.isfinite(value) or not math.isclose(
                left["value"], value, rel_tol=0, abs_tol=TOLERANCE):
            return f"{left['label']}: Python {left['value']!r}; JavaScript {value!r}"
    return None


def run(seed, runs):
    cases = fixed_cases() + generated_cases(seed, runs)
    known = evaluate(cases[0])
    corrupted = json.loads(json.dumps(known))
    corrupted["terms"][0]["value"] += .001
    if compare(known, corrupted) is None:
        raise AssertionError("differential comparator missed a deliberately corrupted term")
    process = subprocess.run(["node", "-e", NODE_EVALUATOR], cwd=ROOT, text=True,
                             input=json.dumps(cases, ensure_ascii=False), capture_output=True,
                             timeout=30, check=False)
    if process.returncode:
        raise RuntimeError(process.stderr.strip() or "JavaScript evaluator failed")
    actual = json.loads(process.stdout)
    if not isinstance(actual, list) or len(actual) != len(cases):
        raise RuntimeError("JavaScript result count differs")
    for case, result in zip(cases, actual):
        expected = evaluate(case)
        failure = compare(expected, result)
        if failure:
            raise AssertionError(json.dumps({"case": case, "difference": failure,
                                             "python": expected, "javascript": result},
                                            ensure_ascii=False, indent=2))

    html = (ROOT / "index.html").read_text(encoding="utf-8")
    start = html.index("function textWords(")
    end = html.index("/* ==================== PLASMA FIELD SIMULATION", start)
    return {"format": "aru-score-differential-report", "model_revision": "aru-field-heuristics-3",
            "seed": seed, "fixed_cases": len(fixed_cases()), "generated_cases": runs,
            "checked": len(cases), "mutation_probe": "detected", "absolute_tolerance": TOLERANCE,
            "result": "pass",
            "javascript_source_sha256": hashlib.sha256(html[start:end].encode()).hexdigest(),
            "python_reference_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=20261015)
    parser.add_argument("--runs", type=int, default=500)
    parser.add_argument("--json", action="store_true", help="print a machine-readable report")
    args = parser.parse_args()
    if not 1 <= args.runs <= 2000:
        parser.error("--runs must be between 1 and 2000")
    try:
        report = run(args.seed, args.runs)
    except (AssertionError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"PASS: {report['checked']} independent score comparisons "
              f"({report['fixed_cases']} fixed, {report['generated_cases']} generated); seed {args.seed}")
        print("This checks two implementations of scripted rules, not scientific validity or human benefit.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
