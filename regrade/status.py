#!/usr/bin/env python3
"""
status.py - how far through the grading order you are, and what is next.
Reveals nothing beyond opaque ids.

    python3 regrade/status.py

A card counts as graded only when every field that stage.py nulled has been
filled back in. SCORE_KEYS below must stay in step with stage.py: a blank card
still carries criteria, weights and the task name, so "any non-empty value"
is not a usable test of whether grading has happened.
"""
import json
from pathlib import Path

root = Path("regrade")
order = [l.strip() for l in (root / "order.txt").read_text(encoding="utf-8").splitlines() if l.strip()]

# mirrors SCORE_KEYS in stage.py
SCORE_KEYS = {"score", "value", "result", "verdict", "rating", "mark", "grade"}


def score_values(o):
    """Every scalar sitting at a score key, anywhere in the card."""
    out = []
    if isinstance(o, dict):
        for k, v in o.items():
            if k.lower() in SCORE_KEYS and not isinstance(v, (dict, list)):
                out.append(v)
            else:
                out.extend(score_values(v))
    elif isinstance(o, list):
        for v in o:
            out.extend(score_values(v))
    return out


def state(rid):
    p = root / rid / "card.json"
    if not p.exists():
        return "missing"
    try:
        obj = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return "unreadable"
    vals = score_values(obj)
    if not vals:
        return "no-items"
    filled = [v for v in vals if v not in (None, "")]
    if not filled:
        return "untouched"
    return "complete" if len(filled) == len(vals) else "partial"


states = {r: state(r) for r in order}
done = [r for r in order if states[r] == "complete"]
partial = [r for r in order if states[r] == "partial"]
todo = [r for r in order if states[r] not in ("complete",)]
odd = [r for r in order if states[r] in ("missing", "unreadable", "no-items")]

print(f"graded {len(done)} / {len(order)}")
if partial:
    print(f"partly scored ({len(partial)}): {' '.join(partial[:8])}")
if odd:
    for r in odd:
        print(f"  PROBLEM {r}: {states[r]}")
if todo:
    print(f"next:   {todo[0]}      python3 regrade/serve.py {todo[0]}")
    print(f"then:   {' '.join(todo[1:6])}")
else:
    print("every card fully scored - re-read REGRADE_RUNBOOK.md step 5 for analysis")

sess = root / "SESSIONS.txt"
body = sess.read_text(encoding="utf-8") if sess.exists() else ""
entries = [l for l in body.splitlines() if l.strip() and l.strip()[:1].isdigit()]
if entries:
    print("\nsessions logged:")
    for l in entries:
        print("  " + l)
else:
    print("\nreminder: log today's date in regrade/SESSIONS.txt")
