import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { normalizePaidFunnelLabel } from "@/lib/analytics/paid-funnel";

const NAVIGATION_OBSERVATION_MS = 10_000;

/** Best-effort, consent-respecting signals; none proves that Stripe loaded. */
export function createCheckoutNavigationDiagnostics(context: {
  attemptId: string;
  plan: string;
  source?: string;
  surface?: string;
}) {
  const startedAt = Date.now();
  const properties = {
    checkout_attempt_id: context.attemptId,
    plan: context.plan,
    source: normalizePaidFunnelLabel(context.source),
    surface: normalizePaidFunnelLabel(context.surface),
    checkout_type: "new_subscription",
    from_tier: "free",
    navigation_diagnostics_version: 1,
  };
  let cleanup = () => {};

  function capture(event: string, extra: Record<string, unknown> = {}) {
    try {
      captureAuthenticatedEvent(
        event,
        { ...properties, elapsed_ms: Date.now() - startedAt, ...extra },
        { send_instantly: true, transport: "sendBeacon" },
      );
    } catch {
      // Diagnostics must never prevent checkout or a retry.
    }
  }

  return {
    responseReceived(status: number) {
      capture("checkout_response_received", { http_status: status });
    },
    failed(
      reason:
        | "request_failed"
        | "http_error"
        | "invalid_json"
        | "missing_checkout_url"
        | "navigation_exception",
      status?: number,
    ) {
      cleanup();
      capture("checkout_client_error", { reason, http_status: status });
    },
    navigationRequested() {
      cleanup();
      const onPageHide = (event: PageTransitionEvent) => {
        cleanup();
        capture("checkout_page_departed", { persisted: event.persisted });
      };
      const timer = window.setTimeout(() => {
        cleanup();
        capture("checkout_navigation_unconfirmed", {
          visibility_state: document.visibilityState,
          observation_window_ms: NAVIGATION_OBSERVATION_MS,
        });
      }, NAVIGATION_OBSERVATION_MS);
      cleanup = () => {
        window.clearTimeout(timer);
        window.removeEventListener("pagehide", onPageHide);
      };
      window.addEventListener("pagehide", onPageHide, { once: true });
      capture("checkout_navigation_requested");
    },
  };
}
