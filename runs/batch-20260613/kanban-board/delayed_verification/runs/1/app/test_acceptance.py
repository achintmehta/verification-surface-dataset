import urllib.request
import urllib.error
import json
import threading
import time
import socket

BASE = "http://localhost:3001/api"

def api(method, path, body=None):
    url = BASE + path
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method,
          headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

def board():
    return api("GET", "/board")["columns"]

def collect_sse(duration=4):
    """Open SSE stream and collect raw text for `duration` seconds."""
    collected = []
    done = threading.Event()

    def _read():
        try:
            s = socket.create_connection(("localhost", 3001), timeout=duration + 1)
            s.sendall(b"GET /api/stream HTTP/1.1\r\nHost: localhost:3001\r\nAccept: text/event-stream\r\nConnection: close\r\n\r\n")
            s.settimeout(duration)
            buf = b""
            while not done.is_set():
                try:
                    chunk = s.recv(4096)
                    if not chunk:
                        break
                    buf += chunk
                except socket.timeout:
                    break
            collected.append(buf.decode(errors="replace"))
            s.close()
        except Exception as e:
            collected.append(f"ERROR: {e}")

    t = threading.Thread(target=_read, daemon=True)
    t.start()
    return t, collected, done

print("=== Acceptance Criteria Tests ===\n")

# --- AC1: A newly created card appears on every connected client ---
print("AC1: New card appears on all clients (SSE broadcast)")
t, sse_data, done = collect_sse(duration=3)
time.sleep(0.4)  # let connection establish
new_card = api("POST", "/cards", {"columnId": "col-todo", "text": "AC1 card"})["card"]
time.sleep(0.5)  # let event arrive
done.set()
t.join(timeout=5)

raw = sse_data[0] if sse_data else ""
assert "card-created" in raw, f"FAIL: no card-created SSE event. Got: {raw[:300]}"
assert new_card["id"] in raw, "FAIL: wrong card in SSE event"
print(f"  PASS: card-created SSE event received for card {new_card['id'][:8]}...")

# --- AC2: Moving a card across columns updates all clients; card in exactly one column ---
print("AC2: Cross-column move, card in exactly one column")
t2, sse_data2, done2 = collect_sse(duration=3)
time.sleep(0.3)
api("PATCH", f"/cards/{new_card['id']}/move", {"columnId": "col-inprogress"})
time.sleep(0.5)
done2.set()
t2.join(timeout=5)

raw2 = sse_data2[0] if sse_data2 else ""
assert "card-moved" in raw2, f"FAIL: no card-moved SSE event. Got: {raw2[:300]}"

cols = board()
count = sum(1 for col in cols for c in col["cards"] if c["id"] == new_card["id"])
location = next(col["title"] for col in cols for c in col["cards"] if c["id"] == new_card["id"])
assert count == 1, f"FAIL: card in {count} columns"
assert location == "In Progress", f"FAIL: card in {location}"
print(f"  PASS: card in exactly 1 column ({location}), card-moved SSE received")

# --- AC3: Two clients reordering cards within same column converge ---
print("AC3: Reordering within column")
c1 = api("POST", "/cards", {"columnId": "col-todo", "text": "Order A"})["card"]
c2 = api("POST", "/cards", {"columnId": "col-todo", "text": "Order B"})["card"]
c3 = api("POST", "/cards", {"columnId": "col-todo", "text": "Order C"})["card"]
# Move c3 before c1 (to top)
api("PATCH", f"/cards/{c3['id']}/move", {"columnId": "col-todo", "beforeId": c1["id"]})
cols = board()
todo = next(col for col in cols if col["id"] == "col-todo")
ids = [c["id"] for c in todo["cards"]]
c3_idx = ids.index(c3["id"])
c1_idx = ids.index(c1["id"])
assert c3_idx < c1_idx, f"FAIL: c3 at {c3_idx}, c1 at {c1_idx}"
print(f"  PASS: c3 (idx {c3_idx}) is before c1 (idx {c1_idx})")

# --- AC4: Concurrent moves of same card leave it in exactly one place ---
print("AC4: Concurrent moves converge to one location")
conc = api("POST", "/cards", {"columnId": "col-todo", "text": "Concurrent"})["card"]
results = [None, None]
errors = [None, None]

def move1():
    try:
        results[0] = api("PATCH", f"/cards/{conc['id']}/move", {"columnId": "col-inprogress"})
    except Exception as e:
        errors[0] = str(e)

def move2():
    try:
        results[1] = api("PATCH", f"/cards/{conc['id']}/move", {"columnId": "col-done"})
    except Exception as e:
        errors[1] = str(e)

t1 = threading.Thread(target=move1)
t2 = threading.Thread(target=move2)
t1.start(); t2.start()
t1.join(); t2.join()
cols = board()
count = sum(1 for col in cols for c in col["cards"] if c["id"] == conc["id"])
assert count == 1, f"FAIL: card in {count} columns after concurrent moves (errors: {errors})"
print(f"  PASS: card in exactly 1 column after concurrent moves")

# --- AC5: Reloading reproduces server's exact board state ---
print("AC5: Reload reproduces exact board state")
cols1 = board()
cols2 = board()
assert cols1 == cols2, "FAIL: board not stable across two loads"
print(f"  PASS: board state is stable and reproducible")

# --- AC6: Card ordering is total and stable; no two cards in same slot ---
print("AC6: Card ordering is total and stable")
for col in board():
    positions = [c["position"] for c in col["cards"]]
    assert positions == sorted(positions), f"FAIL: {col['title']} not sorted"
    assert len(positions) == len(set(positions)), f"FAIL: duplicate positions in {col['title']}"
print(f"  PASS: all columns have total, stable, unique ordering")

print("\n=== ALL ACCEPTANCE CRITERIA PASSED ===")
