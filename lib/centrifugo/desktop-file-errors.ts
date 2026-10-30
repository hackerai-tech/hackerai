/** Bounded adapter evidence; never put native error text or paths in telemetry. */
export type DesktopFileFailure =
  | "native_ipc_unavailable"
  | "native_ipc_denied"
  | "native_ipc_transport"
  | "legacy_http_transport"
  | "legacy_http_rejected"
  | "scoped_write_requires_native"
  | "invalid_response"
  | "filesystem"
  | "unknown";

export function parseDesktopFileFailure(
  value: unknown,
): DesktopFileFailure | undefined {
  switch (value) {
    case "native_ipc_unavailable":
    case "native_ipc_denied":
    case "native_ipc_transport":
    case "legacy_http_transport":
    case "legacy_http_rejected":
    case "scoped_write_requires_native":
    case "invalid_response":
    case "filesystem":
    case "unknown":
      return value;
    default:
      return undefined;
  }
}

export class DesktopFileBridgeError extends Error {
  constructor(
    readonly fileFailure: DesktopFileFailure,
    message: string,
  ) {
    super(message);
    this.name = "DesktopFileBridgeError";
  }
}

export function getDesktopFileFailure(error: unknown): DesktopFileFailure {
  if (error instanceof DesktopFileBridgeError) return error.fileFailure;
  const message = error instanceof Error ? error.message : String(error);
  // Compatibility with the exact bounded message sent by already deployed web
  // bundles. An arbitrary native error remains unknown, not a filesystem claim.
  if (message.startsWith("Desktop file bridge transport failed (legacy_http,"))
    return "legacy_http_transport";
  if (message.startsWith("Desktop file bridge transport failed (native_ipc,"))
    return "native_ipc_transport";
  if (
    /^(Metadata|Open|Read|Write|Flush|Mkdir|Remove|Read dir) error:/.test(
      message,
    )
  )
    return "filesystem";
  return "unknown";
}

export function desktopFileUnavailableMessage(
  failure: DesktopFileFailure,
): string {
  if (
    failure === "legacy_http_transport" ||
    failure === "native_ipc_unavailable"
  )
    return "Desktop file access is unavailable: the native file API is unavailable and the legacy file bridge cannot be reached. Update HackerAI Desktop, fully quit and reopen it, then reconnect this computer before retrying. No command was started on this computer.";
  if (failure === "native_ipc_denied")
    return "Desktop file access was denied by the app's native permissions. Update HackerAI Desktop and fully reopen it from its normal app window, then reconnect this computer. No command was started on this computer.";
  return "Desktop file access could not be verified. Reconnect this computer and retry after the Desktop app is ready. If it persists, update and fully reopen HackerAI Desktop. No command was started on this computer.";
}
