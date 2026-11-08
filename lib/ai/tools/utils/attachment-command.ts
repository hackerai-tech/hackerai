import type { AnySandbox } from "@/types";
import { isE2BSandbox } from "./sandbox-types";

export type AttachmentCommandFailureContext = {
  attachment_command_diagnostic_version: 1;
  attachment_command_stage:
    "foreground" | "start" | "wait" | "cancel" | "disconnect";
  // Foreground calls do not expose a handle to this adapter.
  attachment_command_handle_acquired: boolean;
  attachment_command_error_kind:
    "timeout" | "abort" | "command_exit" | "rpc" | "other";
};

const commandFailures = new WeakMap<object, AttachmentCommandFailureContext>();

/** Keep SDK boundary evidence without changing or serializing its rejection. */
function recordCommandFailure(
  error: unknown,
  stage: AttachmentCommandFailureContext["attachment_command_stage"],
  handleAcquired: boolean,
) {
  if (
    (typeof error !== "object" || error === null) &&
    typeof error !== "function"
  )
    return;
  let kind: AttachmentCommandFailureContext["attachment_command_error_kind"] =
    "other";
  try {
    // Never invoke an error's optional getter or copy its private name/message.
    const name = Object.getOwnPropertyDescriptor(error, "name")?.value;
    if (name === "TimeoutError") kind = "timeout";
    else if (name === "AbortError") kind = "abort";
    else if (name === "CommandExitError") kind = "command_exit";
    else if (name === "ConnectError") kind = "rpc";
  } catch {
    /* Optional diagnostics cannot replace the original error. */
  }
  commandFailures.set(error, {
    attachment_command_diagnostic_version: 1,
    attachment_command_stage: stage,
    attachment_command_handle_acquired: handleAcquired,
    attachment_command_error_kind: kind,
  });
}

/** Read only the finite evidence recorded at this adapter's failure boundary. */
export function getAttachmentCommandFailureContext(
  error: unknown,
): AttachmentCommandFailureContext | undefined {
  if (
    (typeof error !== "object" || error === null) &&
    typeof error !== "function"
  )
    return;
  const context = commandFailures.get(error);
  return context && { ...context };
}

/** Carry recorded fields to an adapter-created result or error, returning it. */
export function copyAttachmentCommandFailureContext<T extends object>(
  from: unknown,
  to: T,
): T {
  const context = getAttachmentCommandFailureContext(from);
  if (context) commandFailures.set(to, context);
  return to;
}

export class AttachmentCommandCleanupError extends Error {
  constructor(cause: unknown) {
    super("Attachment command cancellation could not be confirmed", { cause });
    this.name = "AttachmentCommandCleanupError";
  }
}

export function throwIfAttachmentAborted(
  signal?: AbortSignal,
  error?: unknown,
) {
  if (error instanceof AttachmentCommandCleanupError) throw error;
  signal?.throwIfAborted();
}

/** Run only this attachment's command; cancellation must not kill a shared sandbox. */
export async function runAttachmentCommand(
  sandbox: AnySandbox,
  command: string,
  signal?: AbortSignal,
  options?: {
    displayName?: string;
    timeoutMs?: number;
    requestTimeoutMs?: number;
  },
) {
  signal?.throwIfAborted();
  if (!signal) {
    try {
      return await (options
        ? sandbox.commands.run(command, options)
        : sandbox.commands.run(command));
    } catch (error) {
      try {
        if (isE2BSandbox(sandbox))
          recordCommandFailure(error, "foreground", false);
      } catch {
        /* Preserve rejection even if optional sandbox detection fails. */
      }
      throw error;
    }
  }
  if (!isE2BSandbox(sandbox)) {
    try {
      return await sandbox.commands.run(command, { ...options, signal });
    } catch (error) {
      if (
        signal.aborted &&
        error !== signal.reason &&
        !(error instanceof Error && error.name === "AbortError")
      ) {
        throw new AttachmentCommandCleanupError(error);
      }
      throw error;
    }
  }

  // Keep the start request alive until it yields a PID, even if Stop arrives
  // meanwhile. Aborting that request would lose the handle needed for cleanup.
  let handle;
  try {
    handle = await sandbox.commands.run(command, {
      ...options,
      background: true,
      requestTimeoutMs: options?.requestTimeoutMs ?? 10_000,
    });
  } catch (error) {
    recordCommandFailure(error, "start", false);
    throw error;
  }
  let cancellation: Promise<void> | undefined;
  // One acknowledgement for this handle, shared by Stop and failed-wait cleanup.
  const cancelCommand = () => {
    if (
      !cancellation &&
      (!Number.isSafeInteger(handle.pid) || handle.pid <= 0)
    ) {
      cancellation = Promise.reject(
        new AttachmentCommandCleanupError(
          new Error("Invalid attachment command process receipt"),
        ),
      );
    }
    cancellation ??= sandbox.commands
      .kill(handle.pid, { requestTimeoutMs: 5_000 })
      .then(
        (killed) => {
          // false is the SDK's authoritative "process not found" receipt.
          if (typeof killed !== "boolean") {
            throw new AttachmentCommandCleanupError(
              new Error("Invalid attachment command cancellation receipt"),
            );
          }
        },
        (error) => {
          throw new AttachmentCommandCleanupError(error);
        },
      );
    return cancellation;
  };
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      void cancelCommand().then(
        () => reject(signal.reason),
        (error) => reject(error),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });

  try {
    return await Promise.race([handle.wait(), aborted]);
  } catch (error) {
    recordCommandFailure(error, cancellation ? "cancel" : "wait", true);
    // An SDK stream timeout does not prove process exit. Disconnect alone
    // leaves it running, so do not allow a retry until its cleanup is known.
    if (!cancellation && handle.exitCode === undefined) await cancelCommand();
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    let cancellationFailed = false;
    try {
      // A killed process can settle wait() before the kill acknowledgement.
      await cancellation;
    } catch (error) {
      cancellationFailed = true;
      recordCommandFailure(error, "cancel", true);
      throw error;
    } finally {
      try {
        await handle.disconnect();
      } catch (error) {
        recordCommandFailure(error, "disconnect", true);
        // A transport disconnect must not make unconfirmed cleanup retryable.
        if (!cancellationFailed) throw error;
      }
    }
  }
}
