#!/usr/bin/env python3
"""Compare the browser's evidence briefs with an independent exact-name oracle.

This tests deterministic software behavior, not source authenticity or factual truth.
"""

import argparse
import hashlib
import json
from pathlib import Path
import random
import subprocess
import sys
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
AT = 1_700_000_000_000
BRIDGE = r"""
const fs = require('node:fs');
const {loadModel} = require('./tools/benchmark-evidence.cjs');
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
const model = loadModel();
process.stdout.write(JSON.stringify({hash:model.hash,
  results:cases.map(item => model.brief(item.names, item.records))}));
"""


def key(name):
    return " ".join(unicodedata.normalize("NFKC", name).strip().split()).lower()


def reference(case):
    results = []
    for name in case["names"]:
        matching = [record for record in case["records"] if key(record["key"]) == key(name)]
        active = [record for record in matching if record["status"] == "active"]
        if not matching:
            answer = {"kind": "missing"}
        elif not active:
            answer = {"kind": "historical", "sources": [record["id"] for record in matching]}
        elif len({record["value"] for record in active}) > 1:
            answer = {"kind": "conflict", "sources": [record["id"] for record in active]}
        else:
            answer = {"kind": "known", "value": active[-1]["value"],
                      "sources": [record["id"] for record in active]}
        results.append({"name": name, "answer": answer})
    return results


def record(identifier, name, value="teal", status="active"):
    return {"id": identifier, "key": name, "value": value,
            "time": AT + identifier, "status": status}


def fixed_cases():
    return [
        {"names": ["favorite color", "city"], "records": []},
        {"names": ["favorite color", "city"],
         "records": [record(1, "favorite color")]},
        {"names": ["ＦＡＶＯＲＩＴＥ　ＣＯＬＯＲ", "city"],
         "records": [record(1, "favorite color"), record(2, "FAVORITE  COLOR")]},
        {"names": ["favorite color", "city"],
         "records": [record(1, "city", "Portland"), record(2, "city", "Denver")]},
        {"names": ["favorite color", "city"],
         "records": [record(1, "city", "Portland", "superseded")]},
        {"names": ["favorite color", "city"],
         "records": [record(1, "city", "Portland", "superseded"), record(2, "city", "Denver")]},
        {"names": ["favorite color", "city", "plan", "pet"],
         "records": [record(1, "favorite color"), record(2, "FAVORITE  COLOR"),
                     record(3, "city", "Portland"), record(4, "city", "Denver"),
                     record(5, "plan", "old", "superseded"), record(6, "unrelated", "hidden")]},
        {"names": ["café", "city"],
         "records": [record(1, "ＣＡＦÉ", "open"), record(2, "city", "Portland")]},
    ]


NAMES = ["favorite color", "city", "plan", "pet", "café", "favorite food",
         "home base", "project", "meeting", "status", "tag", "route"]
VALUES = ["teal", "amber", "Portland", "Denver", "open", "closed", "<tag>"]


def generated_case(rng):
    selected = rng.sample(NAMES, rng.randint(2, 8))
    names = []
    for name in selected:
        variant = rng.randrange(3)
        names.append(name.upper() if variant == 0 else
                     unicodedata.normalize("NFKC", name).replace(" ", "  ") if variant == 1 else name)
    records = []
    for name in selected + [rng.choice(NAMES)]:
        for _ in range(rng.randint(0, 4)):
            spelling = name.upper() if rng.randrange(2) else name
            records.append(record(len(records) + 1, spelling, rng.choice(VALUES),
                                  rng.choice(["active", "active", "superseded"])))
    rng.shuffle(records)
    return {"names": names, "records": records}


def check(cases, actual):
    for index, (case, got) in enumerate(zip(cases, actual), 1):
        expected = reference(case)
        if expected != got:
            raise ValueError("case {} disagrees:\n{}".format(index, json.dumps(
                {"case": case, "expected": expected, "actual": got}, ensure_ascii=False, indent=2)))
    if len(cases) != len(actual):
        raise ValueError("JavaScript returned a different case count")


def run(seed, runs):
    rng = random.Random(seed)
    cases = fixed_cases() + [generated_case(rng) for _ in range(runs)]
    process = subprocess.run(["node", "-e", BRIDGE], input=json.dumps(cases, ensure_ascii=False),
                             text=True, capture_output=True, cwd=ROOT, check=True)
    output = json.loads(process.stdout)
    actual = output["results"]
    check(cases, actual)
    mutated = json.loads(json.dumps(actual))
    mutated[0][0]["answer"]["kind"] = "known"
    try:
        check(cases, mutated)
    except ValueError:
        mutation_probe = "detected"
    else:
        raise ValueError("Mutation probe failed to detect a changed result")
    return {"format": "aru-brief-differential-report", "model_revision": "aru-evidence-briefs-1",
            "seed": seed, "fixed_cases": len(fixed_cases()), "generated_cases": runs,
            "checked": len(cases), "mutation_probe": mutation_probe, "result": "pass",
            "javascript_model_sha256": output["hash"],
            "python_reference_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=20261015)
    parser.add_argument("--runs", type=int, default=2000)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.runs <= 2000:
        parser.error("--runs must be 1–2000")
    try:
        report = run(args.seed, args.runs)
        if args.json:
            print(json.dumps(report, indent=2, ensure_ascii=False))
        else:
            print("PASS: {} independent brief comparisons; seed {}; mutation probe {}".format(
                report["checked"], report["seed"], report["mutation_probe"]))
            print("JavaScript model SHA-256: " + report["javascript_model_sha256"])
    except (ValueError, subprocess.CalledProcessError) as error:
        print("FAIL: " + str(error), file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr, file=sys.stderr)
        sys.exit(1)
