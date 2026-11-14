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

/** Boundary the Desktop receiver attempted last, not proof a handler ran. */
export type DesktopFileReceiverStage =
  | "module_load"
  | "native_invoke"
  | "loopback_info"
  | "loopback_setup"
  | "loopback_request"
  | "loopback_response"
  | "stat_reply_validation"
  | "reply_publication";

/** Adapter the Desktop receiver actually selected for this invocation. */
export type DesktopFileReceiverAdapter =
  | "published_legacy_native"
  | "authorized_native"
  | "compatibility_native"
  | "legacy_loopback";

/**
 * How this bridge's own 500ms native version lookup settled, never the raw
 * version. Analytics enrichment can report a different device version.
 */
export type DesktopNativeVersionLookup =
  | "resolved_published_legacy"
  | "resolved_other"
  | "timeout"
  | "rejected"
  | "invalid"
  | "unobserved";

export interface DesktopFileReceiverDiagnostic {
  version: 1;
  stage: DesktopFileReceiverStage;
  adapter: DesktopFileReceiverAdapter;
  /** Optional within version 1; older readers drop it, older senders omit it. */
  nativeVersionLookup?: DesktopNativeVersionLookup;
}

const NATIVE_VERSION_LOOKUPS: ReadonlySet<unknown> =
  new Set<DesktopNativeVersionLookup>([
    "resolved_published_legacy",
    "resolved_other",
    "timeout",
    "rejected",
    "invalid",
    "unobserved",
  ]);

const RECEIVER_ADAPTERS: ReadonlySet<unknown> =
  new Set<DesktopFileReceiverAdapter>([
    "published_legacy_native",
    "authorized_native",
    "compatibility_native",
    "legacy_loopback",
  ]);

// Stages limited to the adapters that can reach them; other stages apply to all.
const RECEIVER_STAGE_ADAPTERS: ReadonlyMap<
  unknown,
  ReadonlySet<DesktopFileReceiverAdapter> | null
> = new Map<
  DesktopFileReceiverStage,
  ReadonlySet<DesktopFileReceiverAdapter> | null
>([
  ["module_load", null],
  [
    "native_invoke",
    new Set([
      "published_legacy_native",
      "authorized_native",
      "compatibility_native",
    ]),
  ],
  ["loopback_info", new Set(["legacy_loopback"])],
  ["loopback_setup", new Set(["legacy_loopback"])],
  ["loopback_request", new Set(["legacy_loopback"])],
  ["loopback_response", new Set(["legacy_loopback"])],
  ["stat_reply_validation", null],
  ["reply_publication", null],
]);

function ownDataValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * Read a file_error's optional receiver diagnostic as a fresh closed copy.
 * Accessors, inherited or unknown values and inconsistent groups are ignored,
 * and reading can never throw into the original failure. An unusable optional
 * version lookup is omitted without discarding a valid stage and adapter.
 */
export function readDesktopFileReceiverDiagnostic(
  fileError: unknown,
): DesktopFileReceiverDiagnostic | undefined {
  try {
    const diagnostic = ownDataValue(fileError, "receiverDiagnostic");
    if (ownDataValue(diagnostic, "version") !== 1) return undefined;
    const stage = ownDataValue(diagnostic, "stage");
    const adapter = ownDataValue(diagnostic, "adapter");
    if (!RECEIVER_STAGE_ADAPTERS.has(stage) || !RECEIVER_ADAPTERS.has(adapter))
      return undefined;
    const allowed = RECEIVER_STAGE_ADAPTERS.get(stage);
    if (allowed && !allowed.has(adapter as DesktopFileReceiverAdapter))
      return undefined;
    const nativeVersionLookup = ownDataValue(diagnostic, "nativeVersionLookup");
    return {
      version: 1,
      stage: stage as DesktopFileReceiverStage,
      adapter: adapter as DesktopFileReceiverAdapter,
      ...(NATIVE_VERSION_LOOKUPS.has(nativeVersionLookup) && {
        nativeVersionLookup: nativeVersionLookup as DesktopNativeVersionLookup,
      }),
    };
  } catch {
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
