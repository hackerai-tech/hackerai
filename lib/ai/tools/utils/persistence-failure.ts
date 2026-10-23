export type PersistenceFailureCategory =
  | "timeout"
  | "transport"
  | "relay_unavailable"
  | "permission"
  | "filesystem"
  | "unknown"
  | "unsupported_client"
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

export const classifyPersistenceFailure = (
  error: unknown,
): PersistenceFailureCategory => {
  if (error instanceof PersistenceError) return error.persistenceCategory;
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
