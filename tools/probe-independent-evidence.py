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
        if type(case) is not dict or set(case) != {"record", "question"}:
            raise ValueError("invalid probe case")
        record, question = case["record"], case["question"]
        if type(question) is not str or len(question) > 500:
            raise ValueError("invalid probe question")
        try:
            auditor.records_valid([record])
            valid = True
        except (auditor.AuditError, TypeError, ValueError):
            valid = False
        results.append({"valid": valid,
                        "answer": auditor.answer(question, [record]) if valid else None})
    print(json.dumps({"results": results}, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, UnicodeError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(2)
