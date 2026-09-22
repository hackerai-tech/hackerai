import { createHash } from "node:crypto";

/** Diagnostic only: a repeated result is evidence to inspect, not proof of failure. */
export type AgentGuardrailObservation = {
  reason: string;
  action: "observe" | "nudge" | "exclude" | "halt";
  tool_names: string[];
  repeat_count: number;
  cycle_length?: number;
  step_count: number;
  configured_max_steps: number;
  run_cost_dollars?: number;
};

type ToolCall = { toolCallId: string; toolName: string; input: unknown };
type ToolResult = { toolCallId: string; output: unknown };
type Step = { fingerprint: string; toolNames: string[] };
const MAX_PERIOD = 4;
const REPORT_LAPS = [3, 5] as const;
const POLLING_TOOLS = new Set(["interact_terminal_session", "wait_for_agents"]);

// Never retain inputs/results or emit their hashes. Oversized, cyclic, or exotic
// values break observation rather than adding work to an already expensive run.
function fingerprint(value: unknown): string | undefined {
  let remaining = 65_536;
  let nodes = 0;
  const seen = new WeakSet<object>();
  const normalize = (item: unknown, depth = 0): unknown => {
    if (++nodes > 2_048 || depth > 20) throw new Error("Observation limit");
    if (typeof item === "string") {
      remaining -= item.length;
      if (remaining < 0) throw new Error("Observation limit");
      return item;
    }
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || seen.has(item))
      throw new Error("Unsupported observation");
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > 2_048) throw new Error("Observation limit");
      return ["array", item.map((entry) => normalize(entry, depth + 1))];
    }
    if (Object.getPrototypeOf(item) !== Object.prototype)
      throw new Error("Unsupported observation");
    const keys = Object.keys(item);
    if (keys.length > 2_048) throw new Error("Observation limit");
    return [
      "object",
      keys
        .sort()
        .map((key) => [
          normalize(key, depth + 1),
          normalize((item as Record<string, unknown>)[key], depth + 1),
        ]),
    ];
  };
  try {
    return createHash("sha256")
      .update(JSON.stringify(normalize(value)))
      .digest("hex");
  } catch {
    return undefined;
  }
}

/** Bounded request-lifetime history, shared by replacement provider streams. */
export class ToolLoopObserver {
  private history: Step[] = [];
  private reported = new Set<string>();

  shouldReport(reason: string, action: string, repeatCount: number): boolean {
    const key = `${reason}:${action}:${repeatCount}`;
    if (this.reported.size >= 16 || this.reported.has(key)) return false;
    this.reported.add(key);
    return true;
  }

  observe(
    calls: readonly ToolCall[],
    results: readonly ToolResult[],
    allowedTools: ReadonlySet<string>,
  ):
    | { toolNames: string[]; repeatCount: number; cycleLength: number }
    | undefined {
    const clear = () => {
      this.history = [];
      return undefined;
    };
    if (!calls.length || calls.length > 64 || results.length > 64)
      return clear();
    // Waiting is expected to return unchanged output. Do not remove these steps
    // and accidentally join otherwise unrelated calls into a repeating cycle.
    if (calls.every((call) => POLLING_TOOLS.has(call.toolName))) return clear();
    const signatures: string[] = [];
    for (const call of calls) {
      if (!allowedTools.has(call.toolName)) return clear();
      const result = results.find(
        (entry) => entry.toolCallId === call.toolCallId,
      );
      if (!result) return clear();
      const input =
        call.input &&
        typeof call.input === "object" &&
        !Array.isArray(call.input)
          ? Object.fromEntries(
              Object.entries(call.input).filter(
                ([key]) => key !== "brief" && key !== "explanation",
              ),
            )
          : call.input;
      const signature = fingerprint([call.toolName, input, result.output]);
      if (!signature) return clear();
      signatures.push(signature);
    }
    this.history.push({
      fingerprint: signatures.sort().join(":"),
      toolNames: [...new Set(calls.map((call) => call.toolName))],
    });
    this.history = this.history.slice(-MAX_PERIOD * REPORT_LAPS[1]);
    for (let period = 1; period <= MAX_PERIOD; period++) {
      let laps = 1;
      const end = this.history.length;
      while (
        end >= (laps + 1) * period &&
        this.history
          .slice(end - (laps + 1) * period, end - laps * period)
          .every(
            (step, index) =>
              step.fingerprint ===
              this.history[end - period + index].fingerprint,
          )
      )
        laps++;
      if (laps >= REPORT_LAPS[0]) {
        if (!(REPORT_LAPS as readonly number[]).includes(laps))
          return undefined;
        return {
          toolNames: [
            ...new Set(
              this.history.slice(-period).flatMap((step) => step.toolNames),
            ),
          ],
          repeatCount: laps,
          cycleLength: period,
        };
      }
    }
    return undefined;
  }
}
