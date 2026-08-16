#!/usr/bin/env python3
"""
status.py - how far through the grading order you are, and what is next.
Reveals nothing beyond opaque ids.

    python3 regrade/status.py
"""
import json
from pathlib import Path

root = Path("regrade")
order = [l.strip() for l in (root / "order.txt").read_text(encoding="utf-8").splitlines() if l.strip()]


def scored(rid):
    p = root / rid / "card.json"
    if not p.exists():
        return False
    txt = p.read_text(encoding="utf-8")
    try:
        obj = json.loads(txt)
    except Exception:
        return False

    def any_value(o):
        if isinstance(o, dict):
            return any(any_value(v) for v in o.values())
        if isinstance(o, list):
            return any(any_value(v) for v in o)
        return o not in (None, "")
    # a card counts as touched once any nulled field has been filled in
    return any_value(obj)


done = [r for r in order if scored(r)]
todo = [r for r in order if r not in done]
print(f"graded {len(done)} / {len(order)}")
if todo:
    print(f"next:   {todo[0]}      python3 regrade/serve.py {todo[0]}")
    print(f"then:   {' '.join(todo[1:6])}")
else:
    print("all cards have content - re-read REGRADE_RUNBOOK.md step 5 for analysis")
sess = root / "SESSIONS.txt"
if sess.exists() and sess.read_text(encoding="utf-8").strip():
    print("\nsessions logged:")
    print(sess.read_text(encoding="utf-8").rstrip())
else:
    print("\nreminder: log today's date in regrade/SESSIONS.txt")
