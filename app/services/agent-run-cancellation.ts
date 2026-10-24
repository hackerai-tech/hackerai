import { AGENT_CANCEL_ENDPOINT } from "@/lib/api/agent-endpoints";

export type AgentRunCancellationResult =
  | { outcome: "canceled" }
  | {
      outcome: "stale_run";
      expectedTriggerRunId: string;
      activeTriggerRunId?: string | null;
    };

// A Stop intent belongs to the run, not the mounted chat. Coalesce duplicate
// clicks and keep retrying across client navigation for this WebView lifetime.
const pending = new Map<string, Promise<AgentRunCancellationResult>>();
const REQUEST_TIMEOUT_MS = 10_000;
class CancellationRejected extends Error {}

function waitToRetry(delay: number, wakeOnReconnect: boolean): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      window.removeEventListener("online", finish);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    if (wakeOnReconnect)
      window.addEventListener("online", finish, { once: true });
  });
}

async function deliverCancellation(
  chatId: string,
  runId: string,
  onRetry?: () => void,
): Promise<AgentRunCancellationResult> {
  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let retryAfter = 0;
    let rateLimited = false;
    try {
      // Bound hung requests as well as network rejections. The immutable body
      // and server-side expected-run check make uncertain delivery safe to retry.
      return await Promise.race([
        (async (): Promise<AgentRunCancellationResult> => {
          const response = await fetch(AGENT_CANCEL_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chatId, expectedTriggerRunId: runId }),
            signal: controller.signal,
          });
          if (response.status === 409) {
            const payload = await response.json().catch(() => null);
            if (payload?.reason === "stale_run") {
              return {
                outcome: "stale_run",
                expectedTriggerRunId: runId,
                ...(Object.prototype.hasOwnProperty.call(
                  payload,
                  "activeTriggerRunId",
                )
                  ? {
                      activeTriggerRunId:
                        typeof payload.activeTriggerRunId === "string"
                          ? payload.activeTriggerRunId
                          : null,
                    }
                  : {}),
              };
            }
          }
          if (response.ok) return { outcome: "canceled" };
          const message = `Agent cancellation failed with status ${response.status}`;
          if (
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500
          ) {
            rateLimited = response.status === 429;
            const value = response.headers?.get("Retry-After");
            if (value) {
              const seconds = Number(value);
              const delay = Number.isFinite(seconds)
                ? seconds * 1000
                : Date.parse(value) - Date.now();
              if (Number.isFinite(delay))
                retryAfter = Math.max(0, Math.min(delay, 300_000));
            }
            throw new Error(message);
          }
          // Authentication, ownership and malformed requests need user action;
          // never retry them or replace the captured ID with the current run.
          throw new CancellationRejected(message);
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("Agent cancellation request timed out"));
          }, REQUEST_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      if (error instanceof CancellationRejected) throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt === 0) onRetry?.();
    const delay = Math.max(
      retryAfter,
      Math.min(1_000 * 2 ** Math.min(attempt++, 3), 5_000),
    );
    await waitToRetry(delay, !rateLimited);
  }
}

export function cancelAgentRunWithRetry(
  chatId: string,
  runId: string,
  onRetry?: () => void,
): Promise<AgentRunCancellationResult> {
  const key = JSON.stringify([chatId, runId]);
  const existing = pending.get(key);
  if (existing) return existing;
  const delivery = deliverCancellation(chatId, runId, onRetry).finally(() => {
    if (pending.get(key) === delivery) pending.delete(key);
  });
  pending.set(key, delivery);
  return delivery;
}
