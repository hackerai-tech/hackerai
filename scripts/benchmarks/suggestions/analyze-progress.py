#!/usr/bin/env python3
"""Analyze fixed paired synthetic cases; never select or mutate live users."""
import hashlib
import json
import math
import pathlib
import random
import statistics
import sys


def cluster_interval(differences, seed=20261108, samples=10000):
    """Resample whole cases, preserving paired arms, repeats and reviewers."""
    if not differences:
        return None
    rng = random.Random(seed)
    draws = sorted(statistics.mean(rng.choices(differences, k=len(differences))) for _ in range(samples))
    return [draws[int(samples * .025)], draws[int(samples * .975) - 1]]


def analyze(directory):
    """Require complete blinded reviews and retain failed/nonempty denominators."""
    directory = pathlib.Path(directory)
    plan = json.loads((directory / "plan.json").read_text())
    if plan["manifest"].get("suite") != "task-progress":
        raise ValueError("Expected the task-progress protocol")
    receipts = [json.loads(s) for s in (directory / "receipts.jsonl").read_text().splitlines() if s]
    expected = {r["id"] for r in plan["rows"]}
    if len(receipts) != len(expected) or {r["id"] for r in receipts} != expected:
        raise ValueError("Incomplete or duplicate generation receipts")
    for receipt in receipts:
        cost = receipt["costUsd"]
        if type(receipt["providerCalls"]) is not int or receipt["providerCalls"] not in (0, 1):
            raise ValueError("Invalid generation call count")
        if cost is not None and (type(cost) not in (int, float) or not math.isfinite(cost) or cost < 0):
            raise ValueError("Invalid reported generation USD")
        if receipt["providerCalls"] == 0 and cost != 0:
            raise ValueError("A non-call cannot carry unknown or positive provider cost")
    reviews = {r["reviewId"]: r for r in json.loads((directory / "blind-review.json").read_text())}
    score_sets, requests = {}, []
    for reviewer in ["grok", "glm"]:
        report = json.loads((directory / (reviewer + "-scores.json")).read_text())
        if not report.get("complete"):
            raise ValueError("Independent reviewer incomplete")
        scores = [s for row in report["rows"] for s in row["scores"]]
        if len(scores) != len(reviews) or {s["id"] for s in scores} != set(reviews):
            raise ValueError("Reviewer ID coverage mismatch")
        for score in scores:
            for field in ["taskProgress", "usefulness"]:
                if type(score[field]) is not int or not 0 <= score[field] <= 3:
                    raise ValueError("Invalid rating")
            if any(type(score[f]) is not bool for f in ["factualFailure", "toolTrustFailure", "ignoresStop"]):
                raise ValueError("Invalid factual-failure flag")
        score_sets[reviewer] = {s["id"]: s for s in scores}
        for request in report["rows"] + report.get("failedAttempts", []):
            cost = request["costUsd"]
            if cost is not None and (type(cost) not in (int, float) or not math.isfinite(cost) or cost < 0):
                raise ValueError("Invalid reported evaluator USD")
            requests.append(request)
    rows = []
    for request in plan["rows"]:
        rid = hashlib.sha256((plan["manifest"]["fixtureHash"] + request["id"]).encode()).hexdigest()[:20]
        review = reviews[rid]
        scores = {r: score_sets[r][rid] for r in score_sets}
        if review["expectation"] == "suggest" and (review["unavailable"] or review["suggestion"] is None):
            if any(s["taskProgress"] != 0 or s["usefulness"] != 0 for s in scores.values()):
                raise ValueError("Missing continuation was not scored as zero")
        rows.append(dict(request, review=review, scores=scores))
    active = [r for r in rows if r["review"]["expectation"] == "suggest"]
    cases = sorted({r["caseId"] for r in active})
    metric = lambda r: statistics.mean(s["taskProgress"] for s in r["scores"].values())
    differences = [statistics.mean(metric(r) for r in active if r["caseId"] == case and r["arm"] == 1) -
                   statistics.mean(metric(r) for r in active if r["caseId"] == case and r["arm"] == 0) for case in cases]
    arms = []
    for arm in [0, 1]:
        arm_rows = [r for r in rows if r["arm"] == arm]
        needed = [r for r in active if r["arm"] == arm]
        closed = [r for r in arm_rows if r["review"]["expectation"] == "silence"]
        model_closed = [r for r in closed if not r.get("skip", False)]
        arms.append({"arm": arm, "continuation_runs": len(needed), "continuation_cases": len(cases),
                     "mean_task_progress": statistics.mean(metric(r) for r in needed),
                     "per_reviewer_progress": {name: statistics.mean(r["scores"][name]["taskProgress"] for r in needed) for name in score_sets},
                     "useful_nonempty_agreed": sum(r["review"]["suggestion"] is not None and all(s["taskProgress"] >= 2 and s["usefulness"] >= 2 for s in r["scores"].values()) for r in needed),
                     "closed_runs": len(closed), "unwanted_closed_followups": sum(r["review"]["suggestion"] is not None for r in closed),
                     "explicit_stop_batches": sum(bool(r.get("skip")) for r in arm_rows),
                     "model_completed_runs": len(model_closed), "unwanted_model_completed_followups": sum(r["review"]["suggestion"] is not None for r in model_closed)})
    flags = [{"id": r["review"]["reviewId"], "caseId": r["caseId"], "arm": r["arm"],
              "context": r["review"]["context"], "suggestion": r["review"]["suggestion"], "scores": r["scores"]} for r in rows
             if any(s[f] for s in r["scores"].values() for f in ["factualFailure", "toolTrustFailure", "ignoresStop"])]
    return {"split": plan["manifest"]["split"], "arms": arms,
            "paired_progress_difference": statistics.mean(differences), "scenario_bootstrap_95_interval": cluster_interval(differences),
            "flags_for_adjudication": flags, "generation_batches": len(rows),
            "generation_requests": sum(r["providerCalls"] for r in receipts),
            "known_generation_usd": sum(r["costUsd"] for r in receipts if r["costUsd"] is not None),
            "unknown_generation_requests": sum(r["providerCalls"] for r in receipts if r["costUsd"] is None),
            "known_evaluator_usd": sum(r["costUsd"] for r in requests if r["costUsd"] is not None),
            "evaluator_attempts": len(requests), "unknown_evaluator_attempts": sum(r["costUsd"] is None for r in requests),
            "limitation": "Synthetic model evaluations; not human ratings, task success or causal customer benefit. No automatic promotion."}


if __name__ == "__main__":
    print(json.dumps(analyze(sys.argv[1]), indent=2, ensure_ascii=False))
