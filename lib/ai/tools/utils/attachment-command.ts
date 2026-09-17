import type { AnySandbox } from "@/types";
import { isE2BSandbox } from "./sandbox-types";

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
  options?: { displayName?: string; timeoutMs?: number },
) {
  signal?.throwIfAborted();
  if (!signal)
    return options
      ? sandbox.commands.run(command, options)
      : sandbox.commands.run(command);
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
  const handle = await sandbox.commands.run(command, {
    background: true,
    requestTimeoutMs: 10_000,
  });
  let cancellation: Promise<void> | undefined;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      cancellation ??= sandbox.commands
        .kill(handle.pid, { requestTimeoutMs: 5_000 })
        .then(
          () => undefined,
          (error) => {
            throw new AttachmentCommandCleanupError(error);
          },
        );
      void cancellation.then(
        () => reject(signal.reason),
        (error) => reject(error),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });

  try {
    return await Promise.race([handle.wait(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      // A killed process can settle wait() before the kill acknowledgement.
      await cancellation;
    } finally {
      await handle.disconnect();
    }
  }
}
