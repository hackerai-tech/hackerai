import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { TriggerHealthConfig } from "./config";

export type ProbeResult = {
  status: "healthy" | "failing" | "unknown";
  checkedAt: string;
  error?: string;
};
const TASK_ID = "agent-health-probe";
const TIMEOUT_MS = 40_000;
const runSchema = z.object({
  id: z.string(),
  taskIdentifier: z.literal(TASK_ID),
  status: z.enum([
    "PENDING_VERSION",
    "DELAYED",
    "QUEUED",
    "EXECUTING",
    "REATTEMPTING",
    "FROZEN",
    "COMPLETED",
    "CANCELED",
    "FAILED",
    "CRASHED",
    "INTERRUPTED",
    "SYSTEM_FAILURE",
    "EXPIRED",
    "TIMED_OUT",
  ]),
  output: z.unknown().optional(),
});
const terminalFailures = new Set([
  "CANCELED",
  "FAILED",
  "CRASHED",
  "INTERRUPTED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
]);

export async function runProbe(
  config: TriggerHealthConfig,
): Promise<ProbeResult> {
  const checkedAt = new Date().toISOString();
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const nonce = randomUUID();
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.token}`,
    "content-type": "application/json",
  };
  if (config.branch) headers["x-trigger-branch"] = config.branch;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(new URL(path, config.baseURL), {
      method: body ? "POST" : "GET",
      headers,
      signal,
      cache: "no-store",
      redirect: "error",
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error("probe_api_unavailable");
    return response.json();
  };
  try {
    const triggered = z
      .object({ id: z.string().regex(/^run_[a-zA-Z0-9]+$/) })
      .safeParse(
        await request(`/api/v1/tasks/${TASK_ID}/trigger`, {
          payload: { nonce },
          options: { ttl: "1m", idempotencyKey: nonce },
        }),
      );
    if (!triggered.success)
      return { status: "unknown", checkedAt, error: "trigger_probe_invalid" };
    while (!signal.aborted) {
      const parsed = runSchema.safeParse(
        await request(`/api/v3/runs/${triggered.data.id}`),
      );
      if (!parsed.success || parsed.data.id !== triggered.data.id) {
        return { status: "unknown", checkedAt, error: "trigger_probe_invalid" };
      }
      const run = parsed.data;
      if (run.status === "COMPLETED") {
        const output = z
          .object({ nonce: z.literal(nonce) })
          .safeParse(run.output);
        return output.success
          ? { status: "healthy", checkedAt }
          : {
              status: "unknown",
              checkedAt,
              error: "trigger_probe_invalid_output",
            };
      }
      if (terminalFailures.has(run.status)) {
        return { status: "failing", checkedAt, error: "trigger_probe_failed" };
      }
      await sleep(2_000, undefined, { signal });
    }
  } catch {
    // Never expose upstream messages, payloads, tokens, or run output.
  }
  return {
    status: "unknown",
    checkedAt,
    error: signal.aborted
      ? "trigger_probe_timeout"
      : "trigger_probe_unavailable",
  };
}
