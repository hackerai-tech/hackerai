export const LOCAL_CONNECTION_LOST_FINISH_REASON = "local-connection-lost";

/** First observed cause; watcher/manager origin and phase are derived offline. */
const LOCAL_STOP_REASONS = [
  "selected_host_left",
  // The selected Desktop announced an intentional stop (quit, sign-out).
  "selected_host_ended",
  "selected_presence_absent",
  "observer_reconnecting",
  "observer_disconnected",
  "subscription_reconnecting",
  "subscription_unsubscribed",
  "subscription_error",
  "presence_error",
  "setup_timeout",
  "setup_error",
  "presence_timeout",
  "observer_recovery_expired",
  // A Desktop host that proved its native session may return in the window.
  "selected_host_recovery_expired",
  "desktop_session_replaced",
  "desktop_session_unverified",
  "desktop_command_unreconciled",
  "watched_connection_replaced",
  "selected_connection_unavailable",
  "local_recovery_requested",
  "local_reset_requested",
  "unavailable",
] as const;

export type LocalStopReason = (typeof LOCAL_STOP_REASONS)[number];

const CLIENT_STATES = ["connected", "connecting", "disconnected"] as const;

export type LocalStopClientState = (typeof CLIENT_STATES)[number];

export type LocalStopDetails = {
  connectionId?: string;
  hadPositivePresence?: boolean;
  lastPositivePresenceAgeMs?: number;
  /**
   * First winning observer callback's code; its namespace depends on the
   * reason. An expired recovery or failed session proof has no callback.
   */
  callbackCode?: number;
  /** Public observer client state before the watcher's own disconnect. */
  clientState?: LocalStopClientState;
  /**
   * Native close of the observer's armed socket seen before the first stop;
   * both or neither. Absent means unmeasured, not that no socket closed.
   */
  socketCloseCode?: number;
  socketCloseWasClean?: boolean;
  /** Set only for a stop during a recovery window: its fixed length. */
  recoveryWindowMs?: number;
  /** How long that outage had lasted when the run stopped. */
  recoveryElapsedMs?: number;
};

type LocalStopDiagnostic = Readonly<
  { reason: LocalStopReason } & LocalStopDetails
>;

const MAX_PRESENCE_AGE_MS = 86_400_000;

const OUTAGE_BUCKETS = [
  [5_000, "lt_5s"],
  [15_000, "5s_15s"],
  [30_000, "15s_30s"],
  [60_000, "30s_60s"],
  [120_000, "60s_120s"],
] as const;

/** Coarse, content-free outage length for analytics. */
export function outageDurationBucket(ms: number) {
  for (const [limit, bucket] of OUTAGE_BUCKETS) if (ms < limit) return bucket;
  return "gte_120s" as const;
}

function duration(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_PRESENCE_AGE_MS
    ? Math.round(value)
    : undefined;
}
const MAX_CALLBACK_CODE = 4_999;
const MIN_SOCKET_CLOSE_CODE = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Keyed by the constructed instance, so forged or proxied objects carry nothing.
const diagnostics = new WeakMap<object, LocalStopDiagnostic>();

function ownData(value: unknown, key: string): unknown {
  try {
    if (value === null || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function callbackCode(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_CALLBACK_CODE
    ? value
    : undefined;
}

function clientState(value: unknown): LocalStopClientState | undefined {
  return CLIENT_STATES.find((known) => known === value);
}

function socketClose(code: unknown, wasClean: unknown) {
  return typeof code === "number" &&
    Number.isInteger(code) &&
    code >= MIN_SOCKET_CLOSE_CODE &&
    code <= MAX_CALLBACK_CODE &&
    typeof wasClean === "boolean"
    ? { socketCloseCode: code, socketCloseWasClean: wasClean }
    : undefined;
}

/** Getter-free reads of SDK values; faults and invalid values are omitted. */
export const readCallbackCode = (context: unknown) =>
  callbackCode(ownData(context, "code"));
export const readClientState = (client: unknown) =>
  clientState(ownData(client, "state"));

/** A native CloseEvent's public getters, never its reason; faults are omitted. */
export function readSocketClose(event: unknown) {
  try {
    if (event === null || typeof event !== "object") return undefined;
    const { code, wasClean } = event as { code?: unknown; wasClean?: unknown };
    return socketClose(code, wasClean);
  } catch {
    return undefined;
  }
}

function validate(reason: unknown, details: unknown): LocalStopDiagnostic {
  const diagnostic: { reason: LocalStopReason } & LocalStopDetails = {
    reason:
      LOCAL_STOP_REASONS.find((known) => known === reason) ?? "unavailable",
  };
  const connectionId = ownData(details, "connectionId");
  if (typeof connectionId === "string" && UUID.test(connectionId))
    diagnostic.connectionId = connectionId;
  const hadPositivePresence = ownData(details, "hadPositivePresence");
  if (typeof hadPositivePresence === "boolean") {
    diagnostic.hadPositivePresence = hadPositivePresence;
    const age = ownData(details, "lastPositivePresenceAgeMs");
    if (
      hadPositivePresence &&
      typeof age === "number" &&
      Number.isFinite(age) &&
      age >= 0 &&
      age <= MAX_PRESENCE_AGE_MS
    )
      diagnostic.lastPositivePresenceAgeMs = Math.round(age);
  }
  const code = callbackCode(ownData(details, "callbackCode"));
  if (code !== undefined) diagnostic.callbackCode = code;
  const state = clientState(ownData(details, "clientState"));
  if (state !== undefined) diagnostic.clientState = state;
  const close = socketClose(
    ownData(details, "socketCloseCode"),
    ownData(details, "socketCloseWasClean"),
  );
  if (close) Object.assign(diagnostic, close);
  const recoveryWindowMs = duration(ownData(details, "recoveryWindowMs"));
  if (recoveryWindowMs !== undefined) {
    diagnostic.recoveryWindowMs = recoveryWindowMs;
    const elapsed = duration(ownData(details, "recoveryElapsedMs"));
    if (elapsed !== undefined) diagnostic.recoveryElapsedMs = elapsed;
  }
  return Object.freeze(diagnostic);
}

export class LocalConnectionLostError extends Error {
  constructor(reason?: LocalStopReason, details?: LocalStopDetails) {
    super(
      "The local connection was lost. Reconnect your computer, then resume from the chat.",
    );
    this.name = "LocalConnectionLostError";
    diagnostics.set(this, validate(reason, details));
  }

  get stopReason(): LocalStopReason {
    return diagnostics.get(this)?.reason ?? "unavailable";
  }
}

/** Closed projection of a constructed error; never reads the value itself. */
export function getLocalStopDiagnostic(
  error: unknown,
): LocalStopDiagnostic | undefined {
  return error !== null && typeof error === "object"
    ? diagnostics.get(error)
    : undefined;
}

export function localStopAnalyticsProperties(error: unknown) {
  const diagnostic = getLocalStopDiagnostic(error);
  if (!diagnostic) return undefined;
  return {
    local_stop_diagnostic_version: 1,
    local_stop_reason: diagnostic.reason,
    ...(diagnostic.connectionId !== undefined && {
      local_stop_connection_id: diagnostic.connectionId,
    }),
    ...(diagnostic.hadPositivePresence !== undefined && {
      local_stop_had_positive_presence: diagnostic.hadPositivePresence,
    }),
    ...(diagnostic.lastPositivePresenceAgeMs !== undefined && {
      local_stop_last_positive_presence_age_ms:
        diagnostic.lastPositivePresenceAgeMs,
    }),
    ...(diagnostic.callbackCode !== undefined && {
      local_stop_callback_code: diagnostic.callbackCode,
    }),
    ...(diagnostic.clientState !== undefined && {
      local_stop_client_state: diagnostic.clientState,
    }),
    ...(diagnostic.socketCloseCode !== undefined &&
      diagnostic.socketCloseWasClean !== undefined && {
        local_stop_socket_close_code: diagnostic.socketCloseCode,
        local_stop_socket_close_was_clean: diagnostic.socketCloseWasClean,
      }),
    ...(diagnostic.recoveryWindowMs !== undefined && {
      local_stop_recovery_window_ms: diagnostic.recoveryWindowMs,
    }),
    ...(diagnostic.recoveryElapsedMs !== undefined && {
      local_stop_recovery_outage_bucket: outageDurationBucket(
        diagnostic.recoveryElapsedMs,
      ),
    }),
  } as const;
}

/** Content-free outcome of the outages a run recovered from. */
export type LocalRunRecoverySummary = Readonly<{
  recoveredOutages: number;
  /** Longest recovered outage; absent when none was measured. */
  maxRecoveredOutageMs?: number;
}>;

/**
 * Whether a watched run survived its host outages. Omitted when the run had
 * neither an outage nor a local stop. `stopped_unrecoverable` is a stop that
 * never entered a recovery window, such as a departure before session proof.
 */
export function localRecoveryAnalyticsProperties(
  summary: LocalRunRecoverySummary | undefined,
  localStop: unknown,
) {
  const stop = getLocalStopDiagnostic(localStop);
  const recovered =
    typeof summary?.recoveredOutages === "number" &&
    Number.isSafeInteger(summary.recoveredOutages) &&
    summary.recoveredOutages > 0
      ? summary.recoveredOutages
      : 0;
  const outcome = stop
    ? stop.recoveryWindowMs === undefined
      ? "stopped_unrecoverable"
      : stop.reason.endsWith("_recovery_expired")
        ? "expired"
        : "stopped_in_window"
    : recovered > 0
      ? "recovered"
      : undefined;
  if (!outcome) return undefined;
  const longest = summary?.maxRecoveredOutageMs;
  return {
    local_recovery_outcome: outcome,
    local_recovered_outages: recovered,
    ...(recovered > 0 &&
      typeof longest === "number" &&
      Number.isFinite(longest) &&
      longest >= 0 && {
        local_recovered_max_outage_bucket: outageDurationBucket(longest),
      }),
  } as const;
}
