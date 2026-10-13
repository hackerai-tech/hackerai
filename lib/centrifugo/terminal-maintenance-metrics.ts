import { metrics } from "@opentelemetry/api";
import type { AnySandbox } from "@/types";
import { isCentrifugoSandbox } from "@/lib/ai/tools/utils/sandbox-types";

type MaintenanceEvent = {
  operation:
    | "checkpoint_write"
    | "recovery_read"
    | "retention_read"
    | "prune_route"
    | "prune_fallback";
  outcome:
    | "success"
    | "failure"
    | "rejected"
    | "fallback"
    | "incomplete"
    | "throttled";
  transport: "native_file" | "posix_command";
  reason?: "windows" | "node_unavailable";
  payloadBytes?: number;
};

/** Logical record payloads, not wire bytes. Never accept content or identifiers. */
export function recordTerminalMaintenance(
  sandbox: AnySandbox,
  event: MaintenanceEvent,
): void {
  try {
    if (!isCentrifugoSandbox(sandbox)) return;
    // Resolve the provider at emission time: Trigger can register after import.
    const meter = metrics.getMeter("hackerai.local-relay");
    const source =
      typeof sandbox.getRelayTrafficSource === "function"
        ? sandbox.getRelayTrafficSource()
        : "unknown";
    const attributes = {
      operation: event.operation,
      outcome: event.outcome,
      transport: event.transport,
      reason: event.reason ?? "none",
      source,
    };
    meter
      .createCounter("hackerai.local_relay.terminal_record_operations", {
        description:
          "Local terminal record operations and retention routing outcomes",
        unit: "{operation}",
      })
      .add(1, attributes);
    if (Number.isSafeInteger(event.payloadBytes) && event.payloadBytes! > 0) {
      meter
        .createCounter("hackerai.local_relay.terminal_record_payload_bytes", {
          description:
            "UTF-8 record bytes returned by reads or attempted by writes; excludes wire overhead",
          unit: "By",
        })
        .add(event.payloadBytes!, attributes);
    }
  } catch {
    // Metrics must never interrupt persistence, recovery, or retention.
  }
}
