"""Focused input-boundary checks for the RealVuln Agent adapter."""

import asyncio
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("run.py")
SPEC = importlib.util.spec_from_file_location("realvuln_benchmark_run", MODULE_PATH)
assert SPEC and SPEC.loader
run = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(run)


class FindingConversionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.target = Path(self.temp.name)
        (self.target / "src").mkdir()
        (self.target / "src" / "example.py").write_text("x = 1\n")

    def test_valid_findings_keep_duplicates_for_upstream_precision_scoring(self):
        finding = {
            "path": "src/example.py", "line": 1, "cwe": "CWE-79",
            "severity": "high", "evidence": "Source evidence",
        }
        semgrep, count = run.normalize_findings(json.dumps([finding, finding]).encode(), self.target)
        self.assertEqual(count, 2)
        self.assertEqual(len(semgrep["results"]), 2)
        self.assertEqual(semgrep["results"][0]["extra"]["metadata"]["cwe"], ["CWE-79"])

    def test_rejects_paths_outside_target_and_missing_cwe(self):
        for path, cwe in (("../secret.py", "CWE-79"), ("/etc/passwd", "CWE-79"), ("src/example.py", "unknown")):
            with self.subTest(path=path, cwe=cwe):
                finding = {"path": path, "line": 1, "cwe": cwe}
                with self.assertRaises(ValueError):
                    run.normalize_findings(json.dumps([finding]).encode(), self.target)

    def test_missing_output_is_not_a_valid_empty_submission(self):
        with self.assertRaises(json.JSONDecodeError):
            run.normalize_findings(b"", self.target)
        semgrep, count = run.normalize_findings(b"[]", self.target)
        self.assertEqual(count, 0)
        self.assertEqual(semgrep, {"results": []})

    def test_oversized_findings_are_rejected_before_loading(self):
        path = self.target / "findings.json"
        with path.open("wb") as output:
            output.truncate(run.MAX_OUTPUT_BYTES + 1)
        with self.assertRaises(ValueError):
            run.read_bounded_findings(path)

    def test_fifo_findings_are_rejected_without_waiting_for_a_writer(self):
        path = self.target / "findings.json"
        os.mkfifo(path)
        def timeout(*_):
            raise TimeoutError("Opening Agent output blocked on a FIFO")
        previous = signal.signal(signal.SIGALRM, timeout)
        signal.alarm(2)
        try:
            with self.assertRaises(ValueError):
                run.read_bounded_findings(path)
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)


class CommandBoundaryTests(unittest.TestCase):
    def test_timed_out_command_preserves_private_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(run, "ARTIFACTS", Path(directory)), \
             patch.object(run.subprocess, "run", side_effect=subprocess.TimeoutExpired(
                 ["docker", "build"], 1, output=b"private stdout", stderr=b"private stderr")) as execute:
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                run.checked(["docker", "build"], timeout=1)
            self.assertEqual(execute.call_args.kwargs["timeout"], 1)
            logs = list((Path(directory) / "command-failures").glob("*.log"))
            self.assertEqual(len(logs), 1)
            self.assertIn("private stderr", logs[0].read_text())


class BridgeReliabilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_docker_exec_fanout_is_bounded(self):
        active = 0
        peak = 0

        class FakeProcess:
            returncode = 0

            async def communicate(self, data):
                nonlocal active, peak
                active += 1
                peak = max(peak, active)
                await asyncio.sleep(0.01)
                active -= 1
                return b"", b""

        async def spawn(*args, **kwargs):
            return FakeProcess()

        with patch.object(run.asyncio, "create_subprocess_exec", spawn):
            sandbox = run.DockerSandbox("isolated-target", {})
            await asyncio.gather(*(sandbox.exec(["true"]) for _ in range(8)))
        self.assertEqual(peak, 2)

    async def test_transport_failure_is_unscored_even_when_agent_stops_normally(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            slug = "realvuln-test"

            async def agent_run(slug, run_dir, container, docker_env, limit, variant):
                (run_dir / f"{slug}.json").write_text(json.dumps({
                    "finishReason": "stop",
                    "transportFailures": [{"operation": "command", "errorClass": "TimeoutError"}],
                }))
                return {"status": "finished"}

            with patch.object(run, "ARTIFACTS", base), \
                 patch.object(run, "prepare_target"), \
                 patch.object(run, "checked") as docker_run, \
                 patch.object(run, "agent_run", agent_run), \
                 patch.object(run.subprocess, "run", return_value=SimpleNamespace(returncode=0, stderr=b"")), \
                 patch.object(run, "score_with_upstream") as scorer:
                row = await run.run_one(slug, {}, SimpleNamespace(
                    upstream=base, agent_limit_seconds=480,
                    agent_model_context_variant="test",
                ), {}, "unused-image", base / "results")
            self.assertEqual(row["agentStatus"], "unscored_transport_error")
            self.assertEqual(row["transportFailureCount"], 1)
            self.assertNotIn("score", row)
            scorer.assert_not_called()
            self.assertIn("--init", docker_run.call_args.args[0])

    async def test_missing_agent_record_and_cleanup_timeout_are_unscored(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            slug = "realvuln-test"

            async def failed_agent(*args, **kwargs):
                return {"status": "bridge_failed"}

            with patch.object(run, "ARTIFACTS", base), \
                 patch.object(run, "prepare_target"), \
                 patch.object(run, "checked"), \
                 patch.object(run, "agent_run", failed_agent), \
                 patch.object(run.subprocess, "run", side_effect=subprocess.TimeoutExpired(
                     ["docker", "rm"], 20)), \
                 patch.object(run, "score_with_upstream") as scorer:
                row = await run.run_one(slug, {}, SimpleNamespace(
                    upstream=base, agent_limit_seconds=480,
                    agent_model_context_variant="test",
                ), {}, "unused-image", base / "results")
            self.assertEqual(row["agentStatus"], "unscored_infrastructure_error")
            self.assertEqual(row["transportFailureCount"], 0)
            self.assertTrue(row["infrastructureFailure"])
            self.assertNotIn("score", row)
            self.assertTrue((base / "results" / slug / "docker-cleanup-error.log").exists())
            scorer.assert_not_called()

    async def test_uncertain_container_launch_still_attempts_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            with patch.object(run, "ARTIFACTS", base), \
                 patch.object(run, "prepare_target"), \
                 patch.object(run, "checked", side_effect=RuntimeError("docker launch timed out")), \
                 patch.object(run.subprocess, "run", return_value=SimpleNamespace(returncode=0, stderr=b"")) as cleanup:
                with self.assertRaisesRegex(RuntimeError, "launch timed out"):
                    await run.run_one("realvuln-test", {}, SimpleNamespace(
                        upstream=base, agent_limit_seconds=480,
                        agent_model_context_variant="test",
                    ), {}, "unused-image", base / "results")
            self.assertEqual(cleanup.call_args.args[0][:3], ["docker", "rm", "--force"])


if __name__ == "__main__":
    unittest.main()
