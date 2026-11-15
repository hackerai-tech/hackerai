import { randomBytes } from "node:crypto";

export type AgentRunClockContext = Readonly<{
  run_clock_version: 1;
  run_clock_process_instance: string;
  run_clock_uptime_ms: number;
  run_clock_attempt: number;
}>;

// An instance belongs to this module in this process. Different isolates or
// module copies cannot establish ordering, even if their run IDs match.
let processInstance: string | null | undefined;

/** Read a bounded monotonic stamp; compare only within one run, instance and attempt. */
export function getAgentRunClockContext(
  attempt: unknown,
): AgentRunClockContext | undefined {
  if (
    typeof attempt !== "number" ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  )
    return;
  try {
    const uptimeMs = process.uptime() * 1000;
    if (
      !Number.isFinite(uptimeMs) ||
      uptimeMs < 0 ||
      uptimeMs > Number.MAX_SAFE_INTEGER
    )
      return;
    if (processInstance === undefined) {
      // A failed entropy read remains unmeasured; do not retry it on each event.
      processInstance = null;
      processInstance = randomBytes(8).toString("hex");
    }
    if (!processInstance) return;
    return {
      run_clock_version: 1,
      run_clock_process_instance: processInstance,
      run_clock_uptime_ms: Math.floor(uptimeMs),
      run_clock_attempt: attempt,
    };
  } catch {
    // Optional clock diagnostics cannot affect a checkpoint or success hook.
    return;
  }
}
