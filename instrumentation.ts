import { phLogger } from "@/lib/posthog/server";
import { registerPostHogLogProvider } from "@/lib/posthog/logs";
import { isEndedSessionRefreshError } from "@/lib/auth/expected-auth-errors";
import type { Instrumentation } from "next";

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    registerPostHogLogProvider();
  }
}

export const onRequestError: Instrumentation.onRequestError = (
  error,
  request,
  context,
) => {
  if (isEndedSessionRefreshError(error)) {
    phLogger.warn("auth_session_refresh_ended", {
      event: "auth.session_refresh_ended",
      error,
      path: request.path,
      method: request.method,
      routePath: context.routePath,
      routeType: context.routeType,
      routerKind: context.routerKind,
    });
    return;
  }

  phLogger.error("Next.js request error", {
    error,
    path: request.path,
    method: request.method,
    routePath: context.routePath,
    routeType: context.routeType,
    routerKind: context.routerKind,
  });
};
