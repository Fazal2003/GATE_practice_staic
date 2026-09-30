#!/usr/bin/env python3
"""Validate Q:/A: deck files. Usage: validate_deck.py FILE [FILE...]

Pairs are separated by '---' or blank lines. Exits non-zero on any problem.
"""
import re
import sys


def parse(path):
    errors, cards = [], []
    q = a = None
    cur = None

    def flush(lineno):
        nonlocal q, a, cur
        if q is None and a is None:
            return
        if not q or not q.strip():
            errors.append(f"{path}:{lineno}: card missing a question")
        elif a is None or not a.strip():
            errors.append(f"{path}:{lineno}: card missing an answer: {q[:50]!r}")
        else:
            cards.append((q.strip(), a.strip()))
        q = a = cur = None

    with open(path, encoding="utf-8") as fh:
        lineno = 0
        for lineno, raw in enumerate(fh, 1):
            line = raw.rstrip("\n")
            if line.strip() == "---" or not line.strip():
                if not (line.strip() == "" and cur == "q" and a is None):
                    flush(lineno)
                continue
            m = re.match(r"^(Q|A):\s*(.*)$", line)
            if m and m.group(1) == "Q":
                if q is not None and a is not None:
                    flush(lineno)
                q, cur = m.group(2), "q"
            elif m:
                a, cur = m.group(2), "a"
            elif cur == "q":
                q += "\n" + line
            elif cur == "a":
                a += "\n" + line
            else:
                errors.append(f"{path}:{lineno}: unexpected text outside a card")
        flush(lineno)

    seen = set()
    for question, _ in cards:
        if question in seen:
            errors.append(f"{path}: duplicate question: {question[:60]!r}")
        seen.add(question)
    return cards, errors


def main(paths):
    if not paths:
        print(__doc__)
        return 2
    failed = False
    for p in paths:
        cards, errors = parse(p)
        print(f"{p}: {len(cards)} cards, {len(errors)} problems")
        for e in errors:
            print("  " + e)
        failed = failed or bool(errors) or not cards
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
