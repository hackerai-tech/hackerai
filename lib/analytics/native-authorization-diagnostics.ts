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
 *
 * A newer native app also sends a separate transport detail on its own
 * channel: the same first IO error's kind without the cause's `other` fold
 * (`other` is only the IO kind Other itself; `unmapped` is every remaining
 * kind), and whether a typed native TLS error appeared in the bounded walk.
 * That presence is not a certificate reason or the failure's origin. It is
 * likewise only reported together with a valid v1 receipt.
 *
 * When that detail is `unmapped`, a newer native app also sends a separate IO
 * supplement on its own channel: the same first IO error's remaining stable
 * kind, a closed family of its own stored OS code (Windows name-resolution
 * Winsock codes are named only on Windows; never the code itself) and its
 * depth. A family is the code the OS reported, not proof of the physical
 * cause. It is only reported together with valid v1, cause and unmapped
 * transport receipts for the same IO error.
 *
 * A newer native app also sends a separate connector snapshot on its own
 * channel, taken when the send failed: whether reqwest's connector was never
 * called, still pending, had returned a connection or an error, or was called
 * more than once (no single phase is claimed), with the single call's bounded
 * monotonic time. `connected` is only the connector's own result, never a
 * written or delivered request, and DNS, TCP and TLS are not distinguished. It
 * is likewise only reported together with a valid v1 receipt.
 *
 * A response receipt is independent of both: the native approval check
 * rejected an answered POST. It holds the HTTP status, a closed approval
 * class, the origin class, the compiled platform and the shape of the
 * response's public `x-vercel-id`. That ID is copied only within a strict
 * observed subset; this is not a guarantee of Vercel's format.
 *
 * A newer native app also sends a separate mitigation receipt on its own
 * channel: a closed class of the same response's `x-vercel-mitigated` header,
 * matched against exact literals and never copied. It is an observed marker,
 * not an authenticated provider decision, and it is only reported together
 * with a valid response receipt.
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

const IO_KIND_DETAILS = [
  "connection_refused",
  "connection_reset",
  "connection_aborted",
  "host_unreachable",
  "network_unreachable",
  "network_down",
  "addr_in_use",
  "addr_not_available",
  "broken_pipe",
  "unexpected_eof",
  "timed_out",
  "not_connected",
  "permission_denied",
  "invalid_data",
  "invalid_input",
  "would_block",
  "interrupted",
  "unsupported",
  "out_of_memory",
  "other",
  "unmapped",
  "not_exposed",
] as const;
const TRANSPORT_KEYS = [
  "version",
  "ioKindDetail",
  "nativeTlsSource",
  "sourceDepth",
  "sourceChainTruncated",
] as const;

const UNMAPPED_IO_KINDS = [
  "not_found",
  "already_exists",
  "write_zero",
  "not_a_directory",
  "is_a_directory",
  "directory_not_empty",
  "read_only_filesystem",
  "stale_network_file_handle",
  "storage_full",
  "not_seekable",
  "quota_exceeded",
  "file_too_large",
  "resource_busy",
  "executable_file_busy",
  "deadlock",
  "crosses_devices",
  "too_many_links",
  "invalid_filename",
  "argument_list_too_long",
  "unknown",
] as const;
const OS_FAMILIES = [
  "winsock_host_not_found",
  "winsock_try_again",
  "winsock_no_recovery",
  "winsock_no_data",
  "other_windows_os_code",
  "no_raw_os_code",
  "not_windows",
] as const;
const IO_KEYS = ["version", "ioKind", "osFamily", "sourceDepth"] as const;

const CONNECTOR_PHASES = [
  "not_started",
  "pending",
  "connected",
  "failed",
  "multiple",
] as const;
const MAX_CONNECTOR_ATTEMPTS = 8;
const CONNECTOR_KEYS = ["version", "phase", "attempts", "elapsedMs"] as const;

/** `json_error` covers both an unreadable body and an undecodable one. */
const APPROVALS = [
  "not_checked",
  "json_error",
  "approved_false",
  "missing",
  "invalid_type",
] as const;
const REQUEST_ID_SHAPES = [
  "absent",
  "valid",
  "unrecognized",
  "unreadable",
] as const;
const MAX_REQUEST_ID_LENGTH = 96;
// The native subset: 1-3 region prefixes, then an ID and a 13-digit time.
const REQUEST_ID =
  /^(?:[a-z]{3}[1-9]::){1,3}[a-z0-9]{5}-[0-9]{13}-[0-9a-f]{12}$/;
const RESPONSE_KEYS = [
  "version",
  "httpStatus",
  "approval",
  "originClass",
  "platform",
  "requestIdShape",
  "requestId",
] as const;

const MITIGATIONS = [
  "absent",
  "challenge",
  "deny",
  "rate_limit",
  "other",
  "unreadable",
] as const;
const MITIGATION_KEYS = ["version", "mitigation"] as const;

type OriginClass = (typeof ORIGIN_CLASSES)[number];
type NativePlatform = (typeof NATIVE_PLATFORMS)[number];
type IoKind = (typeof IO_KINDS)[number];
type IoKindDetail = (typeof IO_KIND_DETAILS)[number];
type UnmappedIoKind = (typeof UNMAPPED_IO_KINDS)[number];
type OsFamily = (typeof OS_FAMILIES)[number];
type ConnectorPhase = (typeof CONNECTOR_PHASES)[number];
type Approval = (typeof APPROVALS)[number];
type RequestIdShape = (typeof REQUEST_ID_SHAPES)[number];
type Mitigation = (typeof MITIGATIONS)[number];

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

export interface NativeAuthorizationSendTransport {
  readonly ioKindDetail: IoKindDetail;
  readonly nativeTlsSource: boolean;
  readonly sourceDepth: number;
  readonly sourceChainTruncated: boolean;
}

export interface NativeAuthorizationTransportDiagnostic {
  readonly native_authorization_transport_version: 1;
  readonly native_authorization_transport_io_kind_detail: IoKindDetail;
  /** A typed native TLS error was observed; not a certificate reason. */
  readonly native_authorization_transport_native_tls_source: boolean;
  readonly native_authorization_transport_source_depth: number;
  readonly native_authorization_transport_source_chain_truncated: boolean;
}

const TRANSPORT_PROPERTIES = [
  "native_authorization_transport_version",
  "native_authorization_transport_io_kind_detail",
  "native_authorization_transport_native_tls_source",
  "native_authorization_transport_source_depth",
  "native_authorization_transport_source_chain_truncated",
] as const satisfies readonly (keyof NativeAuthorizationTransportDiagnostic)[];

export const NATIVE_AUTHORIZATION_TRANSPORT_PROPERTIES: ReadonlySet<string> =
  new Set(TRANSPORT_PROPERTIES);

/** The native walk's invariants: it observes every link up to 8, so only a
 * walk of all 8 can be truncated, and any finding needs an observed link. */
const isTransport = (
  ioKindDetail: unknown,
  nativeTlsSource: unknown,
  sourceDepth: unknown,
  sourceChainTruncated: unknown,
): boolean =>
  IO_KIND_DETAILS.some((kind) => kind === ioKindDetail) &&
  typeof nativeTlsSource === "boolean" &&
  typeof sourceDepth === "number" &&
  Number.isSafeInteger(sourceDepth) &&
  sourceDepth >= 0 &&
  sourceDepth <= MAX_SOURCE_DEPTH &&
  typeof sourceChainTruncated === "boolean" &&
  (!sourceChainTruncated || sourceDepth === MAX_SOURCE_DEPTH) &&
  ((ioKindDetail === "not_exposed" && !nativeTlsSource) || sourceDepth >= 1);

/** Copy only the closed native transport schema; anything else is dropped. */
export function parseNativeAuthorizationSendTransport(
  value: unknown,
): NativeAuthorizationSendTransport | null {
  try {
    const values = readClosedObject(value, TRANSPORT_KEYS);
    if (!values) return null;
    const [
      version,
      ioKindDetail,
      nativeTlsSource,
      sourceDepth,
      sourceChainTruncated,
    ] = values;
    if (
      version !== 1 ||
      !isTransport(
        ioKindDetail,
        nativeTlsSource,
        sourceDepth,
        sourceChainTruncated,
      )
    )
      return null;
    return Object.freeze({
      ioKindDetail,
      nativeTlsSource,
      sourceDepth,
      sourceChainTruncated,
    } as NativeAuthorizationSendTransport);
  } catch {
    return null;
  }
}

export function nativeAuthorizationTransportDiagnostic(
  transport: NativeAuthorizationSendTransport,
): NativeAuthorizationTransportDiagnostic {
  return Object.freeze({
    native_authorization_transport_version: 1,
    native_authorization_transport_io_kind_detail: transport.ioKindDetail,
    native_authorization_transport_native_tls_source: transport.nativeTlsSource,
    native_authorization_transport_source_depth: transport.sourceDepth,
    native_authorization_transport_source_chain_truncated:
      transport.sourceChainTruncated,
  });
}

/** Read the complete transport group from any property bag's own data
 * properties, or nothing at all. Callers join it only to a valid v1 group. */
export function readNativeAuthorizationTransport(
  source: unknown,
): NativeAuthorizationTransportDiagnostic | null {
  if (typeof source !== "object" || source === null) return null;
  try {
    const [
      version,
      ioKindDetail,
      nativeTlsSource,
      sourceDepth,
      sourceChainTruncated,
    ] = readDataProperties(source, TRANSPORT_PROPERTIES);
    return version === 1 &&
      isTransport(
        ioKindDetail,
        nativeTlsSource,
        sourceDepth,
        sourceChainTruncated,
      )
      ? nativeAuthorizationTransportDiagnostic({
          ioKindDetail,
          nativeTlsSource,
          sourceDepth,
          sourceChainTruncated,
        } as NativeAuthorizationSendTransport)
      : null;
  } catch {
    return null;
  }
}

export interface NativeAuthorizationSendIo {
  readonly ioKind: UnmappedIoKind;
  readonly osFamily: OsFamily;
  readonly sourceDepth: number;
}

export interface NativeAuthorizationIoDiagnostic {
  readonly native_authorization_io_version: 1;
  readonly native_authorization_io_kind: UnmappedIoKind;
  /** A closed class of the OS code; not the code or the physical cause. */
  readonly native_authorization_io_os_family: OsFamily;
  readonly native_authorization_io_source_depth: number;
}

const IO_PROPERTIES = [
  "native_authorization_io_version",
  "native_authorization_io_kind",
  "native_authorization_io_os_family",
  "native_authorization_io_source_depth",
] as const satisfies readonly (keyof NativeAuthorizationIoDiagnostic)[];

export const NATIVE_AUTHORIZATION_IO_PROPERTIES: ReadonlySet<string> = new Set(
  IO_PROPERTIES,
);

/** The native supplement names an exposed IO error, at depth 1..8. */
const isIo = (
  ioKind: unknown,
  osFamily: unknown,
  sourceDepth: unknown,
): boolean =>
  UNMAPPED_IO_KINDS.some((kind) => kind === ioKind) &&
  OS_FAMILIES.some((family) => family === osFamily) &&
  typeof sourceDepth === "number" &&
  Number.isSafeInteger(sourceDepth) &&
  sourceDepth >= 1 &&
  sourceDepth <= MAX_SOURCE_DEPTH;

/** Copy only the closed native IO supplement schema; anything else is
 * dropped. */
export function parseNativeAuthorizationSendIo(
  value: unknown,
): NativeAuthorizationSendIo | null {
  try {
    const values = readClosedObject(value, IO_KEYS);
    if (!values) return null;
    const [version, ioKind, osFamily, sourceDepth] = values;
    if (version !== 1 || !isIo(ioKind, osFamily, sourceDepth)) return null;
    return Object.freeze({
      ioKind,
      osFamily,
      sourceDepth,
    } as NativeAuthorizationSendIo);
  } catch {
    return null;
  }
}

export function nativeAuthorizationIoDiagnostic(
  io: NativeAuthorizationSendIo,
): NativeAuthorizationIoDiagnostic {
  return Object.freeze({
    native_authorization_io_version: 1,
    native_authorization_io_kind: io.ioKind,
    native_authorization_io_os_family: io.osFamily,
    native_authorization_io_source_depth: io.sourceDepth,
  });
}

/** Read the complete IO group from any property bag's own data properties,
 * or nothing at all. It joins only already validated groups that describe the
 * same unmapped first IO error: the cause's depth and `other` fold, an
 * `unmapped` transport detail at least as deep, and a Windows family only
 * with a Windows receipt. */
export function readNativeAuthorizationIo(
  source: unknown,
  groups: {
    readonly diagnostic: NativeAuthorizationDiagnostic | null;
    readonly cause: NativeAuthorizationCauseDiagnostic | null;
    readonly transport: NativeAuthorizationTransportDiagnostic | null;
  },
): NativeAuthorizationIoDiagnostic | null {
  const { diagnostic, cause, transport } = groups;
  if (
    typeof source !== "object" ||
    source === null ||
    !diagnostic ||
    !cause ||
    !transport ||
    !isNativePlatform(diagnostic.native_platform) ||
    cause.native_authorization_cause_io_kind !== "other" ||
    transport.native_authorization_transport_io_kind_detail !== "unmapped"
  )
    return null;
  try {
    const [version, ioKind, osFamily, sourceDepth] = readDataProperties(
      source,
      IO_PROPERTIES,
    );
    return version === 1 &&
      isIo(ioKind, osFamily, sourceDepth) &&
      sourceDepth === cause.native_authorization_cause_source_depth &&
      (sourceDepth as number) <=
        transport.native_authorization_transport_source_depth &&
      (osFamily === "not_windows") !==
        (diagnostic.native_platform === "windows")
      ? nativeAuthorizationIoDiagnostic({
          ioKind,
          osFamily,
          sourceDepth,
        } as NativeAuthorizationSendIo)
      : null;
  } catch {
    return null;
  }
}

export interface NativeAuthorizationSendConnector {
  readonly phase: ConnectorPhase;
  readonly attempts: number;
  readonly elapsedMs: number | null;
}

export interface NativeAuthorizationConnectorDiagnostic {
  readonly native_authorization_connector_version: 1;
  /** The connector's own state at the send failure; never a request write. */
  readonly native_authorization_connector_phase: ConnectorPhase;
  readonly native_authorization_connector_attempts: number;
  /** The single call's time; null when there is no single call. */
  readonly native_authorization_connector_elapsed_ms: number | null;
}

const CONNECTOR_PROPERTIES = [
  "native_authorization_connector_version",
  "native_authorization_connector_phase",
  "native_authorization_connector_attempts",
  "native_authorization_connector_elapsed_ms",
] as const satisfies readonly (keyof NativeAuthorizationConnectorDiagnostic)[];

export const NATIVE_AUTHORIZATION_CONNECTOR_PROPERTIES: ReadonlySet<string> =
  new Set(CONNECTOR_PROPERTIES);

/** The native snapshot's invariants: no call has no time, one call has its
 * own bounded time, and 2..8 calls claim no single phase or time. */
const isConnector = (
  phase: unknown,
  attempts: unknown,
  elapsedMs: unknown,
): boolean =>
  CONNECTOR_PHASES.some((value) => value === phase) &&
  typeof attempts === "number" &&
  Number.isSafeInteger(attempts) &&
  (phase === "not_started"
    ? attempts === 0 && elapsedMs === null
    : phase === "multiple"
      ? attempts >= 2 &&
        attempts <= MAX_CONNECTOR_ATTEMPTS &&
        elapsedMs === null
      : attempts === 1 && isElapsed(elapsedMs));

/** Copy only the closed native connector schema; anything else is dropped. */
export function parseNativeAuthorizationSendConnector(
  value: unknown,
): NativeAuthorizationSendConnector | null {
  try {
    const values = readClosedObject(value, CONNECTOR_KEYS);
    if (!values) return null;
    const [version, phase, attempts, elapsedMs] = values;
    if (version !== 1 || !isConnector(phase, attempts, elapsedMs)) return null;
    return Object.freeze({
      phase,
      attempts,
      elapsedMs,
    } as NativeAuthorizationSendConnector);
  } catch {
    return null;
  }
}

export function nativeAuthorizationConnectorDiagnostic(
  connector: NativeAuthorizationSendConnector,
): NativeAuthorizationConnectorDiagnostic {
  return Object.freeze({
    native_authorization_connector_version: 1,
    native_authorization_connector_phase: connector.phase,
    native_authorization_connector_attempts: connector.attempts,
    native_authorization_connector_elapsed_ms: connector.elapsedMs,
  });
}

/** Read the complete connector group from any property bag's own data
 * properties, or nothing at all. Callers join it only to a valid v1 group;
 * a missing group is unknown, never `not_started`. */
export function readNativeAuthorizationConnector(
  source: unknown,
): NativeAuthorizationConnectorDiagnostic | null {
  if (typeof source !== "object" || source === null) return null;
  try {
    const [version, phase, attempts, elapsedMs] = readDataProperties(
      source,
      CONNECTOR_PROPERTIES,
    );
    return version === 1 && isConnector(phase, attempts, elapsedMs)
      ? nativeAuthorizationConnectorDiagnostic({
          phase,
          attempts,
          elapsedMs,
        } as NativeAuthorizationSendConnector)
      : null;
  } catch {
    return null;
  }
}

export interface NativeAuthorizationResponseReceipt {
  readonly httpStatus: number;
  readonly approval: Approval;
  readonly originClass: OriginClass;
  readonly platform: (typeof RECEIPT_PLATFORMS)[number];
  readonly requestIdShape: RequestIdShape;
  readonly requestId: string | null;
}

export interface NativeAuthorizationResponseDiagnostic {
  readonly native_authorization_response_version: 1;
  readonly native_authorization_response_http_status: number;
  readonly native_authorization_response_approval: Approval;
  readonly native_authorization_response_origin_class: OriginClass;
  /** The receipt's compiled target platform; null when unknown. */
  readonly native_authorization_response_platform: NativePlatform | null;
  readonly native_authorization_response_request_id_shape: RequestIdShape;
  /** Public `x-vercel-id`, only within the strict subset; otherwise null. */
  readonly native_authorization_response_request_id: string | null;
}

const RESPONSE_PROPERTIES = [
  "native_authorization_response_version",
  "native_authorization_response_http_status",
  "native_authorization_response_approval",
  "native_authorization_response_origin_class",
  "native_authorization_response_platform",
  "native_authorization_response_request_id_shape",
  "native_authorization_response_request_id",
] as const satisfies readonly (keyof NativeAuthorizationResponseDiagnostic)[];

export const NATIVE_AUTHORIZATION_RESPONSE_PROPERTIES: ReadonlySet<string> =
  new Set(RESPONSE_PROPERTIES);

/** The native check's invariants: only a non-2xx status skips the body, and
 * only a valid shape carries an ID within the strict subset. */
const isResponse = (
  httpStatus: unknown,
  approval: unknown,
  originClass: unknown,
  requestIdShape: unknown,
  requestId: unknown,
): boolean =>
  typeof httpStatus === "number" &&
  Number.isSafeInteger(httpStatus) &&
  httpStatus >= 100 &&
  httpStatus <= 599 &&
  APPROVALS.some((value) => value === approval) &&
  (approval === "not_checked") === (httpStatus < 200 || httpStatus > 299) &&
  isOriginClass(originClass) &&
  REQUEST_ID_SHAPES.some((shape) => shape === requestIdShape) &&
  (requestIdShape === "valid"
    ? typeof requestId === "string" &&
      requestId.length <= MAX_REQUEST_ID_LENGTH &&
      REQUEST_ID.test(requestId)
    : requestId === null);

/** Copy only the closed native response schema; anything else is dropped. */
export function parseNativeAuthorizationResponseReceipt(
  value: unknown,
): NativeAuthorizationResponseReceipt | null {
  try {
    const values = readClosedObject(value, RESPONSE_KEYS);
    if (!values) return null;
    const [
      version,
      httpStatus,
      approval,
      originClass,
      platform,
      requestIdShape,
      requestId,
    ] = values;
    if (
      version !== 1 ||
      !isReceiptPlatform(platform) ||
      !isResponse(httpStatus, approval, originClass, requestIdShape, requestId)
    )
      return null;
    return Object.freeze({
      httpStatus,
      approval,
      originClass,
      platform,
      requestIdShape,
      requestId,
    } as NativeAuthorizationResponseReceipt);
  } catch {
    return null;
  }
}

export function nativeAuthorizationResponseDiagnostic(
  receipt: NativeAuthorizationResponseReceipt,
): NativeAuthorizationResponseDiagnostic {
  return Object.freeze({
    native_authorization_response_version: 1,
    native_authorization_response_http_status: receipt.httpStatus,
    native_authorization_response_approval: receipt.approval,
    native_authorization_response_origin_class: receipt.originClass,
    native_authorization_response_platform: isNativePlatform(receipt.platform)
      ? receipt.platform
      : null,
    native_authorization_response_request_id_shape: receipt.requestIdShape,
    native_authorization_response_request_id: receipt.requestId,
  });
}

/** Read the complete response group from any property bag's own data
 * properties, or nothing at all. Independent of the send groups. */
export function readNativeAuthorizationResponse(
  source: unknown,
): NativeAuthorizationResponseDiagnostic | null {
  if (typeof source !== "object" || source === null) return null;
  try {
    const [
      version,
      httpStatus,
      approval,
      originClass,
      platform,
      requestIdShape,
      requestId,
    ] = readDataProperties(source, RESPONSE_PROPERTIES);
    return version === 1 &&
      (platform === null || isNativePlatform(platform)) &&
      isResponse(httpStatus, approval, originClass, requestIdShape, requestId)
      ? nativeAuthorizationResponseDiagnostic({
          httpStatus,
          approval,
          originClass,
          platform: platform ?? "unknown",
          requestIdShape,
          requestId,
        } as NativeAuthorizationResponseReceipt)
      : null;
  } catch {
    return null;
  }
}

export interface NativeAuthorizationResponseMitigation {
  readonly mitigation: Mitigation;
}

export interface NativeAuthorizationMitigationDiagnostic {
  readonly native_authorization_response_mitigation_version: 1;
  /** Observed `x-vercel-mitigated` class, not an authenticated decision. */
  readonly native_authorization_response_mitigation: Mitigation;
}

const MITIGATION_PROPERTIES = [
  "native_authorization_response_mitigation_version",
  "native_authorization_response_mitigation",
] as const satisfies readonly (keyof NativeAuthorizationMitigationDiagnostic)[];

export const NATIVE_AUTHORIZATION_MITIGATION_PROPERTIES: ReadonlySet<string> =
  new Set(MITIGATION_PROPERTIES);

const isMitigation = (value: unknown): value is Mitigation =>
  MITIGATIONS.some((mitigation) => mitigation === value);

/** Copy only the closed native mitigation schema; anything else is dropped. */
export function parseNativeAuthorizationResponseMitigation(
  value: unknown,
): NativeAuthorizationResponseMitigation | null {
  try {
    const values = readClosedObject(value, MITIGATION_KEYS);
    if (!values) return null;
    const [version, mitigation] = values;
    if (version !== 1 || !isMitigation(mitigation)) return null;
    return Object.freeze({ mitigation });
  } catch {
    return null;
  }
}

export function nativeAuthorizationMitigationDiagnostic(
  receipt: NativeAuthorizationResponseMitigation,
): NativeAuthorizationMitigationDiagnostic {
  return Object.freeze({
    native_authorization_response_mitigation_version: 1,
    native_authorization_response_mitigation: receipt.mitigation,
  });
}

/** Read the complete mitigation group from any property bag's own data
 * properties, or nothing at all. Callers join it only to a valid response
 * group. */
export function readNativeAuthorizationMitigation(
  source: unknown,
): NativeAuthorizationMitigationDiagnostic | null {
  if (typeof source !== "object" || source === null) return null;
  try {
    const [version, mitigation] = readDataProperties(
      source,
      MITIGATION_PROPERTIES,
    );
    return version === 1 && isMitigation(mitigation)
      ? nativeAuthorizationMitigationDiagnostic({ mitigation })
      : null;
  } catch {
    return null;
  }
}
