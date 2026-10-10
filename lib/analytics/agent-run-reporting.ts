import type { PostHog } from "posthog-node";
import { v5 as uuidv5 } from "uuid";

type RunEvent = "hackerai-agent_run" | "hackerai-usage_cost";
type FailureStage = "setup" | "preparation" | "model_stream";
type FailureKind = "error" | "canceled" | "usage_limit" | "elapsed_timeout";

/** Shared by normal completion and fallback capture, including retransmission. */
export const agentRunEventUuid = (runId: string, event: RunEvent) =>
  uuidv5(`hackerai:agent-run:v1:${runId}:${event}`, uuidv5.URL);

function field(value: unknown, key: string): unknown {
  try {
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

/** Only fixed categories leave this boundary, never arbitrary error content. */
export function agentFailureCategory(error: unknown): string {
  const seen = new Set<unknown>();
  let category = "unknown";
  for (let depth = 0; error != null && depth < 6; depth++) {
    if (seen.has(error)) break;
    seen.add(error);
    const message = typeof error === "string" ? error : field(error, "message");
    const code = field(error, "code");
    if (
      code === "TooManyConcurrentRequests" ||
      (typeof message === "string" &&
        /TooManyConcurrentRequests|Too many concurrent requests/.test(message))
    )
      return "database_concurrency";
    if (field(error, "surface") === "database") category = "database";
    else if (code === "InternalServerError" && category === "unknown")
      category = "server_error";
    else if (field(error, "name") === "TimeoutError" && category === "unknown")
      category = "timeout";
    else if (field(error, "name") === "AbortError" && category === "unknown")
      category = "abort";
    else if (field(error, "name") === "TypeError" && category === "unknown")
      category = "type_error";
    const providerCategory = field(error, "category");
    if (
      category === "unknown" &&
      typeof providerCategory === "string" &&
      [
        "timeout",
        "stream_terminated",
        "rate_limited",
        "content_blocked",
        "provider_5xx",
        "provider_4xx",
      ].includes(providerCategory)
    )
      category = providerCategory;
    error = field(error, "cause");
  }
  return category;
}

const knownAmount = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

/**
 * Owns reporting only. It must never retry settlement, issue refunds, or start
 * work to recover a cost. Independent guards retain a successful cost capture
 * when terminal capture fails (and vice versa).
 */
export function createAgentRunReporting(context: {
  posthog: PostHog | null;
  runId: string;
  userId: string;
  chatId: string;
  subscription: string;
  endpoint: string;
}) {
  let stage: FailureStage = "setup";
  let failure:
    { stage: FailureStage; kind: FailureKind; category: string } | undefined;
  const captured = new Set<RunEvent>();
  let terminalOutcome: "success" | "error" | "aborted" | undefined;
  let terminalAbortSource: string | undefined;

  function once<T>(event: RunEvent, capture: (args: T) => void, args: T) {
    if (captured.has(event)) return;
    try {
      capture(args);
      captured.add(event);
    } catch {
      // A failed analytics enqueue must not turn a settled run into a failure.
      // Leave this event eligible for the outer fallback.
    }
  }

  return {
    setStage(next: FailureStage) {
      stage = next;
    },
    fail(error: unknown, kind: FailureKind = "error") {
      // Capture before ProviderTerminalError wrapping and cleanup exceptions.
      failure ??= { stage, kind, category: agentFailureCategory(error) };
    },
    captureTerminal<T>(capture: (args: T) => void, args: T) {
      const outcome = field(args, "outcome");
      if (
        outcome === "success" ||
        outcome === "error" ||
        outcome === "aborted"
      ) {
        terminalOutcome ??= outcome;
        const abortSource = field(args, "abortSource");
        if (
          typeof abortSource === "string" &&
          [
            "budget_exhausted",
            "agent_spend_cap",
            "elapsed_timeout",
            "user_stop",
            "request_cancel",
            "unknown",
          ].includes(abortSource)
        ) {
          terminalAbortSource ??= abortSource;
        }
      }
      once("hackerai-agent_run", capture, args);
    },
    captureCost<T>(capture: (args: T) => void, args: T) {
      once("hackerai-usage_cost", capture, args);
    },
    finalize(snapshot: {
      canceled: boolean;
      triggerCostDollars?: number;
      triggerDurationMs?: number;
      observedAccumulatedCostDollars?: number;
    }) {
      if (!context.posthog) return;
      const kind = failure?.kind ?? (snapshot.canceled ? "canceled" : "error");
      const outcome =
        terminalOutcome ?? (kind === "error" ? "error" : "aborted");
      const properties = {
        mode: "agent",
        subscription: context.subscription,
        subscription_tier: context.subscription,
        chat_id: context.chatId,
        trigger_run_id: context.runId,
        endpoint: context.endpoint,
        terminal_reporting_version: 1,
        terminal_reporting_source: "run_finally",
        failure_stage: failure?.stage ?? stage,
        failure_category: failure?.category ?? "missing_finalization",
        outcome,
        finish_reason: terminalOutcome ? "reporting_fallback" : kind,
        ...(outcome === "aborted" && {
          abort_source:
            terminalAbortSource ??
            (kind === "usage_limit"
              ? "budget_exhausted"
              : kind === "elapsed_timeout"
                ? "elapsed_timeout"
                : "request_cancel"),
        }),
        $process_person_profile: false,
      };
      for (const event of [
        "hackerai-agent_run",
        "hackerai-usage_cost",
      ] as const) {
        once(
          event,
          () =>
            context.posthog!.capture({
              distinctId: context.userId,
              uuid: agentRunEventUuid(context.runId, event),
              event,
              properties: {
                ...properties,
                ...(event === "hackerai-usage_cost"
                  ? {
                      // This is a coverage record, not a billable/full-cost estimate.
                      cost_accounting_status: "incomplete",
                      usage_settlement_status: "unknown",
                      cost_dollars: null,
                      model_cost_dollars: null,
                      non_model_cost_dollars: null,
                      known_trigger_cost_dollars: knownAmount(
                        snapshot.triggerCostDollars,
                      ),
                      observed_accumulated_cost_dollars: knownAmount(
                        snapshot.observedAccumulatedCostDollars,
                      ),
                      trigger_cost_is_final: false,
                    }
                  : {}),
                trigger_usage_duration_ms: knownAmount(
                  snapshot.triggerDurationMs,
                ),
              },
            }),
          undefined,
        );
      }
    },
  };
}
