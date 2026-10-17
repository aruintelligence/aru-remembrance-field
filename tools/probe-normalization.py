#!/usr/bin/env python3
"""Compare only selected evidence names with the independent Python rules."""

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
        raise ValueError("normalization input exceeds 2 MiB")
    request = json.loads(data.decode("utf-8"))
    strings = request.get("strings") if type(request) is dict else None
    if type(strings) is not list or len(strings) > 2500 or any(
            type(value) is not str or auditor.length(value) > 500 for value in strings):
        raise ValueError("invalid normalization input")
    print(json.dumps({"normalized": [auditor.normalized(value) for value in strings]},
                     ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, UnicodeError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(2)
