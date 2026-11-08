"""Deterministic calibration for paired task-progress scoring and coverage."""
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("progress_analysis", HERE / "analyze-progress.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ProgressAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.rows, self.reviews, self.receipts, self.scores = [], [], [], []
        for case in ["continue", "finished"]:
            for arm in [0, 1]:
                for repeat in [0, 1]:
                    ident = f"{case}-{repeat}-{arm}"
                    rid = hashlib.sha256(("fixed" + ident).encode()).hexdigest()[:20]
                    self.rows.append(dict(id=ident, caseId=case, arm=arm, repeat=repeat))
                    self.receipts.append(dict(id=ident, providerCalls=1, costUsd=0))
                    self.reviews.append(dict(reviewId=rid, expectation="suggest" if case == "continue" else "silence",
                                             unavailable=False, suggestion="next step" if case == "continue" else None,
                                             context=[]))
                    progress = 1 + 2 * arm if case == "continue" else 0
                    self.scores.append(dict(id=rid, taskProgress=progress, usefulness=progress if case == "continue" else 3,
                                            factualFailure=False, toolTrustFailure=False, ignoresStop=False))
        self.write()

    def tearDown(self):
        self.temporary.cleanup()

    def write(self):
        (self.root / "plan.json").write_text(json.dumps(dict(manifest=dict(suite="task-progress", split="holdout", fixtureHash="fixed"), rows=self.rows)))
        (self.root / "receipts.jsonl").write_text("\n".join(json.dumps(r) for r in self.receipts))
        (self.root / "blind-review.json").write_text(json.dumps(self.reviews))
        for name in ["grok", "glm"]:
            failed = [dict(costUsd=.02)] if name == "grok" else []
            (self.root / (name + "-scores.json")).write_text(json.dumps(dict(complete=True, rows=[dict(scores=self.scores, costUsd=0)], failedAttempts=failed)))

    def test_finished_cases_do_not_inflate_primary_and_billed_evaluator_failures_remain(self):
        result = MODULE.analyze(self.root)
        self.assertEqual(result["paired_progress_difference"], 2)
        self.assertEqual(result["scenario_bootstrap_95_interval"], [2, 2])
        self.assertEqual([a["continuation_runs"] for a in result["arms"]], [2, 2])
        self.assertEqual([a["mean_task_progress"] for a in result["arms"]], [1, 3])
        self.assertAlmostEqual(result["known_evaluator_usd"], .02)
        self.assertEqual(result["generation_requests"], 8)

    def test_missing_continuation_cannot_be_rewarded_as_success(self):
        self.reviews[0]["suggestion"] = None
        self.write()
        with self.assertRaisesRegex(ValueError, "Missing continuation"):
            MODULE.analyze(self.root)

    def test_missing_duplicate_or_invalid_measurements_fail_closed(self):
        for invalid in [-1, float("nan"), float("inf"), True]:
            self.receipts[0]["costUsd"] = invalid
            self.write()
            with self.assertRaisesRegex(ValueError, "Invalid reported generation USD"):
                MODULE.analyze(self.root)
        self.receipts[0]["costUsd"] = None
        self.write()
        self.assertEqual(MODULE.analyze(self.root)["unknown_generation_requests"], 1)
        self.receipts[-1] = self.receipts[0]
        self.write()
        with self.assertRaisesRegex(ValueError, "Incomplete or duplicate"):
            MODULE.analyze(self.root)


if __name__ == "__main__":
    unittest.main()
