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

    def test_account_workspace_and_known_unhealthy_probe_block_paid_run(self):
        client = object.__new__(backend.ProductBackend)
        responses = {
            "/api/entitlements": {"subscription": "free"},
            "/api/sandbox/workspaces": {"status": "selected"},
            "/api/health/trigger-agent-mode": {"ok": True, "status": "healthy", "source": "trigger_probe"},
        }
        client.json = lambda _method, path, **_options: responses[path]
        with self.assertRaises(backend.BackendError):
            client.preflight()
        responses["/api/entitlements"] = {"subscription": "pro"}
        responses["/api/sandbox/workspaces"] = {"status": "unavailable"}
        with self.assertRaises(backend.BackendError):
            client.preflight()
        responses["/api/sandbox/workspaces"] = {"status": "selected"}
        responses["/api/health/trigger-agent-mode"] = {
            "ok": False, "status": "failing", "source": "trigger_probe", "error": "trigger_probe_failed",
        }
        with self.assertRaises(backend.BackendError):
            client.preflight()

    def test_preview_missing_cron_snapshot_is_recorded_without_claiming_health(self):
        client = object.__new__(backend.ProductBackend)
        responses = {
            "/api/entitlements": {"subscription": "pro"},
            "/api/sandbox/workspaces": {"status": "empty"},
            "/api/health/trigger-agent-mode": {
                "ok": False, "status": "unknown", "source": "trigger_probe",
                "error": "health_data_unavailable",
            },
        }
        options = []

        def read(_method, path, **kwargs):
            options.append((path, kwargs))
            return responses[path]

        client.json = read
        self.assertEqual(client.preflight(), {
            "subscription": "pro", "workspaceStatus": "empty",
            "triggerHealth": "preview_cron_snapshot_unavailable",
        })
        self.assertEqual(options[-1], ("/api/health/trigger-agent-mode", {"accepted_statuses": (503,)}))

    def test_expected_preview_health_503_body_can_be_read_without_ignoring_other_503s(self):
        class Opener:
            def open(self, request, timeout):
                raise backend.urllib.error.HTTPError(
                    request.full_url, 503, "Service Unavailable", {},
                    io.BytesIO(b'{"ok":false,"source":"trigger_probe","status":"unknown","error":"health_data_unavailable"}'),
                )

        client = object.__new__(backend.ProductBackend)
        client.origin = "https://hackerai-git-test.vercel.app"
        client.lock = threading.Lock()
        client.opener = Opener()
        client.access_headers = {}
        with self.assertRaises(backend.BackendError):
            client.json("GET", "/api/health/trigger-agent-mode")
        self.assertEqual(
            client.json("GET", "/api/health/trigger-agent-mode", accepted_statuses=(503,))["error"],
            "health_data_unavailable",
        )

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

    def test_agent_start_requires_trigger_stream_access_for_scoring(self):
        client = object.__new__(backend.ProductBackend)
        response = {"chatId": "chat-1", "runId": "run-1"}
        client.json = lambda *_args, **_kwargs: response
        with self.assertRaises(backend.BackendError):
            client.start("chat-1", "bounded test")
        response["publicAccessToken"] = "ephemeral-test-token"
        self.assertEqual(client.start("chat-1", "bounded test"), {
            "runId": "run-1", "publicAccessToken": "ephemeral-test-token",
        })

    def test_auto_continuation_carries_saved_todos_into_product_request(self):
        todos = [{"id": "task-1", "content": "Review source", "status": "in_progress"}]
        message = {"role": "assistant", "parts": [{
            "type": "tool-todo_write", "state": "output-available",
            "output": {"currentTodos": todos},
        }]}
        events = [{"type": "data-appendMessage", "data": json.dumps(message)}]
        self.assertEqual(backend.latest_saved_todos(events), todos)

        client = object.__new__(backend.ProductBackend)
        payloads = []

        def start(_method, _path, payload):
            payloads.append(payload)
            return {"chatId": "chat-1", "runId": "run-2", "publicAccessToken": "test-token"}

        client.json = start
        client.start("chat-1", backend.AUTO_CONTINUE_PROMPT, automatic=True,
                     todos=backend.latest_saved_todos(events))
        self.assertEqual(payloads[0]["todos"], todos)
        self.assertTrue(payloads[0]["messages"][0]["metadata"]["isAutoContinue"])
        self.assertTrue(payloads[0]["isAutomaticContinuation"])

        message["parts"][0]["output"] = {"currentTodos": [{"id": "task-1", "status": "pending"}]}
        with self.assertRaises(backend.BackendError):
            backend.latest_saved_todos([{"type": "data-appendMessage", "data": json.dumps(message)}])

    def test_product_request_can_select_an_authenticated_remote_connection(self):
        client = object.__new__(backend.ProductBackend)
        payloads = []

        def start(_method, _path, payload):
            payloads.append(payload)
            return {"chatId": "chat-1", "runId": "run-1", "publicAccessToken": "test-token"}

        client.json = start
        client.start("chat-1", "bounded task", sandbox_preference="connection-1")
        self.assertEqual(payloads[0]["sandboxPreference"], "connection-1")
        self.assertEqual(payloads[0]["selectedModel"], "hackerai-pro")

    def test_existing_vercel_session_cookie_reaches_only_preview_origin(self):
        client = backend.ProductBackend(
            "https://hackerai-git-test.vercel.app", "sealed-test-session",
            vercel_auth_cookie="short-lived-test-cookie",
        )
        same_origin = backend.urllib.request.Request("https://hackerai-git-test.vercel.app/api/entitlements")
        different_origin = backend.urllib.request.Request("https://another.example/api/entitlements")
        client.cookies.add_cookie_header(same_origin)
        client.cookies.add_cookie_header(different_origin)
        self.assertIn("_vercel_jwt=short-lived-test-cookie", same_origin.get_header("Cookie"))
        self.assertIsNone(different_origin.get_header("Cookie"))

    def test_protected_backend_requests_do_not_follow_redirects(self):
        self.assertIsNone(backend.NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere.example"))

    def test_official_scorecard_shape_must_be_valid_before_scoring(self):
        card = {"tp": 1, "fp": 2, "fn": 3, "f2_score": 41.7, "f3_score": 35.0}
        self.assertEqual(backend.official_score_fields(card), card)
        for invalid in ({**card, "fn": None}, {**card, "tp": True}, {**card, "f2_score": 121}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                backend.official_score_fields(invalid)

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
                return {"runId": "run-1", "publicAccessToken": "test-token"}

            def status(self, _chat_id, _run_id):
                return {"status": "COMPLETED", "terminal": True}

        client = FakeClient()
        async def missing_stream(*_args):
            return {"agentWork": False, "finish": False, "autoContinue": False}

        with tempfile.TemporaryDirectory() as directory:
            results = Path(directory)
            entry = {"repo_url": "https://github.com/example/source", "commit_sha": "a" * 40}
            with patch.object(backend, "observe_trigger", missing_stream):
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
