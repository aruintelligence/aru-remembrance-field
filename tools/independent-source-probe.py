#!/usr/bin/env python3
"""Recompute one-source removals with the independent Python evidence rules."""

import argparse
import json
from pathlib import Path
import runpy
import sys


RULES = runpy.run_path(str(Path(__file__).with_name("independent-evidence-batch.py")))


def probe(reference_file, receipt_files, checkpoint_file=None):
    audit = RULES["audit"](reference_file, receipt_files, checkpoint_file)
    parse, read = RULES["parse"], RULES["read_limited"]
    reference = parse(read(reference_file, "Reference"))
    same = RULES["same"]

    def computed(receipt, records):
        if receipt["format"] == "aru-evidence-brief-receipt":
            return [RULES["lookup"](name, records) for name in receipt["names"]]
        return RULES["answer"](receipt["question"], records)

    rows = []
    for index, (file, result) in enumerate(zip(receipt_files, audit["receipts"]), 1):
        verdict = result["verdict"]
        if verdict == "FAIL":
            rows.append({"index": index, "verdict": verdict, "skipped": True})
            continue
        receipt = parse(read(file, f"Receipt #{index}"))
        RULES["verify_receipt"](receipt)
        original = computed(receipt, reference["records"])
        removals = []
        for source in reference["records"]:
            reduced = [row for row in reference["records"] if row["id"] != source["id"]]
            altered = {**reference, "records": reduced}
            removals.append({"source_id": source["id"],
                             "verdict": "MATCH" if RULES["matches_reference"](receipt, altered) else "DIFFER",
                             "answer_changed": not same(original, computed(receipt, reduced))})
        rows.append({"index": index, "verdict": verdict, "removals": removals})

    return {"format": "aru-source-removal-map", "version": 1,
            "selection": {"reference_sha256": audit["reference_sha256"],
                          "checkpoint_sha256": audit["checkpoint_sha256"],
                          "normalization_sha256": audit["normalization_sha256"],
                          "browser_script_sha256": audit["browser_script_sha256"],
                          "receipts": [{key: row[key] for key in
                                        ("index", "sha256", "verdict", "duplicate_of")}
                                       for row in audit["receipts"]]},
            "source_ids": [row["id"] for row in reference["records"]],
            "rows": rows}


def run(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference")
    parser.add_argument("receipts", nargs="+")
    parser.add_argument("--checkpoint")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        report = probe(args.reference, args.receipts, args.checkpoint)
    except (ValueError, OSError, UnicodeError, RecursionError, TypeError, KeyError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"PROBE READY: {len(report['source_ids'])} supplied sources, {len(report['rows'])} receipts. "
              "This does not establish completeness or factual truth.")
    return 0


if __name__ == "__main__":
    sys.exit(run())
