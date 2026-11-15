import type { NativePathReceiverMode } from "./local-sandbox-errors";
import {
  classifyPersistenceFailure,
  type PersistenceFailureCategory,
} from "./persistence-failure";

const STDERR_SCAN_LIMIT = 16_384;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export type LocalCopyPathShape =
  | "posix_absolute"
  | "windows_drive_absolute"
  | "unc"
  | "relative"
  | "empty"
  | "invalid_control";

/** Selected interpreter and receiver mode are not the native host OS. */
export type LocalCopyFailureContext = {
  local_copy_diagnostic_version: 1;
  local_copy_selected_shell: "bash" | "cmd";
  local_copy_receiver_mode?: NativePathReceiverMode;
  local_copy_source_path_shape: LocalCopyPathShape;
  local_copy_destination_path_shape: LocalCopyPathShape;
  local_copy_command_failure_category: PersistenceFailureCategory;
  // A truncated scan cannot prove the stderr category is complete.
  local_copy_stderr_scan_truncated: boolean;
  local_copy_receipt_available: boolean;
  local_copy_command_id?: string;
  local_copy_acknowledged_output?: boolean;
  local_copy_terminal_ack_published?: boolean;
};

type LocalCopyFailureInput = {
  shell: "bash" | "cmd";
  receiverMode: () => NativePathReceiverMode;
  sourcePath: string;
  destinationPath: string;
  stderr: string;
  receipt?: {
    commandId: string;
    acknowledgedOutput: boolean;
    terminalAckPublished: boolean;
  };
};

const contexts = new WeakMap<object, LocalCopyFailureContext>();

/** Shape of the path placed in the command, never its text or length. */
function pathShape(path: string): LocalCopyPathShape {
  if (path.length === 0) return "empty";
  if (/[\u0000-\u001f\u007f]/.test(path)) return "invalid_control";
  if (/^[\\/]{2}/.test(path)) return "unc";
  if (path.startsWith("/")) return "posix_absolute";
  if (/^[A-Za-z]:[\\/]/.test(path)) return "windows_drive_absolute";
  return "relative";
}

/** Record a returned nonzero copy result; always returns the original error. */
export function recordLocalCopyFailure<T extends object>(
  error: T,
  input: LocalCopyFailureInput,
): T {
  try {
    let receiverMode: NativePathReceiverMode | undefined;
    try {
      const mode = input.receiverMode();
      if (/^(desktop|local|unknown)_(isolated|shared)$/.test(mode))
        receiverMode = mode;
    } catch {
      /* Optional mode context cannot drop the other observations. */
    }
    const receipt = input.receipt;
    contexts.set(error, {
      local_copy_diagnostic_version: 1,
      local_copy_selected_shell: input.shell,
      ...(receiverMode && { local_copy_receiver_mode: receiverMode }),
      local_copy_source_path_shape: pathShape(input.sourcePath),
      local_copy_destination_path_shape: pathShape(input.destinationPath),
      local_copy_command_failure_category: classifyPersistenceFailure(
        input.stderr.slice(0, STDERR_SCAN_LIMIT),
      ),
      local_copy_stderr_scan_truncated: input.stderr.length > STDERR_SCAN_LIMIT,
      local_copy_receipt_available: receipt !== undefined,
      ...(receipt &&
        UUID.test(receipt.commandId) && {
          local_copy_command_id: receipt.commandId,
        }),
      ...(typeof receipt?.acknowledgedOutput === "boolean" && {
        local_copy_acknowledged_output: receipt.acknowledgedOutput,
      }),
      ...(typeof receipt?.terminalAckPublished === "boolean" && {
        local_copy_terminal_ack_published: receipt.terminalAckPublished,
      }),
    });
  } catch {
    // Optional diagnostics must preserve the original failure.
  }
  return error;
}

export function getLocalCopyFailureContext(
  error: unknown,
): LocalCopyFailureContext | undefined {
  if (
    (typeof error !== "object" || error === null) &&
    typeof error !== "function"
  )
    return;
  const context = contexts.get(error);
  return context && { ...context };
}

/** Carry the final attempt's context to an error that wraps it. */
export function copyLocalCopyFailureContext<T extends object>(
  from: unknown,
  to: T,
): T {
  const context = getLocalCopyFailureContext(from);
  if (context) contexts.set(to, context);
  return to;
}
