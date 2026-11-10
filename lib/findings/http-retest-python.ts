/**
 * Fixed Python 3 standard-library runner for executable HTTP retests.
 *
 * It reads one compiled plan from stdin (local computers) or a single
 * environment variable it removes immediately (cloud), sends GET requests to
 * the plan's exact origin, never follows redirects or retries, verifies TLS,
 * caps response size and run time, and prints only controlled observations:
 * status, byte count, body SHA-256, timing and predicate booleans. Bodies,
 * headers, credentials and exception text are never printed.
 */
export const HTTP_RETEST_RESULT_MARKER = "HACKERAI_HTTP_RETEST_RESULT:";
export const HTTP_RETEST_INPUT_ENV = "HACKERAI_HTTP_RETEST_INPUT";

export const HTTP_RETEST_PYTHON_PROGRAM = String.raw`
import base64, hashlib, http.client, json, os, socket, ssl, sys, time

MARK = "${HTTP_RETEST_RESULT_MARKER}"


def emit(value):
    sys.stdout.write(MARK + json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def lookup(document, path):
    current = document
    for segment in path:
        if isinstance(current, dict) and segment in current:
            current = current[segment]
        elif isinstance(current, list) and segment.isdigit() and int(segment) < len(current):
            current = current[int(segment)]
        else:
            return False, None
    return True, current


def same(actual, expected):
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(actual) is type(expected) and actual == expected
    if expected is None or actual is None:
        return actual is None and expected is None
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return actual == expected
    return type(actual) is type(expected) and actual == expected


def evaluate(step, body):
    results = []
    document = None
    parsed = False
    for check in step["json"]:
        if not parsed:
            parsed = True
            try:
                document = json.loads(body.decode("utf-8"))
            except Exception:
                document = None
        found, value = lookup(document, check["path"]) if document is not None else (False, None)
        results.append(bool(found and same(value, check["equals"])))
    for needle in step["contains"]:
        results.append(needle.encode("utf-8") in body)
    return results


def run_step(plan, step, deadline):
    started = time.monotonic()
    result = {
        "kind": step["kind"],
        "index": step["index"],
        "status": None,
        "bytes": None,
        "body_sha256": None,
        "duration_ms": 0,
        "error": "none",
        "matched": False,
        "checks": [],
    }
    if step["kind"] == "probe":
        result["nonreproduction_matched"] = False
    remaining = deadline - started
    if remaining <= 0.05:
        result["error"] = "timeout"
        return result
    timeout = max(0.05, min(plan["timeout_s"], remaining))
    connection = None
    try:
        if plan["scheme"] == "https":
            connection = http.client.HTTPSConnection(
                plan["host"], plan["port"], timeout=timeout, context=ssl.create_default_context()
            )
        else:
            connection = http.client.HTTPConnection(plan["host"], plan["port"], timeout=timeout)
        connection.putrequest("GET", step["path"], skip_accept_encoding=True)
        for name, value in step["headers"]:
            connection.putheader(name, value)
        connection.putheader("Connection", "close")
        connection.endheaders()
        response = connection.getresponse()
        status = response.status
        result["status"] = status
        if 300 <= status < 400:
            result["error"] = "redirect"
        else:
            digest = hashlib.sha256()
            chunks = []
            size = 0
            while True:
                if time.monotonic() > deadline:
                    raise socket.timeout()
                chunk = response.read(65536)
                if not chunk:
                    break
                size += len(chunk)
                if size > plan["max_bytes"]:
                    result["bytes"] = plan["max_bytes"] + 1
                    result["error"] = "oversized"
                    break
                digest.update(chunk)
                chunks.append(chunk)
            if result["error"] == "none":
                body = b"".join(chunks)
                result["bytes"] = size
                result["body_sha256"] = digest.hexdigest()
                result["checks"] = evaluate(step, body)
                result["matched"] = status == step["status"] and all(result["checks"])
                if step["nonrepro"] is not None:
                    result["nonreproduction_matched"] = status in step["nonrepro"]
    except ssl.SSLError:
        result["error"] = "tls"
    except socket.timeout:
        result["error"] = "timeout"
    except http.client.HTTPException:
        result["error"] = "invalid_response"
    except OSError:
        result["error"] = "connection"
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass
    result["duration_ms"] = int((time.monotonic() - started) * 1000)
    return result


def main():
    try:
        raw = os.environ.pop("${HTTP_RETEST_INPUT_ENV}", None)
        data = base64.b64decode(raw) if raw is not None else sys.stdin.buffer.read(262145)
        plan = json.loads(data.decode("utf-8"))
    except Exception:
        emit({"protocol": 1, "fatal": "invalid_input"})
        return
    deadline = time.monotonic() + plan["deadline_s"]
    steps = []
    for step in plan["steps"]:
        result = run_step(plan, step, deadline)
        steps.append(result)
        if step["kind"] == "baseline" and (result["error"] != "none" or not result["matched"]):
            break
    emit({"protocol": 1, "steps": steps, "deadline_exceeded": time.monotonic() > deadline})


try:
    main()
except Exception:
    emit({"protocol": 1, "fatal": "runner_failed"})
`;
