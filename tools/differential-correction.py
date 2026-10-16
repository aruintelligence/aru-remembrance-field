#!/usr/bin/env python3
"""Cross-check reviewed ledger corrections against a separately written oracle.

Agreement checks software transitions, not authenticity or factual truth.
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
AT = 1_700_000_001_000
BRIDGE = r"""
const fs = require('node:fs');
const {loadModel} = require('./tools/benchmark-evidence.cjs');
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
const model = loadModel();
process.stdout.write(JSON.stringify({hash:model.hash,
  results:cases.map(c => model.correct(c.name, c.value, c.records, c.id, c.at))}));
"""


def normalize(name):
    return " ".join(unicodedata.normalize("NFKC", name).strip().split()).lower()


def reference(case):
    target = normalize(case["name"])
    prior = []
    for record in case["records"]:
        copy = dict(record)
        if normalize(copy["key"]) == target:
            copy["status"] = "superseded"
        prior.append(copy)
    prior.append({"id": case["id"], "key": case["name"], "value": case["value"],
                  "time": case["at"], "status": "active", "imported": False})
    return prior


def record(identifier, key, value, status="active", imported=False):
    return {"id": identifier, "key": key, "value": value,
            "time": AT - identifier, "status": status, "imported": imported}


def fixed_cases():
    return [
        {"name": "city", "value": "Denver", "records": [record(1, "city", "Portland")], "id": 2, "at": AT},
        {"name": "favorite color", "value": "amber",
         "records": [record(1, "favorite color", "teal"),
                     record(2, "FAVORITE  COLOR", "purple", imported=True)], "id": 3, "at": AT},
        {"name": "tag", "value": "new", "records": [record(1, "tag", "old"),
                                                  record(2, "TAG", "old")], "id": 5, "at": AT},
        {"name": "café", "value": "closed", "records": [record(1, "ＣＡＦÉ", "open"),
                                                         record(2, "unrelated", "private")], "id": 3, "at": AT},
        {"name": "plan", "value": "current", "records": [record(1, "plan", "old", "superseded"),
                                                           record(2, "plan", "new")], "id": 3, "at": AT},
        {"name": "project", "value": "beta", "records": [record(8, "other", "private"),
                                                          record(2, "project", "alpha")], "id": 10, "at": AT},
    ]


NAMES = ["city", "plan", "favorite color", "project", "café", "home base"]
VALUES = ["teal", "amber", "Portland", "Denver", "open", "<tag>"]


def generated_case(rng):
    target = rng.choice(NAMES)
    records = []
    for _ in range(rng.randint(1, 5)):
        spelling = target.upper() if rng.randrange(2) else target
        records.append(record(len(records) + 1, spelling, rng.choice(VALUES),
                              rng.choice(["active", "active", "superseded"]), bool(rng.randrange(2))))
    if all(record["status"] != "active" for record in records):
        records[0]["status"] = "active"
    for _ in range(rng.randint(0, 6)):
        other = rng.choice([name for name in NAMES if name != target])
        records.append(record(len(records) + 1, other, rng.choice(VALUES),
                              rng.choice(["active", "superseded"]), bool(rng.randrange(2))))
    new_value = rng.choice(VALUES)
    if all(record["value"] == new_value for record in records if
           normalize(record["key"]) == normalize(target) and record["status"] == "active"):
        new_value = "definitely different"
    rng.shuffle(records)
    return {"name": target, "value": new_value, "records": records,
            "id": max(record["id"] for record in records) + rng.randint(1, 3), "at": AT}


def check(cases, actual):
    if len(cases) != len(actual):
        raise ValueError("JavaScript returned a different case count")
    for index, (case, result) in enumerate(zip(cases, actual), 1):
        expected = reference(case)
        if expected != result:
            raise ValueError("case {} disagrees:\n{}".format(index, json.dumps(
                {"case": case, "expected": expected, "actual": result}, ensure_ascii=False, indent=2)))


def run(seed, runs):
    rng = random.Random(seed)
    cases = fixed_cases() + [generated_case(rng) for _ in range(runs)]
    process = subprocess.run(["node", "-e", BRIDGE], input=json.dumps(cases, ensure_ascii=False),
                             text=True, capture_output=True, cwd=ROOT, check=True)
    output = json.loads(process.stdout)
    actual = output["results"]
    check(cases, actual)
    mutated = json.loads(json.dumps(actual))
    mutated[0][0]["status"] = "active"
    try:
        check(cases, mutated)
    except ValueError:
        mutation_probe = "detected"
    else:
        raise ValueError("Mutation probe failed to detect a changed status")
    return {"format": "aru-correction-differential-report", "model_revision": "aru-evidence-corrections-1",
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
            print("PASS: {} independent correction comparisons; seed {}; mutation probe {}".format(
                report["checked"], report["seed"], report["mutation_probe"]))
            print("JavaScript model SHA-256: " + report["javascript_model_sha256"])
    except (ValueError, subprocess.CalledProcessError) as error:
        print("FAIL: " + str(error), file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr, file=sys.stderr)
        sys.exit(1)
