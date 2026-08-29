import { createHash } from "node:crypto";
import type { AnySandbox } from "@/types";
import type { createTerminalHandler } from "@/lib/utils/terminal-executor";
import { phLogger } from "@/lib/posthog/server";
import { FULL_OUTPUT_SAVED_MESSAGE } from "@/lib/token-utils";
import {
  asCommonSandbox,
  isCentrifugoSandbox,
  isE2BSandbox,
} from "./sandbox-types";

export const MAX_SAVED_TERMINAL_OUTPUT_FILES = 10;
const DESKTOP_RELAY_RETRY_DELAY_MS = 250;
export const FULL_OUTPUT_SAVE_FAILED_MESSAGE =
  "\n[Full terminal output could not be saved. The output below is truncated. Do not rerun the original command unchanged. If the omitted content is necessary, use a safe, read-only follow-up with narrower output, filters, or line ranges. Otherwise, explain the limitation and continue.]";

type TerminalOutputPersistenceProvider = "e2b" | "desktop" | "centrifugo";
type TerminalOutputPersistenceFailureCategory =
  | "timeout"
  | "transport"
  | "relay_unavailable"
  | "permission"
  | "filesystem"
  | "unknown";

export type TerminalOutputPersistenceTelemetry = {
  service: "agent-long" | "chat-handler";
  environment: string;
  requestId?: string | null;
  triggerRunId?: string | null;
  chatId?: string;
  userId?: string;
};

const getPersistenceProvider = (
  sandbox: AnySandbox,
): TerminalOutputPersistenceProvider => {
  if (isCentrifugoSandbox(sandbox)) {
    if (
      typeof sandbox.supportsNativeFileRelay === "function" &&
      sandbox.supportsNativeFileRelay()
    ) {
      return "desktop";
    }
    return "centrifugo";
  }
  return "e2b";
};

export const classifyTerminalOutputPersistenceFailure = (
  error: unknown,
): TerminalOutputPersistenceFailureCategory => {
  const message = (
    error instanceof Error
      ? error.message
      : error && typeof error === "object"
        ? (["message", "error", "reason", "code"]
            .map((key) => (error as Record<string, unknown>)[key])
            .find((value): value is string => typeof value === "string") ?? "")
        : typeof error === "string"
          ? error
          : ""
  ).toLowerCase();
  if (/timed?\s*out|timeout/.test(message)) return "timeout";
  if (
    /not subscribed|relay is not available|reconnect the desktop app|connection(?: is)? inactive|connection_inactive/.test(
      message,
    )
  ) {
    return "relay_unavailable";
  }
  if (
    /load failed|failed to publish|subscription error|network|disconnected|connection (?:closed|reset)|econnreset/.test(
      message,
    )
  ) {
    return "transport";
  }
  if (
    /outside its allowed root|permission denied|access denied|eacces|eperm/.test(
      message,
    )
  ) {
    return "permission";
  }
  if (
    /no space left|enospc|read-only file system|enoent|not a directory/.test(
      message,
    )
  ) {
    return "filesystem";
  }
  return "unknown";
};

const canRetryDesktopRelayFailure = (
  provider: TerminalOutputPersistenceProvider,
  category: TerminalOutputPersistenceFailureCategory,
): boolean =>
  provider === "desktop" &&
  (category === "transport" ||
    category === "relay_unavailable" ||
    category === "unknown");

const emitPersistenceFailure = (args: {
  provider: TerminalOutputPersistenceProvider;
  attemptCount: number;
  result: "recovered" | "failed";
  failureCategory: TerminalOutputPersistenceFailureCategory;
  retryDecision:
    "retried" | "verified_after_timeout" | "skipped_timeout" | "not_retryable";
  telemetry?: TerminalOutputPersistenceTelemetry;
}): void => {
  const fields = {
    provider: args.provider,
    attempt_count: args.attemptCount,
    result: args.result,
    failure_category: args.failureCategory,
    retry_decision: args.retryDecision,
    service: args.telemetry?.service ?? "unknown",
    environment: args.telemetry?.environment ?? "unknown",
    request_id: args.telemetry?.requestId ?? null,
    trace_id: args.telemetry?.triggerRunId ?? null,
    trigger_run_id: args.telemetry?.triggerRunId ?? null,
    chat_id: args.telemetry?.chatId ?? null,
    user_id: args.telemetry?.userId ?? null,
  };

  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    level: args.result === "recovered" ? "info" : "warn",
    event: "terminal_output_persistence_failure",
    ...fields,
  });
  if (args.result === "recovered") console.info(payload);
  else console.warn(payload);

  phLogger.event("terminal_output_persistence_failure", {
    ...(args.telemetry?.userId && { userId: args.telemetry.userId }),
    ...fields,
  });
};

/** Builds a stable, non-identifying output directory for one chat scope. */
const getOutputDirectory = (sandbox: AnySandbox, scopeId?: string): string => {
  const baseDirectory = isE2BSandbox(sandbox)
    ? "/home/user/terminal_full_output"
    : "/tmp/terminal_full_output";
  const scopeKey = scopeId
    ? createHash("sha256").update(scopeId).digest("hex").slice(0, 16)
    : "unscoped";

  return `${baseDirectory}/chat-${scopeKey}`;
};

/** Deletes the oldest timestamped output files beyond the per-chat limit. */
const pruneOldSavedOutputs = async (
  sandbox: AnySandbox,
  directory: string,
): Promise<void> => {
  const files = asCommonSandbox(sandbox).files;
  const savedOutputs = (await files.list(directory))
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".txt"))
    .sort()
    .reverse();

  for (const staleName of savedOutputs.slice(MAX_SAVED_TERMINAL_OUTPUT_FILES)) {
    const stalePath = staleName.startsWith("/")
      ? staleName
      : `${directory}/${staleName}`;
    await files.remove(stalePath);
  }
};

/**
 * Save full terminal output to a file in the sandbox when it exceeds token limits.
 * E2B saves under ~/terminal_full_output/. Desktop and other Centrifugo
 * sandboxes save under /tmp/terminal_full_output/. Each chat gets an isolated
 * retained directory.
 * Returns the file path if saved, or null if saving failed.
 */
export async function saveFullOutputToFile(
  sandbox: AnySandbox,
  fullOutput: string,
  scopeId?: string,
  telemetry?: TerminalOutputPersistenceTelemetry,
): Promise<string | null> {
  const provider = getPersistenceProvider(sandbox);
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/[T]/g, "_")
    .replace(/[:]/g, "-")
    .replace(/\./, "_");
  // e.g. 2026-02-17_16-54-34_442Z

  const dir = getOutputDirectory(sandbox, scopeId);
  const filePath = `${dir}/${timestamp}.txt`;
  const save = async (): Promise<string> => {
    await sandbox.commands.run(`mkdir -p ${dir}`, {
      timeoutMs: 5000,
    });
    await sandbox.files.write(filePath, fullOutput);

    try {
      await pruneOldSavedOutputs(sandbox, dir);
    } catch (err) {
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          event: "terminal_output_retention_prune_failed",
          service: telemetry?.service ?? "unknown",
          environment: telemetry?.environment ?? "unknown",
          request_id: telemetry?.requestId ?? null,
          trace_id: telemetry?.triggerRunId ?? null,
          provider,
          failure_category: classifyTerminalOutputPersistenceFailure(err),
        }),
      );
    }

    return filePath;
  };

  let attemptCount = 1;
  try {
    return await save();
  } catch (firstError) {
    const firstCategory = classifyTerminalOutputPersistenceFailure(firstError);
    if (provider === "desktop" && firstCategory === "timeout") {
      const stat = (
        sandbox.files as unknown as {
          stat?: (path: string) => Promise<{ sizeBytes?: number }>;
        }
      ).stat;
      if (stat) {
        try {
          const metadata = await stat(filePath);
          if (metadata.sizeBytes === Buffer.byteLength(fullOutput, "utf8")) {
            emitPersistenceFailure({
              provider,
              attemptCount,
              result: "recovered",
              failureCategory: firstCategory,
              retryDecision: "verified_after_timeout",
              telemetry,
            });
            return filePath;
          }
        } catch {
          // A bounded metadata probe is only a fallback for a lost write ack.
        }
        emitPersistenceFailure({
          provider,
          attemptCount,
          result: "failed",
          failureCategory: firstCategory,
          retryDecision: "verified_after_timeout",
          telemetry,
        });
        return null;
      }
    }
    if (!canRetryDesktopRelayFailure(provider, firstCategory)) {
      emitPersistenceFailure({
        provider,
        attemptCount,
        result: "failed",
        failureCategory: firstCategory,
        retryDecision:
          firstCategory === "timeout" ? "skipped_timeout" : "not_retryable",
        telemetry,
      });
      return null;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, DESKTOP_RELAY_RETRY_DELAY_MS),
    );
    attemptCount += 1;
    try {
      const savedPath = await save();
      emitPersistenceFailure({
        provider,
        attemptCount,
        result: "recovered",
        failureCategory: firstCategory,
        retryDecision: "retried",
        telemetry,
      });
      return savedPath;
    } catch (retryError) {
      emitPersistenceFailure({
        provider,
        attemptCount,
        result: "failed",
        failureCategory: classifyTerminalOutputPersistenceFailure(retryError),
        retryDecision: "retried",
        telemetry,
      });
      return null;
    }
  }
}

/**
 * If the terminal handler's output was truncated, saves the full output to a file
 * in the sandbox and returns the notification message. Also streams the message
 * to the terminal writer for real-time UI feedback.
 *
 * Returns the save message string to append to the tool result, or empty string if
 * no save was needed/possible.
 */
export async function saveTruncatedOutput(opts: {
  handler: ReturnType<typeof createTerminalHandler>;
  sandbox: AnySandbox;
  terminalWriter: (output: string) => Promise<void>;
  scopeId?: string;
  telemetry?: TerminalOutputPersistenceTelemetry;
}): Promise<string> {
  const { handler, sandbox, terminalWriter, scopeId, telemetry } = opts;

  if (!handler.wasTruncated()) {
    return "";
  }

  const fullOutput = handler.getFullOutput();
  const savedPath = await saveFullOutputToFile(
    sandbox,
    fullOutput,
    scopeId,
    telemetry,
  );

  if (!savedPath) {
    await terminalWriter(FULL_OUTPUT_SAVE_FAILED_MESSAGE);
    return FULL_OUTPUT_SAVE_FAILED_MESSAGE;
  }

  const saveMsg = FULL_OUTPUT_SAVED_MESSAGE(
    savedPath,
    fullOutput.length,
    handler.wasFullOutputCapped(),
  );
  await terminalWriter(saveMsg);
  return saveMsg;
}
