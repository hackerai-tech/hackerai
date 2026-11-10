"""Disposable loopback IDOR fixture for executable HTTP retest integration.

Synthetic data only. Pass the fixture token in HACKERAI_RETEST_FIXTURE_TOKEN.
GET /own                 -> tester's own invoice (requires Bearer TOKEN)
GET /victim/<mode>       -> vulnerable | fixed | redirect | oversized | unexpected
Any request without the token returns 401.
"""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.pop("HACKERAI_RETEST_FIXTURE_TOKEN")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer " + TOKEN:
            return self.send_json(401, {"error": "unauthorized"})
        if self.path == "/own":
            return self.send_json(
                200, {"id": "inv_1002", "owner_id": "usr_tester_b", "note": "TESTER-BODY"}
            )
        mode = self.path.rsplit("/", 1)[-1]
        if mode == "vulnerable":
            return self.send_json(
                200, {"id": "inv_1001", "owner_id": "usr_victim_a", "note": "VICTIM-BODY"}
            )
        if mode == "fixed":
            return self.send_json(403, {"error": "forbidden"})
        if mode == "redirect":
            self.send_response(302)
            self.send_header("Location", "/own")
            self.end_headers()
            return
        if mode == "oversized":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"x" * 1_200_000)
            return
        return self.send_json(500, {"error": "unexpected"})


with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
    print(server.server_port, flush=True)
    server.serve_forever()
