export const LOCAL_CONNECTION_LOST_FINISH_REASON = "local-connection-lost";

/** First observed cause; watcher/manager origin and phase are derived offline. */
const LOCAL_STOP_REASONS = [
  "selected_host_left",
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
  "watched_connection_replaced",
  "selected_connection_unavailable",
  "local_recovery_requested",
  "local_reset_requested",
  "unavailable",
] as const;

export type LocalStopReason = (typeof LOCAL_STOP_REASONS)[number];

export type LocalStopDetails = {
  connectionId?: string;
  hadPositivePresence?: boolean;
  lastPositivePresenceAgeMs?: number;
};

type LocalStopDiagnostic = Readonly<
  { reason: LocalStopReason } & LocalStopDetails
>;

const MAX_PRESENCE_AGE_MS = 86_400_000;
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
  } as const;
}
