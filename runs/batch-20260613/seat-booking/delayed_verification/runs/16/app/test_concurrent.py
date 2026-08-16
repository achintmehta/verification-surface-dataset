import http.client
import json
import threading

def hold_seat(session_id):
    conn = http.client.HTTPConnection("localhost", 3000)
    payload = json.dumps({
        "seatIds": ["B1"],
        "sessionId": session_id
    })
    headers = {
        'Content-Type': 'application/json'
    }
    conn.request("POST", "/api/holds", payload, headers)
    res = conn.getresponse()
    data = res.read()
    print(f"{session_id}: {res.status} {data.decode('utf-8')}")

threads = []
for i in range(10):
    t = threading.Thread(target=hold_seat, args=(f"session{i}",))
    threads.append(t)
    t.start()

for t in threads:
    t.join()
