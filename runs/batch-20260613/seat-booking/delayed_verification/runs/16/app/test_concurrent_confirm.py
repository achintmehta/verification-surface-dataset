import http.client
import json
import threading

def confirm_hold(session_id, hold_id):
    conn = http.client.HTTPConnection("localhost", 3000)
    payload = json.dumps({
        "sessionId": session_id
    })
    headers = {
        'Content-Type': 'application/json'
    }
    conn.request("POST", f"/api/holds/{hold_id}/confirm", payload, headers)
    res = conn.getresponse()
    data = res.read()
    print(f"{session_id}: {res.status} {data.decode('utf-8')}")

threads = []
for i in range(10):
    t = threading.Thread(target=confirm_hold, args=(f"session{i}", "a9464a7d-c44a-404b-8dfd-38a0d791e1dc"))
    threads.append(t)
    t.start()

for t in threads:
    t.join()
