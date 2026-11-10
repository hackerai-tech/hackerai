import { phLogger } from "@/lib/posthog/server";
import { registerPostHogLogProvider } from "@/lib/posthog/logs";
import { isEndedSessionRefreshError } from "@/lib/auth/expected-auth-errors";
import { getRefreshFailureDiagnostics } from "@/lib/auth/refresh-failure-diagnostics";
import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerServiceTransportObserver } =
      await import("./lib/db/service-transport-observation.node");
    registerServiceTransportObserver();
    registerPostHogLogProvider();
  }
}

const getHeaderValue = (
  headers: NodeJS.Dict<string | string[]>,
  name: string,
): string | undefined => {
  const value = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
  return Array.isArray(value) ? value[0] : value;
};

const getErrorDigest = (error: unknown): string | undefined => {
  try {
    if (typeof error !== "object" || error === null || !("digest" in error)) {
      return undefined;
    }
    return typeof error.digest === "string" || typeof error.digest === "number"
      ? String(error.digest)
      : undefined;
  } catch {
    return undefined;
  }
};

const getServerActionErrorMetadata = (
  error: unknown,
  request: Parameters<Instrumentation.onRequestError>[1],
  context: Parameters<Instrumentation.onRequestError>[2],
): Record<string, string | number> => {
  if (context.routeType !== "action") return {};

  const actionId = getHeaderValue(request.headers, "next-action");
  const rawContentType = getHeaderValue(request.headers, "content-type");
  const contentType = rawContentType?.split(";", 1)[0].trim().toLowerCase();
  const rawContentLength = getHeaderValue(request.headers, "content-length");
  const contentLength =
    rawContentLength && /^\d{1,15}$/.test(rawContentLength)
      ? Number(rawContentLength)
      : undefined;
  const vercelRequestId = getHeaderValue(request.headers, "x-vercel-id");
  const digest = getErrorDigest(error);

  return {
    ...(actionId && /^[a-f0-9]{40}$/i.test(actionId)
      ? { action_id: actionId }
      : {}),
    ...(contentType && contentType.length <= 128
      ? { content_type: contentType }
      : {}),
    ...(contentLength !== undefined && Number.isSafeInteger(contentLength)
      ? { content_length: contentLength }
      : {}),
    ...(vercelRequestId && /^[a-z0-9:._-]{1,256}$/i.test(vercelRequestId)
      ? { vercel_request_id: vercelRequestId }
      : {}),
    ...(digest && /^[a-z0-9_-]{1,128}$/i.test(digest)
      ? { error_digest: digest }
      : {}),
  };
};

/** Correlate selected page reads and share POST failures without request contents. */
function getRootRequestErrorMetadata(
  error: unknown,
  request: Parameters<Instrumentation.onRequestError>[1],
  context: Parameters<Instrumentation.onRequestError>[2],
  path: string,
) {
  if (
    !["/", "/index", "/login", "/share/[shareId]"].includes(path) ||
    (request.method !== "GET" &&
      request.method !== "HEAD" &&
      !(request.method === "POST" && path === "/share/[shareId]"))
  )
    return undefined;
  try {
    // Reuse the existing closed error/cause taxonomy; none of these fields
    // participate in auth, rendering, or response decisions.
    const details = getRefreshFailureDiagnostics(error);
    const requestId = getHeaderValue(request.headers, "x-vercel-id");
    const digest = getErrorDigest(error);
    return {
      root_request_error_diagnostic_version: 1,
      root_error_kind: details.auth_refresh_error_kind,
      root_error_status: details.auth_refresh_error_status,
      root_error_status_shape: details.auth_refresh_error_status_shape,
      root_error_code: details.auth_refresh_error_code,
      root_cause_kind: details.auth_refresh_cause_kind,
      root_cause_status: details.auth_refresh_cause_status,
      root_cause_status_shape: details.auth_refresh_cause_status_shape,
      root_cause_code: details.auth_refresh_cause_code,
      root_render_source: [
        "react-server-components",
        "react-server-components-payload",
        "server-rendering",
      ].includes(context.renderSource ?? "")
        ? context.renderSource
        : "unknown",
      ...(requestId &&
      /^(?:[a-z]{3}\d::){1,3}[a-z0-9]{3,16}-\d{10,17}-[a-f0-9]{8,64}$/.test(
        requestId,
      )
        ? { vercel_request_id: requestId }
        : {}),
      ...(digest && /^\d{1,20}$/.test(digest) ? { error_digest: digest } : {}),
    };
  } catch {
    return undefined;
  }
}

export const onRequestError: Instrumentation.onRequestError = (
  error,
  request,
  context,
) => {
  // Next includes the query in request.path; OAuth callbacks can carry credentials.
  const requestPath = request.path.split(/[?#]/, 1)[0];
  // A public share URL is still a resource identifier. Keep only its route
  // template in both the existing error export and its finite native receipt.
  const path = requestPath.replace(/^\/share\/[^/]+\/?$/, "/share/[shareId]");

  if (isEndedSessionRefreshError(error)) {
    phLogger.warn("auth_session_refresh_ended", {
      event: "auth.session_refresh_ended",
      error,
      path,
      method: request.method,
      routePath: context.routePath,
      routeType: context.routeType,
      routerKind: context.routerKind,
    });
    return;
  }

  const rootMetadata = getRootRequestErrorMetadata(
    error,
    request,
    context,
    path,
  );
  if (rootMetadata?.root_request_error_diagnostic_version === 1) {
    // PostHog exports are buffered. This finite native receipt distinguishes a
    // reached Next hook from missing export evidence, without awaiting telemetry
    // or serializing the original error. It is not proof of pre-hook failures.
    try {
      const build = process.env.VERCEL_GIT_COMMIT_SHA;
      const environment = process.env.VERCEL_ENV;
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          event: "root_request_error_context",
          service: "hackerai-web",
          environment: ["production", "preview", "development"].includes(
            environment ?? "",
          )
            ? environment
            : "unknown",
          ...(build && /^[a-f0-9]{40}$/i.test(build)
            ? { web_build_commit: build.toLowerCase() }
            : {}),
          path,
          method: request.method,
          route_type: ["render", "route", "action", "proxy"].includes(
            context.routeType,
          )
            ? context.routeType
            : "unknown",
          ...rootMetadata,
        }),
      );
    } catch {
      // Optional diagnostics cannot replace the original error report.
    }
  }

  phLogger.error("Next.js request error", {
    error,
    path,
    method: request.method,
    routePath: context.routePath,
    routeType: context.routeType,
    routerKind: context.routerKind,
    ...rootMetadata,
    ...getServerActionErrorMetadata(error, request, context),
  });
};
