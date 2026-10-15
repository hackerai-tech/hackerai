#!/usr/bin/env python3
"""Synthetic, loopback-only access-control example; no HackerAI execution implied.

Run with Python 3. Uses only its standard library. X-Demo-User simulates an
already authenticated identity. It is deliberately not a real auth mechanism.
The two variants differ only by the object-ownership check.
"""
import hashlib
import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen

REPORTS = {
    "201": {"id": "201", "owner": "alice", "title": "Alice's synthetic report"},
    "202": {"id": "202", "owner": "bob", "title": "Bob's synthetic report"},
}


def handler(enforce_ownership):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def respond(self, status, body):
            payload = json.dumps(body, sort_keys=True).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            identity = self.headers.get("X-Demo-User")
            if identity not in {"alice", "bob"}:
                return self.respond(401, {"error": "unauthenticated_demo_identity"})
            prefix = "/api/reports/"
            if not self.path.startswith(prefix):
                return self.respond(404, {"error": "not_found"})
            report = REPORTS.get(self.path[len(prefix):])
            if not report:
                return self.respond(404, {"error": "not_found"})
            if enforce_ownership and report["owner"] != identity:
                return self.respond(403, {"error": "forbidden"})
            return self.respond(200, report)
    return Handler


def run_variant(name, enforce_ownership):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler(enforce_ownership))
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = "http://127.0.0.1:" + str(server.server_address[1])
    results = []
    cases = [
        ("alice_reads_own", "alice", "201", 200),
        ("bob_reads_own", "bob", "202", 200),
        ("alice_requests_bob_report", "alice", "202", 403 if enforce_ownership else 200),
        ("unknown_identity_rejected", "unknown", "202", 401),
    ]
    try:
        for case, identity, report_id, expected_status in cases:
            path = "/api/reports/" + report_id
            request = Request(base + path, headers={"X-Demo-User": identity})
            try:
                response = urlopen(request, timeout=3)
            except HTTPError as error:
                response = error
            with response:
                status = response.status
                body = json.loads(response.read())
            assert status == expected_status, (case, status, expected_status)
            if status == 200:
                assert body == REPORTS[report_id]
            if case == "alice_requests_bob_report":
                assert body == ({"error": "forbidden"} if enforce_ownership else REPORTS["202"])
            results.append({"case": case, "demo_identity": identity,
                            "method": "GET", "path": path,
                            "http_status": status, "response_json": body,
                            "expected_http_status": expected_status, "passed": True})
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
        assert not thread.is_alive()
    return {"variant": name, "ownership_check_enabled": enforce_ownership,
            "listen_address": "127.0.0.1", "ephemeral_port": server.server_address[1],
            "server_stopped": True, "requests": results}


def main():
    result = {
        "executed_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "scope": "Synthetic test app; loopback only; fictional identities and reports.",
        "authentication_model": "X-Demo-User simulates already authenticated test identities; not a real login or credential.",
        "executor": "Local Python verification script; not a recorded HackerAI Agent run.",
        "seeded_ownership": {key: value["owner"] for key, value in REPORTS.items()},
        "before": run_variant("missing_object_ownership_check", False),
        "after": run_variant("object_ownership_check_present", True),
        "total_requests": 8,
        "result": "All eight assertions passed. Cross-account synthetic read changed from HTTP200 with Bob's report to HTTP403. Own-account reads remained HTTP200.",
        "human_validation": "Before using this method on an authorized target, a practitioner must confirm record ownership and intended sharing permissions, inspect response content, and retest the fix.",
        "limits": "Illustrates one deliberate object-level access-control flaw. Does not measure HackerAI detection, overall application security, real-world severity, or automatic remediation.",
        "retained_processes": [],
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
