"""Focused input-boundary checks for the RealVuln Agent adapter."""

import asyncio
import importlib.util
import json
from pathlib import Path
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
                 patch.object(run, "checked"), \
                 patch.object(run, "agent_run", agent_run), \
                 patch.object(run.subprocess, "run"), \
                 patch.object(run, "score_with_upstream") as scorer:
                row = await run.run_one(slug, {}, SimpleNamespace(
                    upstream=base, agent_limit_seconds=480,
                    agent_model_context_variant="test",
                ), {}, "unused-image", base / "results")
            self.assertEqual(row["agentStatus"], "unscored_transport_error")
            self.assertEqual(row["transportFailureCount"], 1)
            self.assertNotIn("score", row)
            scorer.assert_not_called()


if __name__ == "__main__":
    unittest.main()
