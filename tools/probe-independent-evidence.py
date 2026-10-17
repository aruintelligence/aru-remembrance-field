#!/usr/bin/env python3
"""Bounded synthetic probe for the independent auditor's evidence semantics."""

import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
MODULE = Path(__file__).with_name("independent-evidence-batch.py")
spec = importlib.util.spec_from_file_location("independent_evidence_batch", MODULE)
auditor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auditor)


def main():
    data = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise ValueError("probe input exceeds 2 MiB")
    request = json.loads(data.decode("utf-8"))
    cases = request.get("cases") if type(request) is dict else None
    if type(cases) is not list or not 1 <= len(cases) <= 2000:
        raise ValueError("probe needs 1–2000 synthetic cases")
    results = []
    for case in cases:
        if type(case) is not dict or set(case) not in (
                {"record", "question"}, {"records", "question"},
                {"records", "names"}):
            raise ValueError("invalid probe case")
        records = [case["record"]] if "record" in case else case["records"]
        if "question" in case:
            question = case["question"]
            if type(question) is not str or auditor.length(question) > 500:
                raise ValueError("invalid probe question")
        else:
            names = case["names"]
            if type(names) is not list or not 2 <= len(names) <= 8 or any(
                    type(name) is not str or auditor.length(name) > 120 for name in names):
                raise ValueError("invalid probe names")
        try:
            auditor.records_valid(records)
            if len({item["id"] for item in records}) != len(records):
                raise auditor.AuditError("duplicate record ID")
            valid = True
        except (auditor.AuditError, TypeError, ValueError):
            valid = False
        if "question" in case:
            results.append({"valid": valid,
                            "answer": auditor.answer(question, records) if valid else None})
        else:
            results.append({"valid": valid,
                            "brief": ([{"name": name, "answer": auditor.lookup(name, records)}
                                       for name in names] if valid else None)})
    print(json.dumps({"results": results}, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, UnicodeError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(2)
