"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  FREE_AGENT_ACTIVATION_DEFINITION_VERSION,
  FREE_AGENT_ACTIVATION_KEY,
  type FreeAgentActivationStatus,
} from "@/lib/activation/free-agent-activation";
import {
  captureAuthenticatedEvent,
  captureQueuedAuthenticatedEvent,
  getPermittedAnalyticsUserId,
  subscribeAuthenticatedAnalytics,
} from "@/lib/analytics/client";
import { environmentPreference } from "@/lib/sandbox/environment";
import type { SandboxPreference } from "@/types/chat";

export const FREE_AGENT_ACTIVATION_STATUS_PATH =
  "/api/experiments/free-agent-activation";
export const FREE_AGENT_GATE_SEND_DISABLED_REASON =
  "Continue with Agent to send";

const STATUS_TIMEOUT_MS = 5_000;
// Window focus is frequent; the server stays authoritative between refreshes.
const FOCUS_REFRESH_MIN_INTERVAL_MS = 10_000;
const EVENT_DEFINITION_VERSION = FREE_AGENT_ACTIVATION_DEFINITION_VERSION;

const subscribePageVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const getPageVisible = () => document.visibilityState !== "hidden";
const getServerPageVisible = () => false;

/** `undefined` means the body is not a valid status response. */
function parseStatus(
  body: unknown,
): FreeAgentActivationStatus | null | undefined {
  if (!body || typeof body !== "object" || !("status" in body)) return;
  const status = (body as { status: unknown }).status;
  // A valid null is a definitive answer: not enrolled, excluded or off.
  if (status === null) return null;
  if (typeof status !== "object") return;
  const { variant, completedAskResponses, introLimit, requiresAgent } =
    status as Record<string, unknown>;
  if (
    (variant !== "control" && variant !== "test") ||
    typeof completedAskResponses !== "number" ||
    !Number.isFinite(completedAskResponses) ||
    typeof introLimit !== "number" ||
    !Number.isFinite(introLimit) ||
    typeof requiresAgent !== "boolean"
  ) {
    return;
  }
  return { variant, completedAskResponses, introLimit, requiresAgent };
}

/**
 * Account-scoped experiment status. `status` is null while disabled,
 * unresolved, for another account, or after a failed fetch, so stale state
 * never gates. `statusKnown` is false only while an enabled account's answer
 * is pending, failed, timed out or malformed.
 */
export function useFreeAgentActivationStatus({
  userId,
  enabled,
}: {
  userId: string | null;
  enabled: boolean;
}) {
  const [result, setResult] = useState<{
    userId: string;
    status: FreeAgentActivationStatus | null;
    known: boolean;
  } | null>(null);
  const [nonce, setNonce] = useState(0);
  const lastFetchStartedAtRef = useRef(0);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !userId) return;
    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
    lastFetchStartedAtRef.current = Date.now();

    fetch(FREE_AGENT_ACTIVATION_STATUS_PATH, {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Status unavailable");
        return response.json();
      })
      .then((body) => {
        if (cancelled) return;
        const status = parseStatus(body);
        setResult(
          status === undefined
            ? { userId, status: null, known: false }
            : { userId, status, known: true },
        );
      })
      .catch(() => {
        if (!cancelled) setResult({ userId, status: null, known: false });
      })
      .finally(() => clearTimeout(timeoutId));

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [enabled, userId, nonce]);

  useEffect(() => {
    if (!enabled || !userId) return;
    const refreshOnReturn = () => {
      if (document.visibilityState === "hidden") return;
      if (
        Date.now() - lastFetchStartedAtRef.current <
        FOCUS_REFRESH_MIN_INTERVAL_MS
      ) {
        return;
      }
      refresh();
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [enabled, refresh, userId]);

  const current =
    enabled && userId && result?.userId === userId ? result : null;
  // Disabled clients are definitively outside the experiment.
  const statusKnown = !enabled || !userId || (current?.known ?? false);
  return { status: current?.status ?? null, statusKnown, refresh };
}

interface GateConnection {
  connectionId: string;
  environmentId?: string;
  createdAt?: number;
  isDesktop: boolean;
}

/**
 * Picks an existing computer when the gated user has none selected. A
 * selected but disconnected computer stays selected so reconnect works.
 */
export function selectFreeAgentGateSandboxPreference(
  sandboxPreference: SandboxPreference,
  localConnections: readonly GateConnection[] | undefined,
): SandboxPreference | null {
  if (sandboxPreference !== "e2b" || !localConnections?.length) return null;
  const newestFirst = [...localConnections].sort(
    (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
  );
  const preferred =
    newestFirst.find((connection) => connection.isDesktop) ?? newestFirst[0];
  return environmentPreference(preferred);
}

function baseProperties(status: FreeAgentActivationStatus) {
  return {
    experiment_key: FREE_AGENT_ACTIVATION_KEY,
    variant: status.variant,
    definition_version: EVENT_DEFINITION_VERSION,
  };
}

/**
 * Records exposure once per account and variant when the experiment surface
 * is on screen. Server-side assignment and background tabs are not exposure;
 * a hidden tab records exposure when it becomes visible.
 */
export function useFreeAgentActivationExposure({
  userId,
  status,
  visible,
  surface,
}: {
  userId: string | null | undefined;
  status: FreeAgentActivationStatus | null | undefined;
  visible: boolean;
  surface: string;
}) {
  const analyticsOwner = useSyncExternalStore(
    subscribeAuthenticatedAnalytics,
    getPermittedAnalyticsUserId,
    () => null,
  );
  const pageVisible = useSyncExternalStore(
    subscribePageVisibility,
    getPageVisible,
    getServerPageVisible,
  );
  const capturedRef = useRef(new Set<string>());
  const variant = status?.variant;
  const completedAskResponses = status?.completedAskResponses;
  const introLimit = status?.introLimit;
  const requiresAgent = status?.requiresAgent;

  useEffect(() => {
    if (!visible || !pageVisible || !variant || !userId) return;
    if (analyticsOwner !== userId) return;
    const key = `${userId}:${variant}`;
    const captureOnce = (
      kind: string,
      input: Parameters<typeof captureQueuedAuthenticatedEvent>[0],
    ) => {
      if (capturedRef.current.has(`${key}:${kind}`)) return;
      if (captureQueuedAuthenticatedEvent(input))
        capturedRef.current.add(`${key}:${kind}`);
    };

    captureOnce("custom", {
      event: "free_agent_activation_exposed",
      properties: {
        experiment_key: FREE_AGENT_ACTIVATION_KEY,
        variant,
        definition_version: EVENT_DEFINITION_VERSION,
        completed_ask_responses: completedAskResponses,
        intro_limit: introLimit,
        requires_agent: requiresAgent,
        surface,
      },
      dedupeKey: `exposed:${variant}:v${EVENT_DEFINITION_VERSION}`,
    });
    // The PostHog experiment reads this default exposure event.
    captureOnce("experiment", {
      event: "$experiment_exposure",
      properties: {
        $feature_flag: FREE_AGENT_ACTIVATION_KEY,
        $feature_flag_response: variant,
      },
      dedupeKey: `experiment_exposure:${variant}:v${EVENT_DEFINITION_VERSION}`,
    });
  }, [
    analyticsOwner,
    completedAskResponses,
    introLimit,
    pageVisible,
    requiresAgent,
    surface,
    userId,
    variant,
    visible,
  ]);
}

export function captureFreeAgentGateShown(
  status: FreeAgentActivationStatus,
  surface: string,
) {
  return captureQueuedAuthenticatedEvent({
    event: "free_agent_activation_gate_shown",
    properties: {
      ...baseProperties(status),
      completed_ask_responses: status.completedAskResponses,
      intro_limit: status.introLimit,
      surface,
    },
    dedupeKey: `gate_shown:v${EVENT_DEFINITION_VERSION}`,
  });
}

export type FreeAgentSetupAction =
  | "open_setup"
  | "download_desktop"
  | "download_again"
  | "connect_existing"
  | "upgrade"
  | "use_connected";

export function captureFreeAgentSetupAction(
  status: FreeAgentActivationStatus | null | undefined,
  action: FreeAgentSetupAction,
  surface: string,
) {
  if (!status) return false;
  return captureAuthenticatedEvent("free_agent_activation_setup_action", {
    ...baseProperties(status),
    action,
    surface,
  });
}
