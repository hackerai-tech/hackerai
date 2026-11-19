import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";

// Trigger.dev returns a server-to-server callback URL with each waitpoint
// token. Its path carries a capability hash, so it is used only in memory, only
// for the token it names, and never logged or traced.
const CALLBACK_ORIGIN = "https://api.trigger.dev";
const TOKEN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CALLBACK_HASH = /^[A-Za-z0-9_-]{16,256}$/;
// Bounds this one cleanup request. The original wait stays awaited regardless.
const COMPLETION_DEADLINE_MS = 10_000;
// The callback body becomes the token's output. A closed marker, never user
// text: a stopped wait throws its stop reason without reading the output.
const STOP_MARKER = new TextEncoder().encode(
  JSON.stringify({ type: "agent_wait_stopped" }),
);

export type WaitStopCompletion =
  "not_sent" | "invalid_callback" | "accepted" | "rejected" | "unknown";

// Which abort reached the request first. Passed as the abort reason, so a
// later abort cannot replace it.
type AbortSource = "deadline" | "original_wait_settled";

/**
 * A closed receipt of the one completion attempt. An accepted status means a
 * successful HTTP response, not proof that the waiting run woke up.
 */
export type WaitStopReport = {
  outcome: Exclude<WaitStopCompletion, "not_sent">;
  /** The response status, only when one was received and is valid HTTP. */
  httpStatus: number | null;
  /** Monotonic time from the stop to this receipt, bounded. */
  elapsedMs: number;
  abortSource: AbortSource | null;
};

const MAX_REPORTED_MS = 60_000;

/** The callback URL, only if it is Trigger's and names exactly this token. */
function callbackUrl(token: { id: string; url: string }): string | undefined {
  if (typeof token.id !== "string" || !TOKEN_ID.test(token.id)) return;
  let url: URL;
  try {
    url = new URL(token.url);
  } catch {
    return;
  }
  const [root, api, version, waitpoints, tokens, id, callback, hash, ...rest] =
    url.pathname.split("/");
  if (
    url.origin !== CALLBACK_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    root !== "" ||
    api !== "api" ||
    version !== "v1" ||
    waitpoints !== "waitpoints" ||
    tokens !== "tokens" ||
    id !== token.id ||
    callback !== "callback" ||
    !CALLBACK_HASH.test(hash ?? "") ||
    rest.length
  )
    return;
  return url.href;
}

async function post(
  url: string,
  signal: AbortSignal,
): Promise<Omit<WaitStopReport, "elapsedMs">> {
  let outcome: "accepted" | "rejected" | "unknown";
  let httpStatus: number | null = null;
  try {
    // Keep the capability URL out of outgoing-HTTP spans, as the SDK's own
    // API client does for its requests.
    const response = await context.with(suppressTracing(context.active()), () =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: STOP_MARKER,
        redirect: "error",
        signal,
      }),
    );
    // The status is the whole result; discard the body unread.
    await response.body?.cancel().catch(() => undefined);
    outcome = response.ok ? "accepted" : "rejected";
    const { status } = response;
    if (Number.isInteger(status) && status >= 100 && status <= 599)
      httpStatus = status;
  } catch {
    // The server may have committed before the failure. Never retry: the
    // first completion of a token is final, and the original wait decides.
    outcome = "unknown";
  }
  // Read as the request finishes, so a later abort cannot relabel it.
  const abortSource: AbortSource | null = signal.aborted ? signal.reason : null;
  return { outcome, httpStatus, abortSource };
}

/**
 * On the first product stop, complete this invocation's own waitpoint token
 * once so its original `wait.forToken` can settle. A real reply or timeout that
 * completed first is kept by the platform. This is best effort: if the request
 * or the platform's wake-up fails, the original wait remains pending.
 *
 * Call `settle()` once the original wait settles; it detaches the stop listener,
 * aborts any request still in flight and waits for that request to finish.
 * Native fetch ends promptly on abort; the join is only as bounded as that.
 *
 * `onReport` receives one receipt after a stop: on an invalid callback, or as
 * the request finishes, without waiting for the original wait. It must be
 * synchronous; its errors are ignored.
 */
export function completeWaitOnStop(
  signal: AbortSignal | undefined,
  token: { id: string; url: string },
  onReport: (report: WaitStopReport) => void = () => {},
) {
  let used = false;
  let outcome: WaitStopCompletion = "not_sent";
  let request:
    | { controller: AbortController; done: Promise<WaitStopCompletion> }
    | undefined;

  const report = (receipt: WaitStopReport) => {
    try {
      onReport(receipt);
    } catch {
      // A diagnostic must not affect the stop, the request or the wait.
    }
  };

  const onStop = () => {
    signal?.removeEventListener("abort", onStop);
    if (used) return;
    used = true;
    const url = callbackUrl(token);
    if (!url) {
      outcome = "invalid_callback";
      report({ outcome, httpStatus: null, elapsedMs: 0, abortSource: null });
      return;
    }
    const startedAt = performance.now();
    // A separate controller: the product signal is already aborted.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort("deadline" satisfies AbortSource),
      COMPLETION_DEADLINE_MS,
    );
    request = {
      controller,
      done: post(url, controller.signal)
        .finally(() => clearTimeout(timer))
        .then((result) => {
          const elapsedMs = Math.round(performance.now() - startedAt);
          report({
            ...result,
            elapsedMs: Math.min(MAX_REPORTED_MS, Math.max(0, elapsedMs)),
          });
          return result.outcome;
        }),
    };
  };

  if (signal?.aborted) onStop();
  else signal?.addEventListener("abort", onStop, { once: true });

  return {
    async settle(): Promise<WaitStopCompletion> {
      used = true;
      signal?.removeEventListener("abort", onStop);
      if (!request) return outcome;
      request.controller.abort("original_wait_settled" satisfies AbortSource);
      return await request.done;
    },
  };
}
