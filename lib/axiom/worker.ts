/**
 * Framework-agnostic Axiom logger for use in Trigger.dev, workers, and other
 * non-Next.js contexts. Does NOT import @axiomhq/nextjs to avoid Next.js-specific
 * code that may not run in isolated runtimes (e.g., Trigger.dev tasks).
 */

import axiomClient from "@/lib/axiom/axiom";
import { Logger, AxiomJSTransport } from "@axiomhq/logging";
import type { Formatter } from "@axiomhq/logging";

/** Formatter that injects context for retry/sandbox logs (runtime, default source) */
export const retryContextFormatter: Formatter = (logEvent) => ({
  ...logEvent,
  fields: {
    ...logEvent.fields,
    ...(logEvent.fields?.source == null && { source: "retry" }),
    runtime: typeof process !== "undefined" ? "node" : "unknown",
  },
});

let _workerLogger: Logger | null = null;

function getWorkerLogger(): Logger | null {
  if (_workerLogger) return _workerLogger;
  const token = process.env.AXIOM_TOKEN;
  const dataset = process.env.AXIOM_DATASET;
  if (!token || !dataset) return null;
  try {
    _workerLogger = new Logger({
      transports: [
        new AxiomJSTransport({
          axiom: axiomClient,
          dataset,
        }),
      ],
      formatters: [retryContextFormatter],
    });
    return _workerLogger;
  } catch {
    return null;
  }
}

/**
 * Creates a logger function matching the retry-with-backoff callback signature.
 * Sends logs to Axiom when configured, otherwise falls back to console.
 *
 * @param source - Optional label for the log source (e.g., "sandbox-health", "terminal-cmd")
 */
export function createRetryLogger(
  source?: string,
): (message: string, error?: unknown) => void {
  const label = source ? `[${source}] ` : "[Retry] ";
  return (message: string, error?: unknown) => {
    const logger = getWorkerLogger();
    const fields: Record<string, unknown> = {};
    if (source) fields.source = source;
    if (error !== undefined) {
      fields.errorMessage =
        error instanceof Error ? error.message : String(error);
      if (error instanceof Error && error.stack)
        fields.errorStack = error.stack;
    }
    if (logger) {
      logger.warn(message, fields);
    } else {
      const suffix =
        error !== undefined
          ? ` ${error instanceof Error ? error.message : error}`
          : "";
      console.warn(`${label}${message}${suffix}`);
    }
  };
}
