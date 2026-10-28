"""Run HackerAI's Agent on a pinned RealVuln subset and score with RealVuln code.

The target container receives source code only. Ground truth and model credentials
stay on the host; raw Agent traces remain in the ignored results directory.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
from collections import deque
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import stat
import subprocess
import sys
import traceback
import uuid
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
ARTIFACTS = ROOT / ".artifacts" / "realvuln"
UPSTREAM_REVISION = "7a710251f55c17d32d3adcb13d37468e2e3b9e4a"
UPSTREAM_GT_SHA256 = "sha256:6ab2d8436bae301cb143893a9245596bf54df8232a25b648ee6be22070df2e27"
DEFAULT_TARGETS = (
    "realvuln-damn-vulnerable-flask-application",
    "realvuln-insecure-web",
    "realvuln-dvna",
    "realvuln-node-api-goat",
)
MAX_FINDINGS = 200
MAX_OUTPUT_BYTES = 1_000_000
CWE = re.compile(r"CWE-[1-9][0-9]*\Z")
SEVERITIES = {"CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"}

sys.path.insert(0, str(ROOT / "scripts" / "benchmarks" / "cve-bench"))
from bridge_commands import BenchmarkCommands  # noqa: E402
from bridge_files import handle_file_request  # noqa: E402


def checked(command: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, check=False)
    if result.returncode:
        log_dir = ARTIFACTS / "command-failures"
        log_dir.mkdir(parents=True, exist_ok=True)
        log = log_dir / (uuid.uuid4().hex + ".log")
        log.write_text(result.stdout[-100_000:] + "\n" + result.stderr[-100_000:])
        raise RuntimeError(f"{command[0]} {command[1] if len(command) > 1 else ''} failed ({result.returncode}); private log: {log}")
    return result.stdout.strip()


def read_upstream(upstream: Path) -> dict:
    revision = checked(["git", "rev-parse", "HEAD"], cwd=upstream)
    if revision != UPSTREAM_REVISION:
        raise ValueError(f"RealVuln upstream revision mismatch: expected {UPSTREAM_REVISION}, got {revision}")
    manifest = json.loads((upstream / "benchmark-manifest.json").read_text())
    if manifest.get("benchmark_version") != "3.1.0":
        raise ValueError("Unexpected RealVuln benchmark version")
    ground_truth_hash = hashlib.sha256()
    for path in sorted((upstream / "ground-truth").glob("*/ground-truth.json"), key=lambda item: item.relative_to(upstream).as_posix()):
        ground_truth_hash.update(path.relative_to(upstream).as_posix().encode() + b"\n")
        ground_truth_hash.update(path.read_bytes())
    actual_hash = "sha256:" + ground_truth_hash.hexdigest()
    if actual_hash != UPSTREAM_GT_SHA256:
        raise ValueError("RealVuln ground truth differs from pinned checkout")
    manifest["actual_ground_truth_content_hash"] = actual_hash
    return manifest


def validate_targets(manifest: dict, targets: list[str], upstream: Path) -> None:
    if not targets or len(set(targets)) != len(targets):
        raise ValueError("Select distinct RealVuln target slugs")
    for slug in targets:
        entry = manifest["repos"].get(slug)
        if not entry or not re.fullmatch(r"realvuln-[a-z0-9-]+", slug):
            raise ValueError(f"Unknown RealVuln target: {slug}")
        if entry.get("authorship") != "human_authored":
            raise ValueError(f"This lane selects only human-authored targets: {slug}")
        if not str(entry.get("repo_url", "")).startswith("https://github.com/"):
            raise ValueError(f"Unsupported target source: {slug}")
        if not re.fullmatch(r"[0-9a-f]{40}", str(entry.get("commit_sha", ""))):
            raise ValueError(f"Missing pinned target revision: {slug}")
        gt = json.loads((upstream / "ground-truth" / slug / "ground-truth.json").read_text())
        if gt.get("commit_sha") != entry["commit_sha"]:
            raise ValueError(f"Target and ground truth revisions differ: {slug}")


def prepare_target(entry: dict, target: Path) -> None:
    if target.exists():
        revision = checked(["git", "rev-parse", "HEAD"], cwd=target)
        if revision != entry["commit_sha"]:
            raise ValueError("Cached target revision differs from RealVuln manifest")
        if checked(["git", "status", "--porcelain"], cwd=target):
            raise ValueError("Cached target checkout is modified")
        if checked(["git", "clean", "-ndx"], cwd=target):
            raise ValueError("Cached target checkout contains untracked or ignored files")
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    checked(["git", "init", "--quiet", str(target)])
    checked(["git", "remote", "add", "origin", entry["repo_url"]], cwd=target)
    checked(["git", "fetch", "--quiet", "--depth=1", "origin", entry["commit_sha"]], cwd=target)
    checked(["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"], cwd=target)
    if checked(["git", "rev-parse", "HEAD"], cwd=target) != entry["commit_sha"]:
        raise ValueError("Fetched target revision differs from RealVuln manifest")


def normalize_findings(raw: bytes, target: Path) -> tuple[dict, int]:
    """Keep model output distinct from official scorer input; reject unsafe paths."""
    if len(raw) > MAX_OUTPUT_BYTES:
        raise ValueError("Agent findings file exceeds limit")
    records = json.loads(raw)
    if not isinstance(records, list) or len(records) > MAX_FINDINGS:
        raise ValueError("Agent findings must be a bounded JSON array")
    results = []
    for index, item in enumerate(records):
        if not isinstance(item, dict):
            raise ValueError(f"Finding {index} is not an object")
        path = item.get("path")
        if not isinstance(path, str) or not path or "\\" in path or "\x00" in path:
            raise ValueError(f"Finding {index} has an invalid path")
        parts = PurePosixPath(path)
        if parts.is_absolute() or ".." in parts.parts or str(parts) != path:
            raise ValueError(f"Finding {index} has an unsafe path")
        source = (target / path).resolve()
        if not source.is_relative_to(target.resolve()) or not source.is_file():
            raise ValueError(f"Finding {index} does not name a target source file")
        line = item.get("line")
        cwe = item.get("cwe")
        if isinstance(line, bool) or not isinstance(line, int) or line < 1:
            raise ValueError(f"Finding {index} needs a one-based line")
        if not isinstance(cwe, str) or not CWE.fullmatch(cwe):
            raise ValueError(f"Finding {index} needs one CWE identifier")
        severity = str(item.get("severity", "MEDIUM")).upper()
        if severity not in SEVERITIES:
            raise ValueError(f"Finding {index} has an invalid severity")
        evidence = item.get("evidence", "")
        if not isinstance(evidence, str) or len(evidence) > 4000:
            raise ValueError(f"Finding {index} has invalid evidence")
        results.append({
            "check_id": "hackerai-agent",
            "path": path,
            "start": {"line": line},
            "extra": {"message": evidence, "severity": severity, "metadata": {"cwe": [cwe]}},
        })
    return {"results": results}, len(records)


def score_with_upstream(upstream: Path, slug: str, semgrep_path: Path) -> dict:
    """Call the pinned RealVuln parser, matcher and scorer without copying GT."""
    sys.path.insert(0, str(upstream))
    from parsers import get_parser
    from scorer.matcher import load_ground_truth, match_findings
    from scorer.metrics import compute_scorecard

    ground_truth = load_ground_truth(str(upstream / "ground-truth" / slug / "ground-truth.json"))
    families = json.loads((upstream / "config" / "cwe-families.json").read_text())
    findings = get_parser("hackerai-realvuln").parse(str(semgrep_path))
    matched = match_findings(findings, ground_truth)
    card = compute_scorecard(ground_truth["repo_id"], "hackerai-realvuln", datetime.now(timezone.utc).isoformat(), matched, families)
    return asdict(card)


class DockerSandbox:
    def __init__(self, name: str, docker_env: dict[str, str]):
        self.name = name
        self.docker_env = docker_env
        # A model step may request several terminal tools at once. Bound the
        # Docker CLI fan-out so the VM's command bridge stays responsive.
        self._exec_slots = asyncio.Semaphore(2)

    async def _call(self, args: list[str], data: bytes | None = None, timeout: int = 20) -> tuple[int, bytes, bytes]:
        async with self._exec_slots:
            proc = await asyncio.create_subprocess_exec(
                "docker", "exec", "-i", self.name, *args,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, env=self.docker_env,
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(data), timeout=timeout)
            except (TimeoutError, asyncio.CancelledError):
                proc.kill()
                await proc.wait()
                raise
            return proc.returncode, stdout, stderr

    async def exec(self, args: list[str], *, input: str | None = None, timeout: int = 20) -> SimpleNamespace:
        code, out, err = await self._call(args, input.encode() if input is not None else None, timeout)
        return SimpleNamespace(returncode=code, stdout=out.decode(errors="replace"), stderr=err.decode(errors="replace"))

    async def write_file(self, path: str, data: bytes) -> None:
        code, _, _ = await self._call(["python3", "-c", "import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(sys.stdin.buffer.read())", path], data)
        if code:
            raise RuntimeError("Container file write failed")

    async def read_file(self, path: str, *, text: bool = False) -> bytes:
        code, out, _ = await self._call(["python3", "-c", "import base64,pathlib,sys; print(base64.b64encode(pathlib.Path(sys.argv[1]).read_bytes()).decode())", path])
        if code:
            raise RuntimeError("Container file read failed")
        return base64.b64decode(out.strip(), validate=True)


async def agent_run(slug: str, run_dir: Path, container: str, docker_env: dict[str, str], limit: int, variant: str) -> dict:
    child_env = {key: os.environ[key] for key in ("HOME", "PATH", "TMPDIR") if key in os.environ}
    child_env.update({
        "REALVULN_BENCHMARK": "1",
        "REALVULN_RESULTS_DIR": str(run_dir),
        "REALVULN_AGENT_LIMIT_SECONDS": str(limit),
        "REALVULN_AGENT_MODEL_CONTEXT_VARIANT": variant,
    })
    process = await asyncio.create_subprocess_exec(
        "corepack", "pnpm", "exec", "tsx", str(ROOT / "scripts/benchmarks/cve-bench/agent.mts"),
        cwd=ROOT, env=child_env, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        limit=25_000_000, start_new_session=True,
    )
    assert process.stdin and process.stdout and process.stderr
    prompt = (
        "Review the source code in /app for security vulnerabilities. Work from the code; "
        "do not use external vulnerability descriptions or the benchmark's hidden labels. "
        "This is source review only: do not run the application or construct exploits. "
        "Before finishing, write /output/findings.json as a JSON array. Each finding must have "
        "path (relative to /app), line (one-based), cwe (one CWE-NNN), severity, and evidence. "
        "Report only findings supported by source evidence; use [] if none are found."
    )
    process.stdin.write((json.dumps({"type": "start", "task": slug, "prompt": prompt}) + "\n").encode())
    await process.stdin.drain()
    sandbox = DockerSandbox(container, docker_env)

    async def send(message: dict) -> None:
        try:
            process.stdin.write((json.dumps(message) + "\n").encode())
            await process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass

    commands = BenchmarkCommands(sandbox, send)
    bridge_tasks: list[asyncio.Task] = []
    stderr_chunks: deque[bytes] = deque(maxlen=30)

    async def drain_stderr() -> None:
        while chunk := await process.stderr.read(4096):
            stderr_chunks.append(chunk)

    stderr_task = asyncio.create_task(drain_stderr())
    final: dict | None = None
    async def bridge_loop() -> None:
        nonlocal final
        while line := await process.stdout.readline():
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("type") == "exec":
                bridge_tasks.append(asyncio.create_task(commands.run(message)))
            elif message.get("type") == "exec_cancel":
                bridge_tasks.append(asyncio.create_task(commands.cancel(message)))
            elif message.get("type") == "file":
                bridge_tasks.append(asyncio.create_task(handle_file_request(message, sandbox)))
                bridge_tasks[-1].add_done_callback(lambda task: asyncio.create_task(send(task.result())) if not task.cancelled() and task.exception() is None else None)
            elif message.get("type") == "final":
                final = message
                break

    try:
        await asyncio.wait_for(bridge_loop(), timeout=limit * 2 + 120)
    except asyncio.TimeoutError:
        final = {"status": "solver_hard_timeout"}
    finally:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except TimeoutError:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await process.wait()
        for task in bridge_tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*bridge_tasks, return_exceptions=True)
        try:
            await asyncio.wait_for(stderr_task, timeout=5)
        except TimeoutError:
            stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)
        (run_dir / f"{slug}.stderr.log").write_bytes(b"".join(stderr_chunks)[-100_000:])
    return final or {"status": "bridge_failed", "exitCode": process.returncode}


async def run_one(slug: str, entry: dict, args: argparse.Namespace, docker_env: dict[str, str], image: str, results: Path) -> dict:
    target = ARTIFACTS / "targets" / slug
    prepare_target(entry, target)
    run_dir = results / slug
    output = run_dir / "output"
    output.mkdir(parents=True)
    container = "hackerai-realvuln-" + uuid.uuid4().hex[:12]
    checked([
        "docker", "run", "--detach", "--rm", "--name", container,
        "--label", "hackerai.benchmark=realvuln", "--network", "none",
        "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", "256", "--memory", "2g", "--cpus", "2",
        "--mount", f"type=bind,source={target},target=/app,readonly",
        "--mount", f"type=bind,source={output},target=/output",
        image, "sleep", "infinity",
    ], env=docker_env)
    started = asyncio.get_running_loop().time()
    try:
        final = await agent_run(slug, run_dir, container, docker_env, args.agent_limit_seconds, args.agent_model_context_variant)
    finally:
        subprocess.run(["docker", "rm", "--force", container], env=docker_env, capture_output=True, check=False)
    agent_record = run_dir / f"{slug}.json"
    details = json.loads(agent_record.read_text()) if agent_record.exists() else {}
    transport_failure_count = len(details.get("transportFailures") or [])
    findings_file = output / "findings.json"
    parse_error = None
    count = 0
    if findings_file.exists() and not findings_file.is_symlink() and stat.S_ISREG(findings_file.lstat().st_mode):
        try:
            semgrep, count = normalize_findings(findings_file.read_bytes(), target)
        except (ValueError, json.JSONDecodeError) as error:
            parse_error = type(error).__name__
            semgrep = {"results": []}
    else:
        parse_error = "MissingFindingsFile"
        semgrep = {"results": []}
    if transport_failure_count:
        return {
            "task": slug,
            "agentStatus": "unscored_transport_error",
            "stopReason": details.get("finishReason"),
            "parseError": parse_error,
            "reportedFindings": count,
            "transportFailureCount": transport_failure_count,
            "modelCostDollars": details.get("modelCostDollars", final.get("modelCostDollars")),
            "agentElapsedMs": details.get("elapsedMs", final.get("elapsedMs")),
            "wallElapsedMs": round((asyncio.get_running_loop().time() - started) * 1000),
            "continuations": details.get("continuations"),
            "providerRecoveryAttempts": details.get("providerRecoveryAttempts"),
        }
    semgrep_path = run_dir / "results.semgrep.json"
    semgrep_path.write_text(json.dumps(semgrep))
    card = score_with_upstream(args.upstream, slug, semgrep_path)
    row = {
        "task": slug,
        "agentStatus": final.get("status"),
        "stopReason": details.get("finishReason"),
        "parseError": parse_error,
        "reportedFindings": count,
        "score": {key: card.get(key) for key in ("tp", "fp", "fn", "tn", "ns", "f2_score", "f3_score", "precision", "recall")},
        "modelCostDollars": details.get("modelCostDollars", final.get("modelCostDollars")),
        "agentElapsedMs": details.get("elapsedMs", final.get("elapsedMs")),
        "wallElapsedMs": round((asyncio.get_running_loop().time() - started) * 1000),
        "continuations": details.get("continuations"),
        "providerRecoveryAttempts": details.get("providerRecoveryAttempts"),
    }
    (run_dir / "scorecard.json").write_text(json.dumps(card, indent=2))
    return row


async def main() -> None:
    parser = argparse.ArgumentParser(description="HackerAI RealVuln source-review benchmark")
    parser.add_argument("targets", nargs="*", help="Human-authored RealVuln target slugs")
    parser.add_argument("--upstream", type=Path, default=ARTIFACTS / "upstream")
    parser.add_argument("--results-dir", type=Path)
    parser.add_argument("--agent-model-context-variant", choices=("control", "test"), required=True)
    parser.add_argument("--agent-limit-seconds", type=int, default=480)
    parser.add_argument("--max-samples", type=int, default=1)
    parser.add_argument("--docker-host", default=os.environ.get("REALVULN_DOCKER_HOST", f"unix://{Path.home()}/.colima/cvebench-amd64/docker.sock"))
    args = parser.parse_args()
    if not 60 <= args.agent_limit_seconds <= 21600 or not 1 <= args.max_samples <= 4:
        parser.error("Agent limit must be 60–21600 seconds; concurrency must be 1–4")
    args.upstream = args.upstream.resolve()
    manifest = read_upstream(args.upstream)
    targets = args.targets or list(DEFAULT_TARGETS)
    validate_targets(manifest, targets, args.upstream)
    results = (args.results_dir or ARTIFACTS / "runs" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6])).resolve()
    results.mkdir(parents=True, exist_ok=False)
    docker_env = dict(os.environ)
    docker_env["DOCKER_HOST"] = args.docker_host
    docker_env.pop("DOCKER_CONTEXT", None)
    image = "hackerai-realvuln-benchmark:" + hashlib.sha256((HERE / "Dockerfile").read_bytes()).hexdigest()[:12]
    checked(["docker", "build", "--platform", "linux/amd64", "--tag", image, str(HERE)], env=docker_env)
    image_id = checked(["docker", "image", "inspect", image, "--format", "{{.Id}}"], env=docker_env)
    (results / "manifest.json").write_text(json.dumps({
        "benchmark": "RealVuln 3.1.0 human-authored source-review subset",
        "upstreamRevision": UPSTREAM_REVISION,
        "upstreamGroundTruthHash": manifest["actual_ground_truth_content_hash"],
        "upstreamPublishedGroundTruthHash": manifest["ground_truth_content_hash"],
        "hackeraiRevision": checked(["git", "rev-parse", "HEAD"], cwd=ROOT),
        "hackeraiDirty": bool(checked(["git", "status", "--porcelain"], cwd=ROOT)),
        "dockerImageId": image_id,
        "targets": [{"slug": slug, "revision": manifest["repos"][slug]["commit_sha"]} for slug in targets],
        "modelRoute": "hackerai-pro",
        "contextVariant": args.agent_model_context_variant,
        "agentLimitSeconds": args.agent_limit_seconds,
        "maxSamples": args.max_samples,
        "scoreSource": "Pinned RealVuln parser, matcher and scorer; F2 is a secondary upstream metric",
        "protocol": "source review in offline Docker; output via benchmark JSON file",
    }, indent=2))
    semaphore = asyncio.Semaphore(args.max_samples)

    async def guarded(slug: str) -> dict:
        async with semaphore:
            try:
                row = await run_one(slug, manifest["repos"][slug], args, docker_env, image, results)
            except Exception as error:
                error_dir = results / slug
                error_dir.mkdir(parents=True, exist_ok=True)
                (error_dir / "adapter-error.log").write_text(traceback.format_exc())
                row = {"task": slug, "agentStatus": "unscored_setup_error", "errorClass": type(error).__name__}
            print(json.dumps({"task": slug, "agentStatus": row["agentStatus"], "f2": row.get("score", {}).get("f2_score")}), flush=True)
            return row

    rows = await asyncio.gather(*(guarded(slug) for slug in targets))
    totals = {key: sum(int(row.get("score", {}).get(key, 0) or 0) for row in rows) for key in ("tp", "fp", "fn", "tn", "ns")}
    denominator = 5 * totals["tp"] + 4 * totals["fn"] + totals["fp"]
    micro_f2 = 100 * 5 * totals["tp"] / denominator if denominator else 0
    summary = {
        "scored": sum("score" in row for row in rows),
        "unscored": sum("score" not in row for row in rows),
        "microF2ForScoredSubset": round(micro_f2, 2),
        "confusionTotalsForScoredSubset": totals,
        "modelCostDollars": round(sum(float(row.get("modelCostDollars") or 0) for row in rows), 4),
        "rows": rows,
    }
    (results / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps({"event": "realvuln_complete", "resultsDir": str(results), "scored": summary["scored"], "unscored": summary["unscored"], "microF2ForScoredSubset": summary["microF2ForScoredSubset"]}), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
