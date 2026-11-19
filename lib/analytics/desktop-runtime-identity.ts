/** Native Desktop runtime identity for every retained Desktop analytics event.
 * Only the native package version, the OS plugin's compiled platform and the
 * loaded frontend build: never the user agent, OS version, hostname or error
 * text. Cached in this page process only; never persisted or registered as a
 * super/person property. Browser and SSR events are left unchanged.
 */
import {
  NATIVE_AUTHORIZATION_DIAGNOSTIC_PROPERTIES,
  readNativeAuthorizationDiagnostic,
} from "./native-authorization-diagnostics";

type NativePlatform = "darwin" | "linux" | "windows";

export interface DesktopRuntimeIdentity {
  /** `plugin:app|version`; null while pending or when unavailable. */
  readonly native_app_version: string | null;
  /** The OS plugin's native-injected platform; null when unavailable. */
  readonly native_platform: NativePlatform | null;
  /** NEXT_PUBLIC_HACKERAI_BUILD_COMMIT of the loaded bundle; null when invalid. */
  readonly hackerai_frontend_build_commit: string | null;
}

const LOOKUP_TIMEOUT_MS = 500;
// Current plugin values come from Rust's std::env::consts::OS; older builds
// reported Node-style names.
const PLATFORMS = new Map<unknown, NativePlatform>([
  ["macos", "darwin"],
  ["darwin", "darwin"],
  ["linux", "linux"],
  ["windows", "windows"],
  ["win32", "windows"],
]);

let nativeAppVersion: string | null = null;
let lookup: Promise<void> | null = null;

/** Own data properties only: never run a getter defined by page script. */
function readOwnValue(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isDesktopRuntime(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      readOwnValue(window, "__TAURI_INTERNALS__") !== undefined
    );
  } catch {
    return false;
  }
}

function readNativePlatform(): NativePlatform | null {
  try {
    return (
      PLATFORMS.get(
        readOwnValue(
          readOwnValue(window, "__TAURI_OS_PLUGIN_INTERNALS__"),
          "platform",
        ),
      ) ?? null
    );
  } catch {
    return null;
  }
}

function readFrontendBuildCommit(): string | null {
  const commit = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
  return typeof commit === "string" && /^[a-f0-9]{40}$/i.test(commit)
    ? commit.toLowerCase()
    : null;
}

async function lookupNativeAppVersion() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const value = await invoke<unknown>("plugin:app|version");
    if (typeof value === "string" && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value))
      nativeAppVersion = value;
  } catch {
    // Unknown stays null; never record error text.
  }
}

/** Start the one local version lookup; settles within the bound, never rejects.
 * A valid late answer is still recorded; a failure is not retried.
 */
export function startDesktopRuntimeIdentityLookup(): Promise<void> {
  if (!isDesktopRuntime()) return Promise.resolve();
  if (!lookup) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    lookup = Promise.race([
      lookupNativeAppVersion(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, LOOKUP_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  }
  return lookup;
}

/** The current identity inside the native app, or null in a browser or SSR. */
export function getDesktopRuntimeIdentity(): DesktopRuntimeIdentity | null {
  if (!isDesktopRuntime()) return null;
  void startDesktopRuntimeIdentityLookup();
  return {
    native_app_version: nativeAppVersion,
    native_platform: readNativePlatform(),
    hackerai_frontend_build_commit: readFrontendBuildCommit(),
  };
}

/** Measured values replace any caller or SDK value. A complete v1 native send
 * receipt on a terminal-error ACK keeps its same-invocation version/platform.
 */
function withIdentity(
  identity: DesktopRuntimeIdentity,
  event: string | undefined,
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const receipt =
    event === "desktop_ack_command_settled" &&
    properties?.terminalType === "error"
      ? readNativeAuthorizationDiagnostic(properties)
      : null;
  // Do not turn an invalid receipt into a valid one by replacing its malformed
  // identity. The send group is atomic even across manual capture and SDK hooks.
  const retained = { ...properties };
  if (event === "desktop_ack_command_settled" && !receipt) {
    for (const key of NATIVE_AUTHORIZATION_DIAGNOSTIC_PROPERTIES) {
      delete retained[key];
    }
  }
  return {
    ...retained,
    ...identity,
    ...(receipt && {
      native_app_version:
        receipt.native_app_version ?? identity.native_app_version,
      native_platform: receipt.native_platform ?? identity.native_platform,
    }),
  };
}

/** Manual capture: a new property bag on Desktop; the same bag elsewhere. */
export function withDesktopRuntimeIdentity(
  event: string,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const identity = getDesktopRuntimeIdentity();
  if (!identity) return properties;
  try {
    return withIdentity(identity, event, properties);
  } catch {
    return properties;
  }
}

/** SDK before_send: applied last, after every privacy projection. */
export function applyDesktopRuntimeIdentity<
  T extends { event?: string; properties?: Record<string, unknown> },
>(event: T): T {
  const identity = getDesktopRuntimeIdentity();
  if (!identity) return event;
  try {
    event.properties = withIdentity(identity, event.event, event.properties);
  } catch {
    // An unreadable bag cannot be copied; the event is otherwise unchanged.
  }
  return event;
}
