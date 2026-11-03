"""Run RealVuln through the authenticated HackerAI Agent backend.

The Agent is started by /api/agent and executed by Trigger. This driver never
imports or reconstructs the Agent prompt, tools, skills, or model loop.
"""

from __future__ import annotations

import argparse
import asyncio
import http.client
import http.cookiejar
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from scripts.benchmarks.realvuln import run as official

AUTO_CONTINUE_PROMPT = (
    "Continue from the latest saved progress. Do not restart the original task "
    "or repeat completed work."
)
PAID_TIERS = {"pro"}
TERMINAL_STATUSES = {"COMPLETED", "CANCELED", "FAILED", "CRASHED", "SYSTEM_FAILURE", "EXPIRED", "TIMED_OUT", "DETACHED"}
MAX_RESPONSE_BYTES = 5_000_000


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def preview_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port is not None or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError("Use a bare HTTPS Preview origin")
    if not re.fullmatch(r"hackerai-[a-z0-9-]+\.vercel\.app", parsed.hostname):
        raise ValueError("This runner requires a verified HackerAI Preview deployment")
    return value.rstrip("/")


def clean_revision(path: Path) -> str:
    revision = subprocess.check_output(
        ["git", "-C", str(path), "rev-parse", "HEAD"], text=True, timeout=15,
    ).strip()
    if subprocess.check_output(
        ["git", "-C", str(path), "status", "--porcelain"], text=True, timeout=15,
    ).strip():
        raise ValueError("A scored run requires clean pinned checkouts")
    return revision


class BackendError(Exception):
    """A sanitized backend error; never include a response body or cookie."""

    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        # Never forward the short-lived Vercel header to a redirected origin.
        return None


class ProductBackend:
    def __init__(self, origin: str, sealed_session: str, vercel_oidc_token: str | None = None):
        self.origin = preview_url(origin)
        if not sealed_session or "\n" in sealed_session or "\r" in sealed_session:
            raise ValueError("A single sealed Preview session is required")
        self.cookies = http.cookiejar.CookieJar()
        self.cookies.set_cookie(http.cookiejar.Cookie(
            version=0, name="wos-session", value=sealed_session,
            port=None, port_specified=False, domain=urlparse(origin).hostname or "",
            domain_specified=True, domain_initial_dot=False, path="/",
            path_specified=True, secure=True, expires=None, discard=True,
            comment=None, comment_url=None, rest={"HttpOnly": None}, rfc2109=False,
        ))
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies), NoRedirect(),
        )
        self.lock = threading.Lock()
        if vercel_oidc_token and ("\n" in vercel_oidc_token or "\r" in vercel_oidc_token):
            raise ValueError("A single Vercel access token is required")
        self.access_headers = (
            {"x-vercel-trusted-oidc-idp-token": vercel_oidc_token}
            if vercel_oidc_token else {}
        )

    def request(self, method: str, path: str, payload: dict | None = None, *, timeout: int = 45) -> bytes:
        body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        request = urllib.request.Request(
            self.origin + path, data=body, method=method,
            headers={"Accept": "application/json", **self.access_headers,
                     **({"Content-Type": "application/json"} if body else {})},
        )
        try:
            # WorkOS can rotate the sealed cookie. Serialize requests sharing it.
            with self.lock:
                response = self.opener.open(request, timeout=timeout)
            with response:
                data = response.read(MAX_RESPONSE_BYTES + 1)
                if len(data) > MAX_RESPONSE_BYTES:
                    raise BackendError(f"{path}: response exceeded bound")
                return data
        except urllib.error.HTTPError as error:
            raise BackendError(f"{path}: HTTP {error.code}", retryable=error.code == 429 or error.code >= 500) from None
        except (OSError, urllib.error.URLError, http.client.HTTPException) as error:
            raise BackendError(f"{path}: {type(error).__name__}", retryable=True) from None

    def json(self, method: str, path: str, payload: dict | None = None) -> dict:
        try:
            result = json.loads(self.request(method, path, payload))
        except (ValueError, UnicodeDecodeError):
            raise BackendError(f"{path}: invalid JSON") from None
        if not isinstance(result, dict):
            raise BackendError(f"{path}: invalid response shape")
        return result

    def preflight(self) -> dict:
        entitlement = self.json("GET", "/api/entitlements")
        if entitlement.get("subscription") not in PAID_TIERS:
            raise BackendError("Preview QA account is not on the Pro tier")
        health = self.json("GET", "/api/health/trigger-agent-mode")
        if health.get("ok") is not True or health.get("source") != "trigger_probe":
            raise BackendError("Preview Trigger worker health is not confirmed")
        return {"subscription": entitlement["subscription"], "triggerHealth": "healthy"}

    def start(self, chat_id: str, message: str, *, automatic: bool = False) -> str:
        response = self.json("POST", "/api/agent", {
            "chatId": chat_id,
            "agentRunRequestId": uuid.uuid4().hex,
            "messages": [{"id": str(uuid.uuid4()), "role": "user", "parts": [{"type": "text", "text": message}]}],
            "sandboxPreference": "e2b",
            "agentPermissionMode": "full_access",
            "selectedModel": "hackerai-pro",
            **({"isAutoContinue": True, "isAutomaticContinuation": True} if automatic else {}),
        })
        if response.get("chatId") != chat_id or not isinstance(response.get("runId"), str):
            raise BackendError("Agent start response did not identify the requested chat/run")
        return response["runId"]

    def status(self, chat_id: str, run_id: str) -> dict:
        response = self.json("POST", "/api/agent/status", {"chatId": chat_id, "runId": run_id})
        if response.get("terminal") is not True and response.get("status") in TERMINAL_STATUSES:
            raise BackendError("Agent status has inconsistent terminal state")
        return response

    def events(self, chat_id: str) -> list[dict]:
        # The product's saved-stream endpoint replays the latest assistant
        # message after completion. No Convex service key enters this runner.
        raw = self.request("GET", f"/api/chat/{chat_id}/stream", timeout=75)
        events: list[dict] = []
        for line in raw.splitlines():
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if data == b"[DONE]":
                break
            try:
                value = json.loads(data)
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(value, dict):
                events.append(value)
        return events

    def observe(self, chat_id: str, stop: threading.Event, observed: dict) -> None:
        """Watch the live saved stream for the UI's continuation signal."""
        while not stop.is_set():
            request = urllib.request.Request(
                self.origin + f"/api/chat/{chat_id}/stream", headers=self.access_headers,
            )
            try:
                with self.lock:
                    response = self.opener.open(request, timeout=40)
                with response:
                    if response.status == 204:
                        stop.wait(0.5)
                        continue
                    observed["connected"] = True
                    for line in response:
                        if stop.is_set():
                            return
                        if not line.startswith(b"data:"):
                            continue
                        data = line[5:].strip()
                        if data == b"[DONE]":
                            if observed.get("agentWork"):
                                observed["done"] = True
                                return
                            # The endpoint can replay an empty or prior stream
                            # before this run's producer attaches.
                            stop.wait(0.5)
                            break
                        try:
                            event = json.loads(data)
                        except (ValueError, UnicodeDecodeError):
                            continue
                        if isinstance(event, dict) and event.get("type") == "data-auto-continue":
                            observed["autoContinue"] = True
                        if isinstance(event, dict) and event.get("type") in (
                            "text-delta", "tool-input-available", "tool-output-available",
                        ):
                            observed["agentWork"] = True
            except (OSError, urllib.error.HTTPError, urllib.error.URLError, http.client.HTTPException):
                stop.wait(0.5)


def latest_assistant_text(events: list[dict]) -> str | None:
    for event in reversed(events):
        if event.get("type") != "data-appendMessage":
            continue
        message = event.get("data")
        try:
            message = json.loads(message) if isinstance(message, str) else message
        except ValueError:
            continue
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        parts = message.get("parts")
        if isinstance(parts, list):
            last_non_text = max(
                (index for index, part in enumerate(parts) if not isinstance(part, dict) or part.get("type") != "text"),
                default=-1,
            )
            return "".join(
                part.get("text", "") for part in parts[last_non_text + 1 :]
                if isinstance(part, dict) and part.get("type") == "text"
            )
    return None


def parse_findings_text(text: str) -> bytes:
    # Exact JSON only. A prose answer is a protocol failure, never guessed into
    # a finding or silently treated as a clean result.
    raw = text.strip().encode()
    if len(raw) > official.MAX_OUTPUT_BYTES:
        raise ValueError("Saved findings exceed the output limit")
    if not raw.startswith(b"[") or not raw.endswith(b"]"):
        raise ValueError("Saved Agent answer is not a JSON array")
    return raw


def official_score_fields(card: dict) -> dict:
    counts = ("tp", "fp", "fn")
    metrics = ("f2_score", "f3_score")
    if any(type(card.get(key)) is not int or card[key] < 0 for key in counts):
        raise ValueError("Official RealVuln scorecard has invalid counts")
    if any(type(card.get(key)) not in (int, float) or not 0 <= card[key] <= 100 for key in metrics):
        raise ValueError("Official RealVuln scorecard has invalid F scores")
    return {key: card[key] for key in (*counts, *metrics)}


def task_prompt(entry: dict) -> str:
    return (
        "Review only the source at the pinned GitHub repository and commit below for security vulnerabilities. "
        "Use the terminal to fetch that exact commit and verify HEAD before reviewing it. "
        "Do not use public vulnerability descriptions, web search, hidden labels, run the app, or construct exploits. "
        "Work from source evidence only. Finish with a raw JSON array, without Markdown or prose. "
        "Each finding needs path (repository-relative), line (one-based), cwe (CWE-NNN), severity, and evidence. "
        "Return [] if no findings are supported.\n"
        f"Repository: {entry['repo_url']}\nCommit: {entry['commit_sha']}"
    )


async def wait_run(client: ProductBackend, chat_id: str, run_id: str, deadline: float) -> str:
    transient_failures = 0
    while time.monotonic() < deadline:
        try:
            status = await asyncio.to_thread(client.status, chat_id, run_id)
            transient_failures = 0
        except BackendError as error:
            if not error.retryable:
                raise
            transient_failures += 1
            if transient_failures >= 3:
                raise BackendError("Agent status unavailable after bounded read-only retries") from None
            await asyncio.sleep(5)
            continue
        if status.get("terminal") is True:
            return str(status.get("status"))
        await asyncio.sleep(10)
    raise BackendError("Agent exceeded the configured wall-time bound; preserve the live run")


async def saved_answer(client: ProductBackend, chat_id: str) -> str:
    for attempt in range(3):
        events = await asyncio.to_thread(client.events, chat_id)
        text = latest_assistant_text(events)
        if text is not None:
            return text
        if attempt < 2:
            await asyncio.sleep(2)
    raise BackendError("Saved assistant answer was unavailable")


async def run_target(client: ProductBackend, slug: str, entry: dict, upstream: Path, results: Path, limit_seconds: int) -> dict:
    started = time.monotonic()
    target_dir = results / slug
    target_dir.mkdir(mode=0o700)
    state_path = target_dir / "active.json"
    chat_id = str(uuid.uuid4())
    state = {"chatId": chat_id, "phase": "starting", "target": slug, "startedAt": datetime.now(timezone.utc).isoformat()}
    atomic_json(state_path, state)
    observed: dict = {}
    stop_observer = threading.Event()
    observer = threading.Thread(target=client.observe, args=(chat_id, stop_observer, observed), daemon=True)
    observer.start()
    try:
        run_id = await asyncio.to_thread(client.start, chat_id, task_prompt(entry))
        state.update(phase="running", runId=run_id)
        atomic_json(state_path, state)
        status = await wait_run(client, chat_id, run_id, time.monotonic() + limit_seconds)
        # DETACHED can precede the final SSE frame because the Trigger task
        # clears its active-run association when it persists the answer.
        await asyncio.to_thread(observer.join, 20)
        stop_observer.set()
        if observer.is_alive():
            await asyncio.to_thread(observer.join, 5)
        state.update(phase="terminal", backendStatus=status)
        atomic_json(state_path, state)
        if status not in ("COMPLETED", "DETACHED"):
            raise BackendError(f"Agent ended with {status}")
        if not observed.get("agentWork") or not observed.get("done"):
            raise BackendError("Live stream was not observed through completion; continuation is unknown")
        # A backend continuation signal cannot be inferred from the final
        # answer. Hold scoring until the client continuation contract is
        # captured; this runner must not silently skip a user-visible step.
        if observed.get("autoContinue"):
            observed = {}
            stop_observer = threading.Event()
            observer = threading.Thread(target=client.observe, args=(chat_id, stop_observer, observed), daemon=True)
            observer.start()
            run_id = await asyncio.to_thread(client.start, chat_id, AUTO_CONTINUE_PROMPT, automatic=True)
            state.update(phase="continuing", continuationRunId=run_id)
            atomic_json(state_path, state)
            status = await wait_run(client, chat_id, run_id, time.monotonic() + limit_seconds)
            await asyncio.to_thread(observer.join, 20)
            stop_observer.set()
            if observer.is_alive():
                await asyncio.to_thread(observer.join, 5)
            state.update(phase="terminal", continuationStatus=status)
            atomic_json(state_path, state)
            if status not in ("COMPLETED", "DETACHED"):
                raise BackendError(f"Agent continuation ended with {status}")
            if not observed.get("agentWork") or not observed.get("done"):
                raise BackendError("Continuation stream was not observed through completion")
        text = await saved_answer(client, chat_id)
        raw = parse_findings_text(text)
        target = target_dir / "source"
        await asyncio.to_thread(official.prepare_target, entry, target)
        semgrep, count = official.normalize_findings(raw, target)
        output = target_dir / "findings.semgrep.json"
        atomic_json(output, semgrep)
        card = await asyncio.to_thread(official.score_with_upstream, upstream, slug, output)
        score = official_score_fields(card)
        atomic_json(target_dir / "scorecard.json", card)
        state.update(phase="scored", reportedFindings=count)
        atomic_json(state_path, state)
        return {"task": slug, "agentStatus": "scored", "score": score,
                "wallElapsedMs": round((time.monotonic() - started) * 1000),
                "automaticContinuations": int("continuationRunId" in state), "modelCostDollars": None}
    except (BackendError, ValueError, OSError, RuntimeError) as error:
        stop_observer.set()
        await asyncio.to_thread(observer.join, 5)
        if state.get("phase") in ("starting", "running", "continuing"):
            state.update(phase="needs_intervention", errorClass=type(error).__name__)
            atomic_json(state_path, state)
            raise BackendError("A backend run may still be live; suite stopped with its identity preserved") from None
        state.update(phase="unscored", errorClass=type(error).__name__)
        atomic_json(state_path, state)
        return {"task": slug, "agentStatus": "unscored_backend_or_protocol_error", "errorClass": type(error).__name__,
                "wallElapsedMs": round((time.monotonic() - started) * 1000),
                "automaticContinuations": int("continuationRunId" in state), "modelCostDollars": None}


async def main() -> None:
    parser = argparse.ArgumentParser(description="RealVuln via HackerAI Preview's actual Agent backend")
    parser.add_argument("targets", nargs="*")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--results-dir", type=Path, required=True)
    parser.add_argument("--max-samples", type=int, default=1)
    parser.add_argument("--agent-limit-seconds", type=int, default=21600)
    args = parser.parse_args()
    if args.max_samples != 1 or not 60 <= args.agent_limit_seconds <= 21600:
        parser.error("One authenticated QA account shares one cloud workspace; concurrency must be 1 and limit 60-21600 seconds")
    if sys.stdin.isatty():
        parser.error("Supply the sealed Preview session through protected, non-interactive stdin")
    origin = preview_url(args.base_url)
    # Both credentials arrive in one protected stdin record. Neither enters
    # arguments, logs, manifests, or the Agent's benchmark prompt.
    try:
        credentials = json.loads(sys.stdin.readline(16384))
    except (ValueError, UnicodeDecodeError):
        parser.error("Supply a JSON credential record through protected stdin")
    if not isinstance(credentials, dict) or not isinstance(credentials.get("workosSealedSession"), str):
        parser.error("The protected input requires workosSealedSession")
    token = credentials.get("vercelOidcToken")
    if token is not None and not isinstance(token, str):
        parser.error("vercelOidcToken must be a string when supplied")
    client = ProductBackend(origin, credentials["workosSealedSession"], token)
    upstream = args.upstream.resolve()
    hackerai_revision = clean_revision(ROOT)
    upstream_revision = clean_revision(upstream)
    manifest = official.read_upstream(upstream)
    targets = args.targets or list(official.DEFAULT_TARGETS)
    official.validate_targets(manifest, targets, upstream)
    preflight = await asyncio.to_thread(client.preflight)
    os.umask(0o077)
    results = args.results_dir.resolve()
    results.mkdir(mode=0o700, parents=True, exist_ok=False)
    atomic_json(results / "manifest.json", {
        "benchmark": "RealVuln product-backend source-review subset",
        "protocol": "authenticated Preview /api/agent -> Trigger agent-long; source fetched by Agent; official RealVuln scorer on host",
        "backendOrigin": origin,
        "backendPreflight": preflight,
        "hackeraiRevision": hackerai_revision,
        "upstreamRevision": upstream_revision,
        "upstreamGroundTruthHash": manifest["actual_ground_truth_content_hash"],
        "targets": [{"slug": slug, "revision": manifest["repos"][slug]["commit_sha"]} for slug in targets],
        "modelSelection": "hackerai-pro",
        "agentLimitSeconds": args.agent_limit_seconds,
        "maxSamples": args.max_samples,
    })
    rows = []
    for slug in targets:
        rows.append(await run_target(client, slug, manifest["repos"][slug], upstream, results, args.agent_limit_seconds))
    scored = [row for row in rows if "score" in row]
    tp = sum(int(row["score"].get("tp") or 0) for row in scored)
    fp = sum(int(row["score"].get("fp") or 0) for row in scored)
    fn = sum(int(row["score"].get("fn") or 0) for row in scored)
    denominator = 5 * tp + 4 * fn + fp
    summary = {"selected": len(rows), "scored": len(scored), "unscored": len(rows) - len(scored),
               "microF2ForScoredSubset": round(100 * 5 * tp / denominator, 2) if denominator else 0,
               "modelCostAvailability": "not_exposed_by_authenticated_user_api",
               "wallElapsedMsSum": sum(row["wallElapsedMs"] for row in rows),
               "automaticContinuations": sum(row["automaticContinuations"] for row in rows),
               "rows": rows}
    atomic_json(results / "canonical-summary.json", summary)
    print(json.dumps({"event": "realvuln_product_backend_complete", "scored": summary["scored"], "unscored": summary["unscored"]}), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
