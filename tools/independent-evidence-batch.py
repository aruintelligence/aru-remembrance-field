#!/usr/bin/env python3
"""Independently replay a bounded ĀRU answer batch using Python's own rules.

This checks deterministic software consistency, not source identity or factual truth.
"""

import argparse
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import unicodedata


MAX_FILE = 1024 * 1024
ROOT = Path(__file__).resolve().parents[1]
FIELDS = {"id", "key", "value", "time", "status", "imported"}
FORMATS = {"aru-evidence-question-receipt", "aru-evidence-answer-excerpt",
           "aru-evidence-brief-receipt"}
# ECMAScript /\s/ and String.trim() in the browser's evidence rules. Python's
# \s and str.strip() differ at U+0085, U+001C–U+001F, and U+FEFF, among others.
JS_SPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
SPACE_RUN = f"[{re.escape(JS_SPACE)}]+"
SPACE_OPT = f"[{re.escape(JS_SPACE)}]*"
# JS regex '.' excludes these four line terminators; Python's '.' only excludes LF.
JS_DOT = r"[^\r\n\u2028\u2029]"
# The JS grammar uses /i without /u. For these ASCII literals that means just
# ASCII upper/lower pairs; Python IGNORECASE additionally accepts İ, ı, and ſ.
QUESTION = re.compile(r"[Ww][Hh][Aa][Tt](?:" + SPACE_RUN +
                      r"[Ii][Ss]|['’][Ss])" + SPACE_RUN +
                      "(" + JS_DOT + r"+?)(?:" + SPACE_OPT + r"\?)?")
POSSESSIVE = re.compile(r"[Mm][Yy]" + SPACE_RUN + "(" + JS_DOT + r"+)")


class AuditError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise AuditError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def int_value(value):
    return type(value) is int


def number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def length(value):
    """JavaScript string length is measured in UTF-16 code units."""
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def same(left, right):
    if number(left) and number(right):
        return left == right and (left != 0 or math.copysign(1, left) == math.copysign(1, right))
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(same(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(same(a, b) for a, b in zip(left, right))
    return left == right


def fields(value, required):
    return type(value) is dict and value.keys() == set(required)


def normalized(name):
    return re.sub(SPACE_RUN, " ", unicodedata.normalize("NFKC", name).strip(JS_SPACE)).lower()


def normalization_profile(values):
    names = dict()
    for value in values:
        if type(value) is not dict:
            continue
        records = value.get("records")
        if type(records) is list and len(records) <= 100:
            for row in records:
                if type(row) is dict and type(row.get("key")) is str and length(row["key"]) <= 500:
                    names[row["key"]] = None
        question = value.get("question")
        if type(question) is str and length(question) <= 500:
            names[question] = None
        brief_names = value.get("names")
        if type(brief_names) is list and len(brief_names) <= 8:
            for name in brief_names:
                if type(name) is str and length(name) <= 500:
                    names[name] = None
    require(len(names) <= 2500, "too many selected strings")
    digest = hashlib.sha256(b"aru-selected-normalization-v1\n")
    for name in names:
        # TextEncoder/Buffer replace an unpaired UTF-16 surrogate with U+FFFD.
        text = re.sub(r"[\ud800-\udfff]", "\ufffd", normalized(name))
        data = text.encode("utf-8")
        digest.update(len(data).to_bytes(4, "big"))
        digest.update(data)
    return digest.hexdigest()


def records_valid(records):
    require(type(records) is list and len(records) <= 100, "invalid record count")
    seen = set()
    for item in records:
        require(type(item) is dict and FIELDS.issuperset(item) and
                {"id", "key", "value", "time", "status"}.issubset(item) and
                int_value(item["id"]) and 1 <= item["id"] <= 10**9 and
                type(item["key"]) is str and item["key"].strip(JS_SPACE) and length(item["key"]) <= 120 and
                type(item["value"]) is str and item["value"].strip(JS_SPACE) and length(item["value"]) <= 500 and
                number(item["time"]) and 0 <= item["time"] <= 8.64e15 and
                item["status"] in ("active", "superseded") and
                ("imported" not in item or type(item["imported"]) is bool) and
                item["id"] not in seen, "invalid or duplicate record")
        seen.add(item["id"])


def reference_valid(reference):
    require(fields(reference, {"format", "version", "records", "next_source_id"}) and
            reference["format"] == "aru-evidence-ledger-baseline" and
            int_value(reference["version"]) and reference["version"] == 1 and
            int_value(reference["next_source_id"]) and
            1 <= reference["next_source_id"] <= 10**9 + 1, "invalid reference baseline")
    records_valid(reference["records"])
    require(all(item["id"] < reference["next_source_id"] for item in reference["records"]),
            "reference next source ID is too small")


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def checkpoint_valid(reference, checkpoint):
    require(fields(checkpoint, {"format", "version", "encoding", "sha256"}) and
            checkpoint["format"] == "aru-evidence-ledger-checkpoint" and
            int_value(checkpoint["version"]) and checkpoint["version"] == 1 and
            checkpoint["encoding"] == "aru-evidence-ledger-checkpoint-1" and
            type(checkpoint["sha256"]) is str and
            re.fullmatch(r"[0-9a-f]{64}", checkpoint["sha256"]), "invalid checkpoint")
    # Browser exports use integer millisecond timestamps. Normalize integral JSON numbers
    # here because JSON.stringify(1.0) produces 1, unlike json.dumps(1.0).
    rows = [[item["id"], item["key"], item["value"],
             int(item["time"]) if item["time"] == int(item["time"]) else item["time"],
             item["status"], [item["imported"]] if "imported" in item else []]
            for item in reference["records"]]
    ledger = sha256(json_bytes(["aru-ledger-commitment-1", rows]))
    expected = sha256(json_bytes(["aru-evidence-ledger-checkpoint-1", ledger,
                                  reference["next_source_id"]]))
    require(checkpoint["sha256"] == expected, "checkpoint differs from reference")


def lookup(name, records):
    key = normalized(name)
    if not key:
        return {"kind": "empty"}
    matching = [item for item in records if normalized(item["key"]) == key]
    if not matching:
        return {"kind": "missing"}
    active = [item for item in matching if item["status"] == "active"]
    if not active:
        return {"kind": "historical", "sources": [item["id"] for item in matching]}
    if len({item["value"] for item in active}) > 1:
        return {"kind": "conflict", "sources": [item["id"] for item in active]}
    return {"kind": "known", "value": active[-1]["value"],
            "sources": [item["id"] for item in active]}


def answer(question, records):
    if not question.strip(JS_SPACE):
        return {"kind": "empty"}
    if length(question) > 200:
        return {"kind": "unsupported"}
    match = QUESTION.fullmatch(unicodedata.normalize("NFKC", question).strip(JS_SPACE))
    if not match:
        return {"kind": "unsupported"}
    name = match[1].strip(JS_SPACE)
    candidates = [name]
    possessive = POSSESSIVE.fullmatch(name)
    if possessive:
        candidates.append(possessive[1])
    keys = list(dict.fromkeys(normalized(item) for item in candidates))
    present = [key for key in keys if any(normalized(item["key"]) == key for item in records)]
    if len(present) > 1:
        return {"kind": "ambiguous", "names": [next(item["key"] for item in records
                  if normalized(item["key"]) == key) for key in present]}
    return lookup(present[0], records) if present else {"kind": "missing"}


def verify_receipt(receipt):
    require(type(receipt) is dict and type(receipt.get("format")) is str and
            receipt["format"] in FORMATS,
            "unsupported receipt format")
    kind = receipt["format"]
    if kind == "aru-evidence-brief-receipt":
        require(fields(receipt, {"format", "version", "model_revision", "names", "records", "results"}) and
                int_value(receipt["version"]) and receipt["version"] == 1 and
                receipt["model_revision"] == "aru-evidence-briefs-1" and
                type(receipt["names"]) is list and 2 <= len(receipt["names"]) <= 8,
                "invalid brief format")
        names = receipt["names"]
        require(all(type(name) is str and name.strip(JS_SPACE) and name == name.strip(JS_SPACE) and
                    length(name) <= 120 and "\r" not in name and "\n" not in name for name in names),
                "invalid brief name")
        require(len({normalized(name) for name in names}) == len(names), "duplicate brief name")
        records_valid(receipt["records"])
        computed = [{"name": name, "answer": lookup(name, receipt["records"])} for name in names]
        require(same(receipt["results"], computed), "brief replay failed")
        return
    excerpt = kind == "aru-evidence-answer-excerpt"
    expected = {"format", "version", "model_revision", "question", "records", "answer"}
    require(fields(receipt, expected | ({"scope"} if excerpt else set())) and
            int_value(receipt["version"]) and receipt["version"] == 1 and
            receipt["model_revision"] == "aru-evidence-questions-1" and
            (not excerpt or receipt["scope"] == "cited-assertions-only") and
            type(receipt["question"]) is str and length(receipt["question"]) <= 500,
            "invalid question receipt")
    records_valid(receipt["records"])
    require(not excerpt or bool(receipt["records"]), "empty excerpt")
    computed = answer(receipt["question"], receipt["records"])
    require(same(receipt["answer"], computed), "question replay failed")
    if excerpt:
        require(computed["kind"] == "known" and
                all(item["status"] == "active" for item in receipt["records"]) and
                len(receipt["records"]) == len(computed["sources"]) and
                all(item["id"] in computed["sources"] for item in receipt["records"]),
                "excerpt does not contain exactly its active citations")


def matches_reference(receipt, reference):
    records = reference["records"]
    if receipt["format"] == "aru-evidence-answer-excerpt":
        if not same(receipt["answer"], answer(receipt["question"], records)):
            return False
        by_id = {item["id"]: item for item in records}
        return all(same(item, by_id.get(item["id"])) for item in receipt["records"])
    return same(receipt["records"], records)


def parse(data):
    def reject_constant(value):
        raise ValueError("invalid JSON constant")
    def unique_object(pairs):
        result = {}
        for name, value in pairs:
            require(name not in result, "duplicate JSON object name")
            result[name] = value
        return result
    # TextDecoder in the browser and Node discards an initial UTF-8 BOM.
    # Preserve raw bytes for hashes and duplicate checks, but match that parse rule.
    return json.loads(data.decode("utf-8-sig", errors="strict"),
                      parse_constant=reject_constant, object_pairs_hook=unique_object)


def read_limited(file, label):
    info = os.stat(file)
    require(stat.S_ISREG(info.st_mode) and info.st_size <= MAX_FILE,
            f"{label} must be a regular file of at most 1 MiB")
    with open(file, "rb") as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_size <= MAX_FILE,
                f"{label} must be a regular file of at most 1 MiB")
        data = handle.read(MAX_FILE + 1)
    require(len(data) <= MAX_FILE, f"{label} exceeds 1 MiB")
    return data


def script_sha256():
    html = (ROOT / "index.html").read_bytes().decode("utf-8")
    scripts = re.findall(r"<script>([\s\S]*?)</script>", html)
    require(len(scripts) == 1, "expected exactly one inline script")
    return sha256(scripts[0].encode("utf-8"))


def audit(reference_file, receipt_files, checkpoint_file=None):
    require(1 <= len(receipt_files) <= 20, "provide 1–20 receipts")
    reference_bytes = read_limited(reference_file, "Reference")
    reference = parse(reference_bytes)
    reference_valid(reference)
    checkpoint_bytes = read_limited(checkpoint_file, "Checkpoint") if checkpoint_file else None
    if checkpoint_bytes is not None:
        checkpoint_valid(reference, parse(checkpoint_bytes))
    file_bytes = [read_limited(file, f"Receipt #{index}")
                  for index, file in enumerate(receipt_files, 1)]
    require(sum(map(len, file_bytes)) <= 4 * MAX_FILE, "selected receipts exceed 4 MiB")
    first = {}
    totals = {"match": 0, "differ": 0, "fail": 0, "identical_copies": 0}
    rows = []
    selected = [reference]
    for index, data in enumerate(file_bytes, 1):
        duplicate = first.setdefault(data, index)
        duplicate = duplicate if duplicate != index else None
        if duplicate is not None:
            totals["identical_copies"] += 1
        verdict, reason = "FAIL", "invalid-json"
        try:
            receipt = parse(data)
        except (ValueError, UnicodeError, RecursionError):
            pass
        else:
            selected.append(receipt)
            reason = "unsupported-format"
            if type(receipt) is dict and type(receipt.get("format")) is str and receipt["format"] in FORMATS:
                reason = "replay-failed"
                try:
                    verify_receipt(receipt)
                except AuditError:
                    pass
                else:
                    verdict, reason = (("MATCH", None) if matches_reference(receipt, reference)
                                       else ("DIFFER", "reference-mismatch"))
        totals[verdict.lower()] += 1
        rows.append({"index": index, "sha256": sha256(data), "verdict": verdict,
                     "reason": reason, "duplicate_of": duplicate})
    return {"format": "aru-evidence-independent-batch-audit", "version": 1,
            "python_verifier_sha256": sha256(Path(__file__).read_bytes()),
            "browser_script_sha256": script_sha256(),
            "reference_sha256": sha256(reference_bytes),
            "checkpoint_sha256": sha256(checkpoint_bytes) if checkpoint_bytes is not None else None,
            "normalization_sha256": normalization_profile(selected),
            "receipts": rows, "totals": totals}


def capture_from_report(report, version):
    require(int_value(version) and version in (1, 2, 3), "unsupported capture version")
    return {"format": "aru-evidence-browser-batch-capture", "version": version,
            **({"browser_script_sha256": report["browser_script_sha256"]} if version >= 2 else {}),
            **({"normalization_sha256": report["normalization_sha256"]} if version == 3 else {}),
            "reference_sha256": report["reference_sha256"],
            "checkpoint_sha256": report["checkpoint_sha256"],
            "receipts": [{key: row[key] for key in ("index", "sha256", "verdict", "duplicate_of")}
                         for row in report["receipts"]], "totals": report["totals"]}


def transition_from_reports(a_report, b_report, version=2):
    require(version in (1, 2), "unsupported transition capture version")
    a = capture_from_report(a_report, 2 if version == 1 else 3)
    b = capture_from_report(b_report, 2 if version == 1 else 3)
    require(a["browser_script_sha256"] == b["browser_script_sha256"] and
            len(a["receipts"]) == len(b["receipts"]) and
            all(left["sha256"] == right["sha256"] and
                left["duplicate_of"] == right["duplicate_of"]
                for left, right in zip(a["receipts"], b["receipts"])),
            "transition sides must use the same verifier and ordered receipt bytes")
    return {"format": "aru-evidence-reference-transition-capture", "version": version,
            "capture_a": a, "capture_b": b,
            "changed_receipts": [row["index"] for row, other in zip(a["receipts"], b["receipts"])
                                 if row["verdict"] != other["verdict"]]}


def opening_key_bytes(opening):
    require(type(opening) is dict and set(opening) == {"format", "version", "key_hex"} and
            opening["format"] == "aru-evidence-transition-opening-key" and
            int_value(opening["version"]) and opening["version"] == 1 and
            type(opening["key_hex"]) is str and
            re.fullmatch(r"[0-9a-f]{64}", opening["key_hex"]) is not None,
            "expected a version 1 transition opening key with 32 random bytes")
    return bytes.fromhex(opening["key_hex"])


def sealed_transition_from_capture(transition, key_bytes):
    require(type(key_bytes) is bytes and len(key_bytes) == 32, "opening key must be 32 bytes")
    a, b = transition["capture_a"], transition["capture_b"]

    def commit(role, index, digest):
        if digest is None:
            return None
        message = f"aru-sealed-transition-v1\n{role}\n{index}\n{digest}".encode("ascii")
        return hmac.new(key_bytes, message, hashlib.sha256).hexdigest()

    version = transition["version"]
    return {"format": "aru-evidence-sealed-reference-transition-capture", "version": version,
            "browser_script_sha256": a["browser_script_sha256"],
            **({"normalization_a_commitment": commit("normalization-a", 0, a["normalization_sha256"]),
                "normalization_b_commitment": commit("normalization-b", 0, b["normalization_sha256"])}
               if version == 2 else {}),
            "reference_a_commitment": commit("reference-a", 0, a["reference_sha256"]),
            "reference_b_commitment": commit("reference-b", 0, b["reference_sha256"]),
            "checkpoint_a_commitment": commit("checkpoint-a", 0, a["checkpoint_sha256"]),
            "checkpoint_b_commitment": commit("checkpoint-b", 0, b["checkpoint_sha256"]),
            "receipts": [{"index": row["index"],
                          "commitment": commit("receipt", row["index"], row["sha256"]),
                          "verdict_a": row["verdict"], "verdict_b": b["receipts"][i]["verdict"],
                          "duplicate_of": row["duplicate_of"]}
                         for i, row in enumerate(a["receipts"])],
            "totals_a": a["totals"], "totals_b": b["totals"],
            "changed_receipts": transition["changed_receipts"]}


def addition_witness(a, b, receipt):
    def answers(records):
        if receipt["format"] == "aru-evidence-brief-receipt":
            return [lookup(name, records) for name in receipt["names"]]
        return answer(receipt["question"], records)

    target = answers(b["records"])
    if same(answers(a["records"]), target):
        return {"status": "unchanged"}
    base_ids = {record["id"] for record in a["records"]}
    common = [record for record in b["records"] if record["id"] in base_ids]
    if not same(a["records"], common):
        return {"status": "unavailable", "reason": "not-addition-only"}
    added = [record["id"] for record in b["records"] if record["id"] not in base_ids]
    if len(added) > 6:
        return {"status": "unavailable", "reason": "too-many-additions"}
    sets, minimum_size, total_sets, tested_subsets = [], None, 0, 0
    for size in range(1, len(added) + 1):
        for mask in range(1, 1 << len(added)):
            chosen = [identifier for index, identifier in enumerate(added) if mask & (1 << index)]
            if len(chosen) != size:
                continue
            tested_subsets += 1
            chosen_ids = set(chosen)
            hybrid = [record for record in b["records"] if record["id"] in base_ids or
                      record["id"] in chosen_ids]
            if not same(answers(hybrid), target):
                continue
            minimum_size = size
            total_sets += 1
            if len(sets) < 3:
                sets.append(chosen)
        if minimum_size is not None:
            break
    if minimum_size is None:
        return {"status": "unavailable", "reason": "no-witness"}
    return {"status": "witness", "minimum_size": minimum_size, "sets": sets,
            "total_sets": total_sets, "tested_subsets": tested_subsets}


def explain_transition_additions(a_file, b_file, receipt_files, a_report, b_report):
    a_bytes = read_limited(a_file, "Reference A")
    b_bytes = read_limited(b_file, "Reference B")
    require(sha256(a_bytes) == a_report["reference_sha256"] and
            sha256(b_bytes) == b_report["reference_sha256"],
            "reference bytes changed during answer-change analysis")
    require(script_sha256() == a_report["browser_script_sha256"] == b_report["browser_script_sha256"] and
            sha256(Path(__file__).read_bytes()) == a_report["python_verifier_sha256"] ==
            b_report["python_verifier_sha256"],
            "verifier code changed during answer-change analysis")
    a, b = parse(a_bytes), parse(b_bytes)
    rows = []
    for index, file in enumerate(receipt_files):
        data = read_limited(file, f"Receipt #{index + 1}")
        require(sha256(data) == a_report["receipts"][index]["sha256"] and
                sha256(data) == b_report["receipts"][index]["sha256"],
                "receipt bytes changed during answer-change analysis")
        if a_report["receipts"][index]["verdict"] == "FAIL":
            rows.append({"index": index + 1, "status": "unavailable", "reason": "receipt-failed"})
            continue
        receipt = parse(data)
        verify_receipt(receipt)
        rows.append({"index": index + 1, **addition_witness(a, b, receipt)})
    return rows


def run(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference")
    parser.add_argument("receipts", nargs="+")
    parser.add_argument("--checkpoint")
    parser.add_argument("--reference-b")
    parser.add_argument("--checkpoint-b")
    parser.add_argument("--check-transition")
    parser.add_argument("--check-sealed")
    parser.add_argument("--opening-key")
    parser.add_argument("--explain-additions", action="store_true")
    parser.add_argument("--check-capture")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        require(not (args.checkpoint_b or args.check_transition or args.check_sealed or
                     args.explain_additions) or args.reference_b,
                "paired options require --reference-b")
        require(bool(args.check_sealed) == bool(args.opening_key),
                "--check-sealed and --opening-key must be supplied together")
        require(not (args.check_sealed and args.check_transition),
                "choose only one transition capture to check")
        require(not args.reference_b or not args.check_capture,
                "use --check-transition instead of --check-capture with --reference-b")
        report = audit(args.reference, args.receipts, args.checkpoint)
        if args.reference_b:
            other = audit(args.reference_b, args.receipts, args.checkpoint_b)
            chosen = args.check_transition or args.check_sealed
            expected = parse(read_limited(chosen, "Transition capture")) if chosen else None
            transition = transition_from_reports(report, other,
                                                 1 if type(expected) is dict and expected.get("version") == 1 else 2)
            if args.check_transition:
                require(same(expected, transition),
                        "transition capture differs from independently recomputed files, outcomes, or browser script")
            sealed = (sealed_transition_from_capture(transition,
                      opening_key_bytes(parse(read_limited(args.opening_key, "Opening key"))))
                      if args.check_sealed else None)
            if sealed is not None:
                require(same(expected, sealed),
                        "sealed transition capture differs from independently recomputed files, outcomes, or browser script")
            influence = (explain_transition_additions(args.reference, args.reference_b,
                         args.receipts, report, other) if args.explain_additions else None)
            if args.json:
                print(json.dumps({"transition": sealed or transition, "answer_influence": influence}
                      if influence is not None else sealed or transition, indent=2, ensure_ascii=False))
            else:
                for label, side in (("A", report), ("B", other)):
                    totals = side["totals"]
                    print(f"{label}: {totals['match']} MATCH, {totals['differ']} DIFFER, "
                          f"{totals['fail']} FAIL.")
                print(f"{len(transition['changed_receipts'])} changed receipt verdicts.")
                if influence is not None:
                    for row in influence:
                        if row["status"] == "witness":
                            sets = "; ".join(" + ".join(f"#{identifier}" for identifier in group)
                                             for group in row["sets"])
                            more = row["total_sets"] - len(row["sets"])
                            print(f"#{row['index']} answer witness: {row['minimum_size']} added "
                                  f"source{'s' if row['minimum_size'] != 1 else ''} "
                                  f"per minimum set; {sets}" + (f"; {more} more" if more else "") +
                                  f"; {row['tested_subsets']} "
                                  f"subset{'s' if row['tested_subsets'] != 1 else ''} tested.")
                        else:
                            print(f"#{row['index']} answer witness: {row['status']}" +
                                  (f" ({row['reason']})" if row.get("reason") else "") + ".")
                    print("Witnesses model only added sources under these rules; they do not "
                          "establish chronology, authorship, or truth.")
                if args.check_transition:
                    print("TRANSITION CAPTURE MATCH: independent Python replay agrees. "
                          + ("Selected-name profiles agree. " if transition["version"] == 2 else
                             "Older capture has no originating browser normalization profile. ") +
                          "Inspect A and B counts independently.")
                if sealed is not None:
                    print("SEALED TRANSITION MATCH: independent Python replay agrees. "
                          + ("Selected-name profiles agree. " if transition["version"] == 2 else
                             "Older capture has no originating browser normalization profile. ") +
                          "Inspect A and B counts independently.")
                print("A and B are labels, not verified dates; consistency does not prove "
                      "origin, completeness, or factual truth.")
            return 0 if args.check_transition or sealed is not None or not any(
                side["totals"][key] for side in (report, other) for key in ("differ", "fail")) else 1
        if args.check_capture:
            expected = parse(read_limited(args.check_capture, "Capture"))
            version = expected.get("version") if type(expected) is dict else None
            require(same(expected, capture_from_report(report, version)),
                    "capture differs from independently recomputed files, outcomes, or browser script")
        totals = report["totals"]
        if args.json:
            print(json.dumps(report, indent=2, ensure_ascii=False))
        else:
            print(f"{len(report['receipts'])} selected: {totals['match']} MATCH, "
                  f"{totals['differ']} DIFFER, {totals['fail']} FAIL; "
                  f"{totals['identical_copies']} identical byte copies.")
            for row in report["receipts"]:
                print(f"#{row['index']} {row['verdict']}" +
                      (f" ({row['reason']})" if row["reason"] else ""))
            if args.check_capture:
                print("CAPTURE MATCH: independent Python replay agrees." +
                      (" Legacy v1 has no script fingerprint." if version == 1 else
                       " Browser script fingerprint agrees; original runtime is unbound." if version == 2 else
                       " Browser script and selected-name normalization profile agree."))
            print("This checks the supplied files under deterministic rules; it does not prove origin or truth.")
        return 0 if args.check_capture or not (totals["differ"] or totals["fail"]) else 1
    except (AuditError, OSError, ValueError, UnicodeError, RecursionError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(run())
