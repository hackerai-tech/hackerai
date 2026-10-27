import { getLocalFileRequestFailure } from "./local-sandbox-errors";
import {
  classifyPersistenceFailure as classifyTerminalOutputPersistenceFailure,
  persistenceCommandError,
  PersistenceError,
  type PersistenceFailureCategory as TerminalOutputPersistenceFailureCategory,
} from "./persistence-failure";
import { createHash } from "node:crypto";
import type { AnySandbox } from "@/types";
import type { createTerminalHandler } from "@/lib/utils/terminal-executor";
import { phLogger } from "@/lib/posthog/server";
import { FULL_OUTPUT_SAVED_MESSAGE } from "@/lib/token-utils";
import {
  asCommonSandbox,
  isCentrifugoSandbox,
  getSandboxArtifactDirectory,
} from "./sandbox-types";
import {
  listOwnerOnlyPosixFiles,
  removeOwnerOnlyPosixFile,
  usesOwnerOnlyPosixFileTransport,
  writeOwnerOnlyPosixFile,
} from "./owner-only-posix-file";

export const MAX_SAVED_TERMINAL_OUTPUT_FILES = 10;
const PERSISTENCE_RETRY_DELAY_MS = 250;
export const FULL_OUTPUT_SAVE_FAILED_MESSAGE =
  "\n[Full terminal output could not be saved. The output below is truncated. Do not rerun the original command unchanged. If the omitted content is necessary, use a safe, read-only follow-up with narrower output, filters, or line ranges. Otherwise, explain the limitation and continue.]";

type TerminalOutputPersistenceProvider = "e2b" | "desktop" | "centrifugo";

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

export { classifyPersistenceFailure as classifyTerminalOutputPersistenceFailure } from "./persistence-failure";

const canRetryPersistenceFailure = (
  provider: TerminalOutputPersistenceProvider,
  category: TerminalOutputPersistenceFailureCategory,
): boolean =>
  provider === "desktop" &&
  (category === "transport" ||
    category === "relay_unavailable" ||
    category === "unknown");

const getPersistenceSandboxFields = (
  provider: TerminalOutputPersistenceProvider,
): {
  sandbox_type: "cloud" | "desktop" | "remote-connection";
  sandbox_provider?: "e2b";
} => {
  if (provider === "e2b") {
    return { sandbox_type: "cloud", sandbox_provider: provider };
  }
  return {
    sandbox_type: provider === "desktop" ? "desktop" : "remote-connection",
  };
};

// Transport selection and client identity are different: an older Desktop
// bridge can fall back to the command transport. Never send host names or paths.
const getClientFields = (sandbox: AnySandbox) => {
  if (!isCentrifugoSandbox(sandbox)) return { client_surface: "cloud" };
  const info = sandbox.getConnectionInfo?.();
  const platform = info?.osInfo?.platform;
  return {
    client_surface:
      info?.isDesktop === true ? "desktop" : info ? "local" : "unknown",
    client_platform: ["win32", "darwin", "linux"].includes(platform ?? "")
      ? platform
      : "unknown",
    native_file_relay: sandbox.supportsNativeFileRelay?.() ?? null,
    command_stdin: sandbox.supportsCommandStdin?.() ?? null,
    operation_channels: info?.capabilities?.operationChannels === true,
  };
};

type TimeoutVerification =
  "matched_size" | "size_mismatch" | "probe_failed" | "unavailable";

const emitPersistenceFailure = (args: {
  sandbox: AnySandbox;
  error?: unknown;
  timeoutVerification?: TimeoutVerification;
  verificationError?: unknown;
  provider: TerminalOutputPersistenceProvider;
  attemptCount: number;
  result: "recovered" | "failed";
  failureCategory: TerminalOutputPersistenceFailureCategory;
  retryDecision:
    "retried" | "verified_after_timeout" | "skipped_timeout" | "not_retryable";
  telemetry?: TerminalOutputPersistenceTelemetry;
  failureStage?: "ensure_directory" | "write_output";
}): void => {
  const fields = {
    ...getPersistenceSandboxFields(args.provider),
    ...getClientFields(args.sandbox),
    local_file_failure: getLocalFileRequestFailure(args.error),
    command_exit_code:
      args.error instanceof PersistenceError ? args.error.exitCode : undefined,
    timeout_verification: args.timeoutVerification,
    verification_failure_category:
      args.verificationError === undefined
        ? undefined
        : classifyTerminalOutputPersistenceFailure(args.verificationError),
    // Retained for existing dashboards; use sandbox_provider for cloud backend.
    provider: args.provider,
    attempt_count: args.attemptCount,
    result: args.result,
    failure_category: args.failureCategory,
    failure_stage: args.failureStage,
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

  // Exactly one result event per eligible save, including retry recovery.
  phLogger.event("terminal_output_persistence_result", {
    ...(args.telemetry?.userId && { userId: args.telemetry.userId }),
    ...fields,
  });
  phLogger.event("terminal_output_persistence_failure", {
    ...(args.telemetry?.userId && { userId: args.telemetry.userId }),
    ...fields,
  });
};

/** Builds a stable, non-identifying output directory for one chat scope. */
const getOutputDirectory = (sandbox: AnySandbox, scopeId?: string): string => {
  const baseDirectory = getSandboxArtifactDirectory(
    sandbox,
    "terminal_full_output",
  );
  const scopeKey = scopeId
    ? createHash("sha256").update(scopeId).digest("hex").slice(0, 16)
    : "unscoped";

  return `${baseDirectory}/chat-${scopeKey}`;
};

/** Deletes the oldest timestamped output files beyond the per-chat limit. */
const pruneOldSavedOutputs = async (
  sandbox: AnySandbox,
  root: string,
  directory: string,
): Promise<void> => {
  const files = asCommonSandbox(sandbox).files;
  const ownerOnlyPosix = usesOwnerOnlyPosixFileTransport(sandbox);
  const savedOutputs = (
    ownerOnlyPosix
      ? await listOwnerOnlyPosixFiles(sandbox, root, directory)
      : await files.list(directory)
  )
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".txt"))
    .sort()
    .reverse();

  for (const staleName of savedOutputs.slice(MAX_SAVED_TERMINAL_OUTPUT_FILES)) {
    const stalePath = staleName.startsWith("/")
      ? staleName
      : `${directory}/${staleName}`;
    if (ownerOnlyPosix) {
      await removeOwnerOnlyPosixFile(sandbox, root, directory, stalePath);
    } else {
      await files.remove(stalePath);
    }
  }
};

/**
 * Save full terminal output to a file in the sandbox when it exceeds token limits.
 * Native Desktop saves within the selected project. Other local sandboxes
 * use /tmp/terminal_full_output/. Each chat gets an isolated
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
  const root = dir.slice(0, dir.lastIndexOf("/"));
  const filePath = `${dir}/${timestamp}.txt`;
  let failureStage: "ensure_directory" | "write_output" = "ensure_directory";
  const save = async (): Promise<string> => {
    failureStage = "ensure_directory";
    if (usesOwnerOnlyPosixFileTransport(sandbox)) {
      failureStage = "write_output";
      await writeOwnerOnlyPosixFile(sandbox, root, dir, filePath, fullOutput);
    } else {
      // Local file adapters already create parents using their platform-aware
      // path handling; native writes also enforce the project boundary.
      if (!isCentrifugoSandbox(sandbox)) {
        const mkdirResult = await sandbox.commands.run(`mkdir -p ${dir}`, {
          timeoutMs: 5000,
        });
        if (mkdirResult.exitCode !== 0)
          throw persistenceCommandError(
            "Output directory creation failed",
            mkdirResult,
          );
      }
      failureStage = "write_output";
      await sandbox.files.write(filePath, fullOutput);
    }

    try {
      await pruneOldSavedOutputs(sandbox, root, dir);
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
          ...getPersistenceSandboxFields(provider),
          provider,
          failure_category: classifyTerminalOutputPersistenceFailure(err),
        }),
      );
    }

    return filePath;
  };

  let attemptCount = 1;
  try {
    const savedPath = await save();
    phLogger.event("terminal_output_persistence_result", {
      ...(telemetry?.userId && { userId: telemetry.userId }),
      ...getPersistenceSandboxFields(provider),
      ...getClientFields(sandbox),
      provider,
      result: "saved",
      attempt_count: attemptCount,
      service: telemetry?.service ?? "unknown",
      environment: telemetry?.environment ?? "unknown",
      request_id: telemetry?.requestId ?? null,
      trigger_run_id: telemetry?.triggerRunId ?? null,
    });
    return savedPath;
  } catch (firstError) {
    const firstStage = failureStage;
    const firstCategory = classifyTerminalOutputPersistenceFailure(firstError);
    if (provider === "desktop" && firstCategory === "timeout") {
      const stat = (
        sandbox.files as unknown as {
          stat?: (path: string) => Promise<{ sizeBytes?: number }>;
        }
      ).stat;
      if (stat) {
        let timeoutVerification: TimeoutVerification = "size_mismatch";
        let verificationError: unknown;
        try {
          const metadata = await stat.call(sandbox.files, filePath);
          if (metadata.sizeBytes === Buffer.byteLength(fullOutput, "utf8")) {
            emitPersistenceFailure({
              sandbox,
              error: firstError,
              timeoutVerification: "matched_size",
              provider,
              attemptCount,
              result: "recovered",
              failureCategory: firstCategory,
              retryDecision: "verified_after_timeout",
              failureStage: firstStage,
              telemetry,
            });
            return filePath;
          }
        } catch (error) {
          timeoutVerification = "probe_failed";
          verificationError = error;
          // A bounded metadata probe is only a fallback for a lost write ack.
        }
        emitPersistenceFailure({
          sandbox,
          error: firstError,
          timeoutVerification,
          verificationError,
          provider,
          attemptCount,
          result: "failed",
          failureCategory: firstCategory,
          retryDecision: "verified_after_timeout",
          failureStage: firstStage,
          telemetry,
        });
        return null;
      }
    }
    if (!canRetryPersistenceFailure(provider, firstCategory)) {
      emitPersistenceFailure({
        sandbox,
        error: firstError,
        timeoutVerification:
          provider === "desktop" && firstCategory === "timeout"
            ? "unavailable"
            : undefined,
        provider,
        attemptCount,
        result: "failed",
        failureCategory: firstCategory,
        retryDecision:
          firstCategory === "timeout" ? "skipped_timeout" : "not_retryable",
        telemetry,
        failureStage: firstStage,
      });
      return null;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, PERSISTENCE_RETRY_DELAY_MS),
    );
    attemptCount += 1;
    try {
      const savedPath = await save();
      emitPersistenceFailure({
        sandbox,
        error: firstError,
        provider,
        attemptCount,
        result: "recovered",
        failureCategory: firstCategory,
        retryDecision: "retried",
        telemetry,
        failureStage: firstStage,
      });
      return savedPath;
    } catch (retryError) {
      emitPersistenceFailure({
        sandbox,
        error: retryError,
        provider,
        attemptCount,
        result: "failed",
        failureCategory: classifyTerminalOutputPersistenceFailure(retryError),
        retryDecision: "retried",
        telemetry,
        failureStage,
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
  onSavedPath?: (path: string) => void;
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
    const missingPrivateTransport =
      usesOwnerOnlyPosixFileTransport(sandbox) &&
      isCentrifugoSandbox(sandbox) &&
      sandbox.supportsCommandStdin?.() === false;
    const recovery = missingPrivateTransport
      ? sandbox.getConnectionInfo?.()?.isDesktop
        ? "\n[Desktop file access is unavailable. Ask the user to restart or update the Desktop app and reconnect this computer. Do not work around the private-storage guard.]"
        : "\n[The local client has not enabled private artifact storage. Ask the user to reconnect an up-to-date local client; if it persists, check the local client's private-storage startup error. Do not bypass the ownership checks.]"
      : "";
    const message = FULL_OUTPUT_SAVE_FAILED_MESSAGE + recovery;
    await terminalWriter(message);
    return message;
  }
  opts.onSavedPath?.(savedPath);

  const saveMsg = FULL_OUTPUT_SAVED_MESSAGE(
    savedPath,
    fullOutput.length,
    handler.wasFullOutputCapped(),
  );
  await terminalWriter(saveMsg);
  return saveMsg;
}
