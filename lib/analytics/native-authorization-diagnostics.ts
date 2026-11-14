/** Native authorization POST send-failure receipt, joined to one ACK final.
 * Only reqwest's public predicates, bounded time, a fixed origin class and the
 * native binary's compiled platform: never error text, URLs, identifiers,
 * commands or output. A missing receipt means unknown (for example an older
 * native app), not a successful send.
 *
 * A newer native app also sends a separate cause receipt on its own channel:
 * the closed kind of the first IO error in a bounded walk of the send error's
 * sources. It is a transport class, not the customer's physical network cause,
 * and it is only reported together with a valid v1 receipt.
 */

const ORIGIN_CLASSES = [
  "canonical_production",
  "localhost",
  "other_allowed",
  "unknown",
] as const;
const NATIVE_PLATFORMS = ["darwin", "linux", "windows"] as const;
const RECEIPT_PLATFORMS = [...NATIVE_PLATFORMS, "unknown"] as const;
const MAX_ELAPSED_MS = 60_000;
const RECEIPT_KEYS = [
  "version",
  "timeout",
  "connect",
  "request",
  "elapsedMs",
  "originClass",
  "platform",
] as const;

const IO_KINDS = [
  "connection_reset",
  "connection_aborted",
  "broken_pipe",
  "unexpected_eof",
  "timed_out",
  "not_connected",
  "permission_denied",
  "invalid_data",
  "invalid_input",
  "other",
  "not_exposed",
] as const;
const MAX_SOURCE_DEPTH = 8;
const CAUSE_KEYS = [
  "version",
  "ioKind",
  "sourceDepth",
  "sourceChainTruncated",
] as const;

type OriginClass = (typeof ORIGIN_CLASSES)[number];
type NativePlatform = (typeof NATIVE_PLATFORMS)[number];
type IoKind = (typeof IO_KINDS)[number];

export interface NativeAuthorizationSendReceipt {
  readonly timeout: boolean;
  readonly connect: boolean;
  readonly request: boolean;
  readonly elapsedMs: number;
  readonly originClass: OriginClass;
  readonly platform: (typeof RECEIPT_PLATFORMS)[number];
}

export interface NativeAuthorizationDiagnostic {
  readonly native_authorization_diagnostic_version: 1;
  readonly native_authorization_send_timeout: boolean;
  readonly native_authorization_send_connect: boolean;
  readonly native_authorization_send_request: boolean;
  readonly native_authorization_send_elapsed_ms: number;
  readonly native_authorization_origin_class: OriginClass;
  /** Cached `plugin:app|version`; null when unknown. */
  readonly native_app_version: string | null;
  /** The receipt's compiled target platform; null when unknown. */
  readonly native_platform: NativePlatform | null;
}

export const NATIVE_AUTHORIZATION_DIAGNOSTIC_PROPERTIES: ReadonlySet<string> =
  new Set<keyof NativeAuthorizationDiagnostic>([
    "native_authorization_diagnostic_version",
    "native_authorization_send_timeout",
    "native_authorization_send_connect",
    "native_authorization_send_request",
    "native_authorization_send_elapsed_ms",
    "native_authorization_origin_class",
    "native_app_version",
    "native_platform",
  ]);

export interface NativeAuthorizationSendCause {
  readonly ioKind: IoKind;
  readonly sourceDepth: number;
  readonly sourceChainTruncated: boolean;
}

export interface NativeAuthorizationCauseDiagnostic {
  readonly native_authorization_cause_version: 1;
  readonly native_authorization_cause_io_kind: IoKind;
  readonly native_authorization_cause_source_depth: number;
  readonly native_authorization_cause_source_chain_truncated: boolean;
}

const CAUSE_PROPERTIES = [
  "native_authorization_cause_version",
  "native_authorization_cause_io_kind",
  "native_authorization_cause_source_depth",
  "native_authorization_cause_source_chain_truncated",
] as const satisfies readonly (keyof NativeAuthorizationCauseDiagnostic)[];

export const NATIVE_AUTHORIZATION_CAUSE_PROPERTIES: ReadonlySet<string> =
  new Set(CAUSE_PROPERTIES);

/** The native walk's invariants: an exposed IO error ends the walk at depth
 * 1..8; only an unexposed walk of all 8 links can be truncated. */
const isCause = (
  ioKind: unknown,
  sourceDepth: unknown,
  sourceChainTruncated: unknown,
): boolean =>
  IO_KINDS.some((kind) => kind === ioKind) &&
  typeof sourceDepth === "number" &&
  Number.isSafeInteger(sourceDepth) &&
  sourceDepth >= 0 &&
  sourceDepth <= MAX_SOURCE_DEPTH &&
  typeof sourceChainTruncated === "boolean" &&
  (ioKind === "not_exposed"
    ? !sourceChainTruncated || sourceDepth === MAX_SOURCE_DEPTH
    : sourceDepth >= 1 && !sourceChainTruncated);

const isElapsed = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= MAX_ELAPSED_MS;
const isOriginClass = (value: unknown): value is OriginClass =>
  ORIGIN_CLASSES.some((origin) => origin === value);
const isNativeAppVersion = (value: unknown): value is string =>
  typeof value === "string" && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value);
const isNativePlatform = (value: unknown): value is NativePlatform =>
  NATIVE_PLATFORMS.some((platform) => platform === value);
const isReceiptPlatform = (
  value: unknown,
): value is (typeof RECEIPT_PLATFORMS)[number] =>
  RECEIPT_PLATFORMS.some((platform) => platform === value);

/** The values of exactly `keys` as plain data properties, or null. */
function readClosedObject(
  value: unknown,
  keys: readonly string[],
): unknown[] | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return null;
  const own = Object.getOwnPropertyNames(value);
  if (
    own.length !== keys.length ||
    Object.getOwnPropertySymbols(value).length > 0 ||
    !keys.every((key) => own.includes(key))
  )
    return null;
  return readDataProperties(value, keys);
}

/** Data properties only: never run a getter from untrusted input. */
function readDataProperties(source: object, keys: readonly string[]) {
  return keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  });
}

/** Copy only the closed native schema; anything else is dropped. */
export function parseNativeAuthorizationSendReceipt(
  value: unknown,
): NativeAuthorizationSendReceipt | null {
  try {
    const values = readClosedObject(value, RECEIPT_KEYS);
    if (!values) return null;
    const [
      version,
      timeout,
      connect,
      request,
      elapsedMs,
      originClass,
      platform,
    ] = values;
    if (
      version !== 1 ||
      typeof timeout !== "boolean" ||
      typeof connect !== "boolean" ||
      typeof request !== "boolean" ||
      !isElapsed(elapsedMs) ||
      !isOriginClass(originClass) ||
      !isReceiptPlatform(platform)
    )
      return null;
    return Object.freeze({
      timeout,
      connect,
      request,
      elapsedMs,
      originClass,
      platform,
    });
  } catch {
    return null;
  }
}

export function nativeAuthorizationDiagnostic(
  receipt: NativeAuthorizationSendReceipt,
  nativeAppVersion: string,
): NativeAuthorizationDiagnostic {
  return Object.freeze({
    native_authorization_diagnostic_version: 1,
    native_authorization_send_timeout: receipt.timeout,
    native_authorization_send_connect: receipt.connect,
    native_authorization_send_request: receipt.request,
    native_authorization_send_elapsed_ms: receipt.elapsedMs,
    native_authorization_origin_class: receipt.originClass,
    native_app_version: isNativeAppVersion(nativeAppVersion)
      ? nativeAppVersion
      : null,
    native_platform: isNativePlatform(receipt.platform)
      ? receipt.platform
      : null,
  });
}

/** Read the complete v1 group from any property bag, or nothing at all. */
export function readNativeAuthorizationDiagnostic(
  source: unknown,
): NativeAuthorizationDiagnostic | null {
  if (typeof source !== "object" || source === null) return null;
  const properties = source as Record<string, unknown>;
  let group;
  try {
    group = {
      native_authorization_diagnostic_version:
        properties.native_authorization_diagnostic_version,
      native_authorization_send_timeout:
        properties.native_authorization_send_timeout,
      native_authorization_send_connect:
        properties.native_authorization_send_connect,
      native_authorization_send_request:
        properties.native_authorization_send_request,
      native_authorization_send_elapsed_ms:
        properties.native_authorization_send_elapsed_ms,
      native_authorization_origin_class:
        properties.native_authorization_origin_class,
      native_app_version: properties.native_app_version,
      native_platform: properties.native_platform,
    };
  } catch {
    return null;
  }
  return group.native_authorization_diagnostic_version === 1 &&
    typeof group.native_authorization_send_timeout === "boolean" &&
    typeof group.native_authorization_send_connect === "boolean" &&
    typeof group.native_authorization_send_request === "boolean" &&
    isElapsed(group.native_authorization_send_elapsed_ms) &&
    isOriginClass(group.native_authorization_origin_class) &&
    (group.native_app_version === null ||
      isNativeAppVersion(group.native_app_version)) &&
    (group.native_platform === null || isNativePlatform(group.native_platform))
    ? (Object.freeze(group) as NativeAuthorizationDiagnostic)
    : null;
}

/** Copy only the closed native cause schema; anything else is dropped. */
export function parseNativeAuthorizationSendCause(
  value: unknown,
): NativeAuthorizationSendCause | null {
  try {
    const values = readClosedObject(value, CAUSE_KEYS);
    if (!values) return null;
    const [version, ioKind, sourceDepth, sourceChainTruncated] = values;
    if (version !== 1 || !isCause(ioKind, sourceDepth, sourceChainTruncated))
      return null;
    return Object.freeze({
      ioKind,
      sourceDepth,
      sourceChainTruncated,
    } as NativeAuthorizationSendCause);
  } catch {
    return null;
  }
}

export function nativeAuthorizationCauseDiagnostic(
  cause: NativeAuthorizationSendCause,
): NativeAuthorizationCauseDiagnostic {
  return Object.freeze({
    native_authorization_cause_version: 1,
    native_authorization_cause_io_kind: cause.ioKind,
    native_authorization_cause_source_depth: cause.sourceDepth,
    native_authorization_cause_source_chain_truncated:
      cause.sourceChainTruncated,
  });
}

/** Read the complete cause group from any property bag's own data properties,
 * or nothing at all. Callers join it only to a valid v1 group. */
export function readNativeAuthorizationCause(
  source: unknown,
): NativeAuthorizationCauseDiagnostic | null {
  if (typeof source !== "object" || source === null) return null;
  try {
    const [version, ioKind, sourceDepth, sourceChainTruncated] =
      readDataProperties(source, CAUSE_PROPERTIES);
    return version === 1 && isCause(ioKind, sourceDepth, sourceChainTruncated)
      ? nativeAuthorizationCauseDiagnostic({
          ioKind,
          sourceDepth,
          sourceChainTruncated,
        } as NativeAuthorizationSendCause)
      : null;
  } catch {
    return null;
  }
}
