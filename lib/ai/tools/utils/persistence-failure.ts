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

export type PrivateArtifactWritePhase = "prepare" | "append" | "commit";
const PRIVATE_ARTIFACT_PREPARE_STEPS = [
  "root_validate",
  "root_mkdir",
  "root_chmod",
  "directory_validate",
  "directory_mkdir",
  "directory_chmod",
  "target_validate",
  "temporary_validate",
  "temporary_create",
  "temporary_chmod",
] as const;
export type PrivateArtifactPrepareStep =
  (typeof PRIVATE_ARTIFACT_PREPARE_STEPS)[number];

/** Carries only a bounded diagnostic, never shell output, paths or content. */
export class PersistenceError extends Error {
  constructor(
    message: string,
    readonly persistenceCategory: PersistenceFailureCategory,
    readonly exitCode?: number,
    readonly privateArtifactWritePhase?: PrivateArtifactWritePhase,
    readonly privateArtifactPrepareStep?: PrivateArtifactPrepareStep,
  ) {
    super(message);
    this.name = "PersistenceError";
  }
}

/** Describe only our fixed command producers; never retain error text or stderr. */
export function checkpointCommandContext(error: unknown): {
  command_stage: string;
  native_path_command_id?: string;
  native_path_receiver_mode?: string;
  private_artifact_write_phase?: PrivateArtifactWritePhase;
  private_artifact_prepare_step?: PrivateArtifactPrepareStep;
  command_exit_code: number | "none" | "other";
  command_exit_code_shape:
    | "none"
    | "exit_status"
    | "sentinel_minus_one"
    | "negative_integer"
    | "out_of_range"
    | "non_integer"
    | "non_numeric"
    | "unreadable";
} {
  let commandStage = "none";
  let exitCode: unknown;
  let writePhase: unknown;
  let prepareStep: unknown;
  const nativePath: {
    native_path_command_id?: string;
    native_path_receiver_mode?: string;
  } = {};
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
  if (commandStage === "private_artifact") {
    try {
      writePhase = Object.getOwnPropertyDescriptor(
        error,
        "privateArtifactWritePhase",
      )?.value;
    } catch {
      // A missing optional phase cannot invalidate the existing command context.
    }
    try {
      prepareStep = Object.getOwnPropertyDescriptor(
        error,
        "privateArtifactPrepareStep",
      )?.value;
    } catch {
      /* Independent optional context. */
    }
  }
  try {
    if (error instanceof NativePathResolutionError) {
      const context = Object.getOwnPropertyDescriptor(
        error,
        "commandContext",
      )?.value;
      if (context && typeof context === "object") {
        const id = Object.getOwnPropertyDescriptor(context, "commandId")?.value;
        const mode = Object.getOwnPropertyDescriptor(
          context,
          "receiverMode",
        )?.value;
        if (
          typeof id === "string" &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
            id,
          )
        )
          nativePath.native_path_command_id = id;
        if (
          typeof mode === "string" &&
          /^(desktop|local|unknown)_(isolated|shared)$/.test(mode)
        )
          nativePath.native_path_receiver_mode = mode;
      }
    }
  } catch {
    /* Optional native receipt context cannot invalidate existing fields. */
  }
  return {
    command_stage: commandStage,
    ...nativePath,
    ...(commandStage === "private_artifact" &&
    writePhase === "prepare" &&
    PRIVATE_ARTIFACT_PREPARE_STEPS.includes(
      prepareStep as PrivateArtifactPrepareStep,
    )
      ? {
          private_artifact_prepare_step:
            prepareStep as PrivateArtifactPrepareStep,
        }
      : {}),
    ...(commandStage === "private_artifact" &&
    (writePhase === "prepare" ||
      writePhase === "append" ||
      writePhase === "commit")
      ? { private_artifact_write_phase: writePhase }
      : {}),
    command_exit_code:
      exitCode === undefined
        ? "none"
        : typeof exitCode === "number" &&
            Number.isInteger(exitCode) &&
            exitCode >= 0 &&
            exitCode <= 255
          ? exitCode
          : "other",
    // Keep the original code bound; distinguish withheld values without
    // retaining an arbitrary number or invoking an error accessor.
    command_exit_code_shape:
      commandStage === "unreadable"
        ? "unreadable"
        : exitCode === undefined
          ? "none"
          : typeof exitCode !== "number"
            ? "non_numeric"
            : !Number.isInteger(exitCode)
              ? "non_integer"
              : exitCode === -1
                ? "sentinel_minus_one"
                : exitCode < 0
                  ? "negative_integer"
                  : exitCode > 255
                    ? "out_of_range"
                    : "exit_status",
  };
}

const CLOUD_TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "ABORT_ERR",
]);

/** Retain fixed cloud SDK/transport labels only, never private error contents. */
export function checkpointCloudErrorContext(error: unknown): {
  cloud_error_kind: string;
  cloud_http_status: number | "none" | "other";
  cloud_type_error_signal?: "fetch_failed" | "other_type_error" | "unreadable";
  cloud_transport_code?: string;
} {
  let kind = "other_error";
  let status: unknown;
  let typeErrorSignal:
    "fetch_failed" | "other_type_error" | "unreadable" | undefined;
  let transportCode: string | undefined;
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
      if (error instanceof TypeError) {
        typeErrorSignal = "unreadable";
        transportCode = "unreadable";
        try {
          const message = Object.getOwnPropertyDescriptor(error, "message");
          if (!message || "value" in message)
            typeErrorSignal =
              message?.value === "fetch failed"
                ? "fetch_failed"
                : "other_type_error";
        } catch {
          // Reflection itself can throw for a proxy. Keep only the fixed marker.
        }
        try {
          let code = Object.getOwnPropertyDescriptor(error, "code");
          if (!code || ("value" in code && code.value === undefined)) {
            const cause = Object.getOwnPropertyDescriptor(error, "cause");
            // Node fetch failures carry the transport code on their first cause.
            // Do not walk arbitrary chains or invoke inherited/accessor fields.
            if (cause && !("value" in cause)) code = cause;
            else if (cause?.value && typeof cause.value === "object")
              code = Object.getOwnPropertyDescriptor(cause.value, "code");
          }
          if (!code || ("value" in code && code.value === undefined))
            transportCode = "none";
          else if ("value" in code)
            transportCode =
              typeof code.value === "string" &&
              CLOUD_TRANSPORT_CODES.has(code.value)
                ? code.value
                : "other";
        } catch {
          // "none" means no readable direct/first-cause code, not no network fault.
        }
      }
    }
  } catch {
    kind = "unreadable_error";
  }
  return {
    cloud_error_kind: kind,
    ...(typeErrorSignal === undefined
      ? {}
      : {
          cloud_type_error_signal: typeErrorSignal,
          cloud_transport_code: transportCode,
        }),
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
  privateArtifactWritePhase?: PrivateArtifactWritePhase,
): PersistenceError {
  let prepareStep: PrivateArtifactPrepareStep | undefined;
  if (ownerOnly && privateArtifactWritePhase === "prepare") {
    try {
      const stderr = Object.getOwnPropertyDescriptor(result, "stderr")?.value;
      const marker =
        typeof stderr === "string"
          ? stderr
              .slice(-1024)
              .match(/(?:^|\n)HA_PRIVATE_PREPARE:([a-z_]{1,40})\r?\n?$/)?.[1]
          : undefined;
      if (
        PRIVATE_ARTIFACT_PREPARE_STEPS.includes(
          marker as PrivateArtifactPrepareStep,
        )
      )
        prepareStep = marker as PrivateArtifactPrepareStep;
    } catch {
      /* Optional marker parsing cannot replace the original classification. */
    }
  }
  return new PersistenceError(
    message,
    ownerOnly && result.exitCode === 73
      ? "unsafe_artifact"
      : classifyPersistenceFailure(result.stderr),
    result.exitCode,
    privateArtifactWritePhase,
    prepareStep,
  );
}
