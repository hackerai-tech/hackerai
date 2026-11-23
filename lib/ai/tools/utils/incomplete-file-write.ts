/**
 * A native file write sent as several messages whose chunks were not all
 * confirmed. Earlier chunks may already be on disk, so the destination can be
 * truncated or partly written; the outcome is unknown, never "written".
 * Sending the remainder later would append to an unknown prefix, so recovery
 * is always a fresh, complete write.
 */
export class IncompleteFileWriteError extends Error {
  readonly writeOutcome = "unknown";

  constructor(
    readonly confirmedChunks: number,
    readonly totalChunks: number,
    readonly operation: "write" | "append",
    options?: { cause?: unknown },
  ) {
    const state =
      operation === "write"
        ? "The file may now be truncated or contain only part of the new content."
        : "The file may now contain only part of the appended content.";
    const cause = options?.cause;
    const reason =
      cause instanceof Error && cause.message
        ? ` Last error: ${cause.message}`
        : "";
    super(
      `File ${operation} did not complete: ${confirmedChunks} of ${totalChunks} chunks were confirmed before it stopped. ${state} Do not treat the file as written and do not append the missing part. Once the computer is connected, rewrite the whole file with one write action containing its complete intended content (read it first if you need its earlier content), then read it back to verify.${reason}`,
      options,
    );
    this.name = "IncompleteFileWriteError";
  }
}
