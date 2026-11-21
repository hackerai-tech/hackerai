/**
 * One native `cancel_stream_command` IPC that did not confirm the stop of an
 * original Windows Desktop command: it resolved strictly false (stop
 * unconfirmed, including a cancel wait timeout) or the IPC itself rejected.
 * Neither outcome describes any particular OS process. The single schema for
 * the capture, its before_send projection and its one-shot delivery;
 * dependency-free so the analytics client, privacy guard and provider can
 * import it. The SDK's own delivery can batch and retry, including after
 * consent changes, so this event bypasses it.
 */
export const DESKTOP_STREAM_CANCEL_NONCONFIRMATION_EVENT =
  "desktop_stream_cancel_nonconfirmation";
export const DESKTOP_STREAM_CANCEL_NONCONFIRMATION_VERSION = 1;

const CALLERS = [
  "relay_command_cancel",
  "output_overflow",
  "local_run_stop",
] as const;
const OUTCOMES = ["returned_false", "invoke_rejected"] as const;

export type DesktopStreamCancelCaller = (typeof CALLERS)[number];
export type DesktopStreamCancelOutcome = (typeof OUTCOMES)[number];

export type DesktopStreamCancelNonconfirmation = {
  version: typeof DESKTOP_STREAM_CANCEL_NONCONFIRMATION_VERSION;
  command_id: string;
  caller: DesktopStreamCancelCaller;
  outcome: DesktopStreamCancelOutcome;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Opaque account IDs (WorkOS user_...). Excludes URLs, emails and whitespace.
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isDesktopStreamCancelCommandId(
  value: unknown,
): value is string {
  return typeof value === "string" && value.length === 36 && UUID.test(value);
}

export function isDesktopStreamCancelOwner(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

/** Use the configured cloud region or the legacy US hostname the SDK maps. */
export function desktopStreamCancelCaptureUrl(apiHost: unknown): string | null {
  if (typeof apiHost !== "string") return null;
  const origin = apiHost.trim().replace(/\/$/, "").toLowerCase();
  switch (origin) {
    case "https://app.posthog.com":
    case "https://us.i.posthog.com":
      return "https://us.i.posthog.com/i/v0/e/";
    case "https://eu.i.posthog.com":
      return "https://eu.i.posthog.com/i/v0/e/";
    default:
      return null;
  }
}

/**
 * Start exactly one request for an already projected event, in the pinned
 * SDK's uncompressed capture body, and never retry it: no cookies, redirects,
 * keepalive or awaiting. The caller returns null to the SDK so it never queues
 * or retries the event itself. The consent owner can abort pending delivery.
 */
export function sendDesktopStreamCancelOnce(
  event: {
    uuid?: unknown;
    event: unknown;
    properties?: Record<string, unknown>;
    timestamp?: unknown;
  },
  url: string,
  token: string,
  signal: AbortSignal,
): void {
  if (signal.aborted) return;
  try {
    const body = JSON.stringify({
      api_key: token,
      batch: [
        {
          ...(event.uuid !== undefined && { uuid: event.uuid }),
          event: event.event,
          properties: { ...event.properties, token },
          ...(event.timestamp instanceof Date &&
            Number.isFinite(event.timestamp.getTime()) && {
              timestamp: event.timestamp.toISOString(),
            }),
        },
      ],
      sent_at: new Date().toISOString(),
    });
    void Promise.resolve(
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        mode: "cors",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        redirect: "error",
        keepalive: false,
        signal,
      }),
    ).catch(() => {});
  } catch {
    // No retry for failed dispatch.
  }
}

/** Rebuild exactly the four fields; any missing or invalid one rejects all. */
export function projectDesktopStreamCancelNonconfirmation(
  read: (key: string) => unknown,
): DesktopStreamCancelNonconfirmation | null {
  const version = read("version");
  const commandId = read("command_id");
  const caller = read("caller");
  const outcome = read("outcome");
  if (version !== DESKTOP_STREAM_CANCEL_NONCONFIRMATION_VERSION) return null;
  if (!isDesktopStreamCancelCommandId(commandId)) return null;
  const knownCaller = CALLERS.find((known) => known === caller);
  const knownOutcome = OUTCOMES.find((known) => known === outcome);
  if (!knownCaller || !knownOutcome) return null;
  return {
    version,
    command_id: commandId,
    caller: knownCaller,
    outcome: knownOutcome,
  };
}
