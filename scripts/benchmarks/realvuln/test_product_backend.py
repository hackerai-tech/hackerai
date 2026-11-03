import io
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.benchmarks.realvuln import product_backend as backend


class ProductBackendContractTests(unittest.TestCase):
    def test_only_preview_origin_is_accepted(self):
        self.assertEqual(
            backend.preview_url("https://hackerai-git-test.vercel.app/"),
            "https://hackerai-git-test.vercel.app",
        )
        for origin in (
            "https://hackerai.co",
            "http://test.vercel.app",
            "https://test.vercel.app/path",
            "https://hackerai-git-test.vercel.app:8443",
            "https://attacker.vercel.app",
        ):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                backend.preview_url(origin)

    def test_account_and_trigger_health_are_required_before_paid_run(self):
        client = object.__new__(backend.ProductBackend)
        client.json = lambda _method, path: (
            {"subscription": "free"} if path == "/api/entitlements" else {"ok": True, "source": "trigger_probe"}
        )
        with self.assertRaises(backend.BackendError):
            client.preflight()
        client.json = lambda _method, path: (
            {"subscription": "pro"} if path == "/api/entitlements" else {"ok": False, "source": "trigger_probe"}
        )
        with self.assertRaises(backend.BackendError):
            client.preflight()

    def test_saved_answer_must_be_exact_json_array(self):
        message = {"role": "assistant", "parts": [{"type": "text", "text": "[]"}]}
        events = [{"type": "data-appendMessage", "data": json.dumps(message)}]
        self.assertEqual(backend.parse_findings_text(backend.latest_assistant_text(events)), b"[]")
        for answer in ("Here are findings: []", "```json\n[]\n```", ""):
            with self.subTest(answer=answer), self.assertRaises(ValueError):
                backend.parse_findings_text(answer)

    def test_saved_answer_excludes_narration_before_a_tool_call(self):
        message = {"role": "assistant", "parts": [
            {"type": "text", "text": "I will inspect the code."},
            {"type": "tool-run_terminal_cmd", "output": "omitted"},
            {"type": "text", "text": "[]"},
        ]}
        events = [{"type": "data-appendMessage", "data": json.dumps(message)}]
        self.assertEqual(backend.latest_assistant_text(events), "[]")

    def test_truncated_http_response_is_a_retryable_backend_error(self):
        class Opener:
            def open(self, _request, timeout):
                class Response:
                    def __enter__(self):
                        return self

                    def __exit__(self, *_args):
                        return None

                    def read(self, _limit):
                        raise http.client.IncompleteRead(b"partial")

                return Response()

        client = object.__new__(backend.ProductBackend)
        client.origin = "https://hackerai-git-test.vercel.app"
        client.lock = threading.Lock()
        client.opener = Opener()
        client.access_headers = {}
        with self.assertRaises(backend.BackendError) as raised:
            client.request("GET", "/api/entitlements")
        self.assertTrue(raised.exception.retryable)

    def test_preview_protection_header_reaches_backend_requests(self):
        class Opener:
            seen_header = None

            def open(self, request, timeout):
                self.seen_header = request.get_header("X-vercel-trusted-oidc-idp-token")
                return io.BytesIO(b"{}")

        client = backend.ProductBackend(
            "https://hackerai-git-test.vercel.app", "sealed-test-session", "short-lived-test-token",
        )
        client.opener = Opener()
        self.assertEqual(client.request("GET", "/api/entitlements"), b"{}")
        self.assertEqual(client.opener.seen_header, "short-lived-test-token")

    def test_protected_backend_requests_do_not_follow_redirects(self):
        self.assertIsNone(backend.NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere.example"))

    def test_empty_replay_backs_off_before_reconnecting(self):
        class Response(io.BytesIO):
            status = 200

        class Opener:
            def open(self, _request, timeout):
                return Response(b"data: [DONE]\n\n")

        class Stop:
            waits = 0

            def is_set(self):
                return self.waits > 0

            def wait(self, _seconds):
                self.waits += 1

        client = object.__new__(backend.ProductBackend)
        client.origin = "https://hackerai-git-test.vercel.app"
        client.lock = threading.Lock()
        client.opener = Opener()
        client.access_headers = {}
        stop = Stop()
        client.observe("chat", stop, {})
        self.assertEqual(stop.waits, 1)

    def test_official_scorecard_shape_must_be_valid_before_scoring(self):
        card = {"tp": 1, "fp": 2, "fn": 3, "f2_score": 41.7, "f3_score": 35.0}
        self.assertEqual(backend.official_score_fields(card), card)
        for invalid in ({**card, "fn": None}, {**card, "tp": True}, {**card, "f2_score": 121}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                backend.official_score_fields(invalid)

    def test_live_stream_records_product_continuation_signal(self):
        class Response(io.BytesIO):
            status = 200

        class Opener:
            def open(self, _request, timeout):
                self.timeout = timeout
                return Response(
                    b'data: {"type":"text-delta","delta":"work"}\n\n'
                    b'data: {"type":"data-auto-continue","data":{}}\n\n'
                    b'data: [DONE]\n\n'
                )

        client = object.__new__(backend.ProductBackend)
        client.origin = "https://example.vercel.app"
        client.lock = threading.Lock()
        client.opener = Opener()
        client.access_headers = {}
        observed = {}
        client.observe("chat", threading.Event(), observed)
        self.assertEqual(observed.get("agentWork"), True)
        self.assertEqual(observed.get("autoContinue"), True)
        self.assertEqual(observed.get("done"), True)


class ProductBackendRunTests(unittest.IsolatedAsyncioTestCase):
    async def test_status_poll_recovers_from_two_transient_read_failures(self):
        class FakeClient:
            calls = 0

            def status(self, _chat_id, _run_id):
                self.calls += 1
                if self.calls < 3:
                    raise backend.BackendError("status unavailable", retryable=True)
                return {"status": "COMPLETED", "terminal": True}

        async def no_delay(_seconds):
            return None

        client = FakeClient()
        with patch.object(backend.asyncio, "sleep", no_delay):
            self.assertEqual(await backend.wait_run(client, "chat", "run", backend.time.monotonic() + 30), "COMPLETED")
        self.assertEqual(client.calls, 3)

    async def test_missing_live_stream_stays_unscored_and_does_not_duplicate(self):
        class FakeClient:
            starts = 0

            def start(self, _chat_id, _message):
                self.starts += 1
                return "run-1"

            def status(self, _chat_id, _run_id):
                return {"status": "COMPLETED", "terminal": True}

            def observe(self, _chat_id, _stop, _observed):
                return None

        client = FakeClient()
        with tempfile.TemporaryDirectory() as directory:
            results = Path(directory)
            entry = {"repo_url": "https://github.com/example/source", "commit_sha": "a" * 40}
            row = await backend.run_target(client, "realvuln-test", entry, results, results, 60)
            self.assertEqual(row["agentStatus"], "unscored_backend_or_protocol_error")
            self.assertFalse((results / "realvuln-test" / "scorecard.json").exists())
            with self.assertRaises(FileExistsError):
                await backend.run_target(client, "realvuln-test", entry, results, results, 60)
            self.assertEqual(client.starts, 1)

    async def test_uncertain_start_preserves_identity_and_stops_suite(self):
        class FakeClient:
            def start(self, _chat_id, _message):
                raise backend.BackendError("start response lost")

            def observe(self, _chat_id, _stop, _observed):
                return None

        with tempfile.TemporaryDirectory() as directory:
            results = Path(directory)
            entry = {"repo_url": "https://github.com/example/source", "commit_sha": "a" * 40}
            with self.assertRaises(backend.BackendError):
                await backend.run_target(FakeClient(), "realvuln-test", entry, results, results, 60)
            state = json.loads((results / "realvuln-test" / "active.json").read_text())
            self.assertEqual(state["phase"], "needs_intervention")
            self.assertTrue(state["chatId"])


if __name__ == "__main__":
    unittest.main()
