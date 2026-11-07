import {
  getLocalFileRequestFailure,
  LocalFileRequestError,
  NativePathResolutionError,
} from "./local-sandbox-errors";
import { DesktopFileBridgeError } from "@/lib/centrifugo/desktop-file-errors";
import { ZodError } from "zod";

const CHECKPOINT_FAILURE_ORIGINS = [
  "local_file_request",
  "desktop_file_bridge",
  "windows_path_resolution",
  "windows_path_missing_utility",
  "windows_path_shell_syntax",
  "windows_path_permission",
  "windows_path_command_failed",
  "windows_path_empty_output",
  "windows_path_output_control",
  "windows_path_non_absolute_output",
  "command_path_limit",
  "record_validation",
  "type_error",
  "range_error",
  "other_error",
  "thrown_value",
  "unreadable_error",
] as const;
export type CheckpointFailureOrigin =
  (typeof CHECKPOINT_FAILURE_ORIGINS)[number];

/** Reject any value outside the fixed checkpoint metric vocabulary. */
export function parseCheckpointFailureOrigin(
  value: unknown,
): CheckpointFailureOrigin | undefined {
  return typeof value === "string" &&
    (CHECKPOINT_FAILURE_ORIGINS as readonly string[]).includes(value)
    ? (value as CheckpointFailureOrigin)
    : undefined;
}

/** Preserve only known source guards or error kinds, never private text/stack. */
export function checkpointFailureOrigin(
  error: unknown,
): CheckpointFailureOrigin {
  try {
    if (error instanceof LocalFileRequestError) return "local_file_request";
    if (error instanceof DesktopFileBridgeError) return "desktop_file_bridge";
    if (error instanceof NativePathResolutionError) {
      switch (error.failure) {
        case "missing_utility":
          return "windows_path_missing_utility";
        case "shell_syntax":
          return "windows_path_shell_syntax";
        case "permission":
          return "windows_path_permission";
        case "command_failed":
          return "windows_path_command_failed";
        case "empty_output":
          return "windows_path_empty_output";
        case "output_control":
          return "windows_path_output_control";
        case "non_absolute_output":
          return "windows_path_non_absolute_output";
      }
    }
    if (error instanceof ZodError) return "record_validation";
    if (error instanceof TypeError) return "type_error";
    if (error instanceof RangeError) return "range_error";
    if (!(error instanceof Error)) return "thrown_value";
    switch (error.message) {
      case "Failed to resolve the Windows file path through Git Bash":
        return "windows_path_resolution";
      case "File path exceeds the local file command limit":
        return "command_path_limit";
      default:
        return "other_error";
    }
  } catch {
    return "unreadable_error";
  }
}

export type PersistenceFailureCategory =
  | "aborted"
  | "timeout"
  | "transport"
  | "relay_unavailable"
  | "permission"
  | "filesystem"
  | "unknown"
  | "unsupported_client"
  | "private_storage_unavailable"
  | "shell_syntax"
  | "missing_utility"
  | "read_only_filesystem"
  | "no_space"
  | "unsafe_artifact";

/** Carries only a bounded diagnostic, never shell output, paths or content. */
export class PersistenceError extends Error {
  constructor(
    message: string,
    readonly persistenceCategory: PersistenceFailureCategory,
    readonly exitCode?: number,
  ) {
    super(message);
    this.name = "PersistenceError";
  }
}

/** Describe only our fixed command producers; never retain error text or stderr. */
export function checkpointCommandContext(error: unknown): {
  command_stage: string;
  command_exit_code: number | "none" | "other";
} {
  let commandStage = "none";
  let exitCode: unknown;
  try {
    if (error instanceof PersistenceError) {
      commandStage = "other";
      // Data descriptors avoid invoking error accessors for optional diagnostics.
      const message = Object.getOwnPropertyDescriptor(error, "message")?.value;
      switch (message) {
        case "Failed to detect local shell":
          commandStage = "detect_shell";
          break;
        case "Failed to create directory":
          commandStage = "create_directory";
          break;
        case "Failed to write file":
          commandStage = "write_file";
          break;
        case "Failed to decode file":
          commandStage = "decode_file";
          break;
        case "Private terminal artifact operation failed":
          commandStage = "private_artifact";
          break;
      }
      exitCode = Object.getOwnPropertyDescriptor(error, "exitCode")?.value;
    }
  } catch {
    commandStage = "unreadable";
  }
  return {
    command_stage: commandStage,
    command_exit_code:
      exitCode === undefined
        ? "none"
        : typeof exitCode === "number" &&
            Number.isInteger(exitCode) &&
            exitCode >= 0 &&
            exitCode <= 255
          ? exitCode
          : "other",
  };
}

/** Retain fixed cloud SDK error labels/status only, never its private message. */
export function checkpointCloudErrorContext(error: unknown): {
  cloud_error_kind: string;
  cloud_http_status: number | "none" | "other";
} {
  let kind = "other_error";
  let status: unknown;
  try {
    if (typeof error !== "object" || error === null) kind = "thrown_value";
    else {
      // E2B 2.x errors expose these as data properties. Do not invoke getters.
      const name = Object.getOwnPropertyDescriptor(error, "name")?.value;
      switch (name) {
        case "FileNotFoundError":
          kind = "file_not_found";
          break;
        case "SandboxNotFoundError":
          kind = "sandbox_not_found";
          break;
        case "NotFoundError":
          kind = "not_found";
          break;
        case "TimeoutError":
          kind = "timeout";
          break;
        case "InvalidArgumentError":
          kind = "invalid_argument";
          break;
        case "NotEnoughSpaceError":
          kind = "no_space";
          break;
        case "AuthenticationError":
          kind = "authentication";
          break;
        case "RateLimitError":
          kind = "rate_limit";
          break;
        case "ServiceBusyError":
          kind = "service_busy";
          break;
        case "SandboxError":
          kind = "sandbox_error";
          break;
      }
      if (
        kind === "other_error" &&
        Object.getOwnPropertyDescriptor(error, "message")?.value ===
          "Expected to receive information about written file"
      )
        kind = "empty_write_response";
      status = Object.getOwnPropertyDescriptor(error, "statusCode")?.value;
    }
  } catch {
    kind = "unreadable_error";
  }
  return {
    cloud_error_kind: kind,
    cloud_http_status:
      status === undefined
        ? "none"
        : typeof status === "number" &&
            Number.isInteger(status) &&
            status >= 100 &&
            status <= 599
          ? status
          : "other",
  };
}

export const classifyPersistenceFailure = (
  error: unknown,
): PersistenceFailureCategory => {
  if (error instanceof PersistenceError) return error.persistenceCategory;
  // Prefer the transport's typed failure over incidental words in native text.
  switch (getLocalFileRequestFailure(error)) {
    case "aborted":
      return "aborted";
    case "timeout":
    case "readiness_timeout":
      return "timeout";
    case "unavailable":
    case "relay_unsubscribed":
      return "relay_unavailable";
    case "subscription_error":
    case "dispatch_error":
      return "transport";
  }
  const message = (
    error && typeof error === "object"
      ? ["message", "error", "reason", "code"]
          .map((key) => (error as Record<string, unknown>)[key])
          .filter((value) => typeof value === "string")
          .join(" ")
      : typeof error === "string"
        ? error
        : ""
  ).toLowerCase();
  if (/requires an updated hackerai local client/.test(message))
    return "unsupported_client";
  if (
    /syntax error|unexpected token|syntax of the command is incorrect/.test(
      message,
    )
  )
    return "shell_syntax";
  if (
    /command not found|is not recognized as an internal or external command/.test(
      message,
    )
  )
    return "missing_utility";
  if (/read-only file system|erofs/.test(message))
    return "read_only_filesystem";
  if (/no space left|enospc|edquot/.test(message)) return "no_space";
  if (/timed?\s*out|timeout/.test(message)) return "timeout";
  if (
    /not subscribed|relay is not available|reconnect the desktop app|connection(?: is)? inactive|connection_inactive/.test(
      message,
    )
  ) {
    return "relay_unavailable";
  }
  if (
    /load failed|failed to publish|subscription error|network|disconnected|connection (?:closed|reset)|econnreset|file transport is unavailable/.test(
      message,
    )
  ) {
    return "transport";
  }
  if (
    /outside (?:its allowed root|the allowed project folder)|permission denied|access denied|eacces|eperm/.test(
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

/** Classify shell stderr locally before discarding it at the logging boundary. */
export function persistenceCommandError(
  message: string,
  result: { exitCode: number; stderr?: string },
  ownerOnly = false,
): PersistenceError {
  return new PersistenceError(
    message,
    ownerOnly && result.exitCode === 73
      ? "unsafe_artifact"
      : classifyPersistenceFailure(result.stderr),
    result.exitCode,
  );
}
