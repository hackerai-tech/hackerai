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
  const blocked =
    " This step cannot use the selected computer until file access is restored. It was not moved to Cloud or another computer.";
  if (
    failure === "legacy_http_transport" ||
    failure === "native_ipc_unavailable"
  )
    return (
      "Desktop cannot save command output on the selected computer because its file bridge is unavailable. Update HackerAI Desktop from hackerai.co/download on that computer, fully quit and reopen it, then retry once it is connected." +
      blocked
    );
  if (failure === "native_ipc_denied")
    return (
      "The Desktop app rejected file access on the selected computer. Fully quit and reopen HackerAI Desktop; if it persists, install the latest version from hackerai.co/download. Changing project access settings does not grant the app's native file permission." +
      blocked
    );
  if (failure === "filesystem")
    return (
      "Desktop could not access the selected project folder. Check that the folder still exists and is accessible to the app, then reconnect the selected computer and retry." +
      blocked
    );
  return (
    "Desktop file access could not be verified. Reconnect the selected computer and retry after the app is ready. If it persists, update HackerAI Desktop from hackerai.co/download and fully reopen it." +
    blocked
  );
}
