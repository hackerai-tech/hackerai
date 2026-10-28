"""Focused input-boundary checks for the RealVuln Agent adapter."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
