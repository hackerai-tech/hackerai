// Strict, abortable Trigger adapters for the abuse operator workflow.
//
// The general cleanup helper treats several 4xx responses as success, which is
// right for best-effort cleanup but not for a reviewed restriction receipt. Here
// no error status counts as success: an unconfirmed cancellation or approval
// closure stays retryable.
//
// The installed SDK's request options accept retry bounds but no AbortSignal, and
// its fetch cannot be cancelled. These adapters call the same endpoints the SDK
// uses (runs v3 retrieve, runs v2 cancel, sessions v1 close) with the same
// authentication and branch header, so every attempt can be aborted.

import type { TriggerRun } from "@/lib/abuse/response";

/** Per-attempt timeout; with the attempt cap, far below the server lease. */
export const TRIGGER_ATTEMPT_TIMEOUT_MS = 15_000;
export const TRIGGER_MAX_ATTEMPTS = 2;
/** External effects must dispatch within this budget after a server checkpoint. */
export const TRIGGER_OPERATION_BUDGET_MS = 60_000;

export type TriggerOperation = { signal: AbortSignal; deadline: number };
export type TriggerConnection = {
  baseUrl: string;
  secretKey: string;
  branch?: string;
  fetch?: typeof fetch;
};

/** Carries only a status code; Trigger error bodies are never surfaced. */
export class TriggerRequestError extends Error {
  constructor(readonly status?: number) {
    super(
      status
        ? `Trigger request rejected (${status})`
        : "Trigger request failed",
    );
  }
}

export function startTriggerOperation(
  budgetMs = TRIGGER_OPERATION_BUDGET_MS,
): TriggerOperation & { dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    deadline: Date.now() + budgetMs,
    dispose: () => clearTimeout(timer),
  };
}

/**
 * Checked immediately before every dispatch. The wall-clock deadline covers an
 * event-loop delay that postponed the abort timer.
 */
export function assertOperationLive(operation: TriggerOperation) {
  if (operation.signal.aborted || Date.now() >= operation.deadline)
    throw new TriggerRequestError();
}

type Received = { ok: boolean; status: number; type: string; text: string };

/**
 * Read the whole body under the attempt's signal. Cancelling the reader ends a
 * stalled body even when the fetch implementation does not tie it to the signal.
 */
async function readBody(response: Response, signal: AbortSignal) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel);
  try {
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      if (signal.aborted) throw new TriggerRequestError();
      const { done, value } = await reader.read();
      if (signal.aborted) throw new TriggerRequestError();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/**
 * One bounded attempt. Its timeout and the operation's abort cover the request
 * and the complete response body; a rejected response's body is discarded.
 */
async function attempt(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  operation: TriggerOperation,
): Promise<Received> {
  assertOperationLive(operation);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, TRIGGER_ATTEMPT_TIMEOUT_MS);
  operation.signal.addEventListener("abort", abort);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    const received = {
      ok: response.ok,
      status: response.status,
      type: response.headers.get("content-type") ?? "application/json",
    };
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return { ...received, text: "" };
    }
    return { ...received, text: await readBody(response, controller.signal) };
  } finally {
    clearTimeout(timer);
    operation.signal.removeEventListener("abort", abort);
  }
}

async function request(
  connection: TriggerConnection,
  path: string,
  method: "GET" | "POST",
  operation: TriggerOperation,
  body?: unknown,
): Promise<unknown> {
  const fetchImpl = connection.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${connection.secretKey}`,
    ...(connection.branch ? { "x-trigger-branch": connection.branch } : {}),
  };
  for (let index = 1; ; index++) {
    let response: Received;
    try {
      // A stalled or aborted body is a failed attempt, retried within the bound.
      response = await attempt(
        fetchImpl,
        `${connection.baseUrl.replace(/\/$/, "")}${path}`,
        {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        operation,
      );
    } catch {
      if (index >= TRIGGER_MAX_ATTEMPTS) throw new TriggerRequestError();
      continue;
    }
    if (response.ok) {
      try {
        return JSON.parse(response.text);
      } catch {
        throw new TriggerRequestError(response.status);
      }
    }
    // Only rate limits and server errors are transient. Every other status,
    // including 404/409, is an unconfirmed outcome.
    if (
      index >= TRIGGER_MAX_ATTEMPTS ||
      !(response.status === 429 || response.status >= 500)
    )
      throw new TriggerRequestError(response.status);
  }
}

/**
 * Mirrors the installed SDK's presigned payload resolution
 * (`resolvePresignedPacketUrl` + `parsePacket`): an exact content-type switch,
 * defaulting to JSON, with unknown types returned as text. SuperJSON packets
 * use their serialized `json` value; it equals `superjson.parse` for the
 * plain-string identity fields this workflow compares. Unlike the SDK, a
 * failed download is an error rather than an empty payload, so the target stays
 * retryable instead of looking like an identity mismatch. No Trigger
 * credentials are sent to the storage URL.
 */
async function presignedPayload(
  connection: TriggerConnection,
  url: string,
  operation: TriggerOperation,
) {
  if (!url.startsWith("https://")) throw new TriggerRequestError();
  const packet = await attempt(
    connection.fetch ?? globalThis.fetch,
    url,
    { method: "GET" },
    operation,
  );
  if (!packet.ok) throw new TriggerRequestError(packet.status);
  if (!packet.text) return undefined;
  switch (packet.type) {
    case "application/json":
      return JSON.parse(packet.text);
    case "application/super+json":
      return (JSON.parse(packet.text) as { json?: unknown }).json;
    default:
      return packet.text;
  }
}

export function createTriggerResponseAdapters(connection: TriggerConnection) {
  return {
    async retrieveRun(
      runId: string,
      operation: TriggerOperation,
    ): Promise<TriggerRun> {
      const run = (await request(
        connection,
        `/api/v3/runs/${encodeURIComponent(runId)}`,
        "GET",
        operation,
      )) as Record<string, unknown> | null;
      if (!run || typeof run.status !== "string")
        throw new TriggerRequestError();
      const payload =
        run.payload !== undefined
          ? run.payload
          : typeof run.payloadPresignedUrl === "string"
            ? await presignedPayload(
                connection,
                run.payloadPresignedUrl,
                operation,
              )
            : undefined;
      return {
        status: run.status,
        ...(typeof run.taskIdentifier === "string"
          ? { taskIdentifier: run.taskIdentifier }
          : {}),
        payload,
      };
    },
    async cancelRun(runId: string, operation: TriggerOperation) {
      await request(
        connection,
        `/api/v2/runs/${encodeURIComponent(runId)}/cancel`,
        "POST",
        operation,
      );
    },
    async closeApprovalSession(
      sessionId: string,
      reason: string,
      operation: TriggerOperation,
    ) {
      await request(
        connection,
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/close`,
        "POST",
        operation,
        { reason },
      );
    },
  };
}
