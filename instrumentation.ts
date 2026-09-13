import { phLogger } from "@/lib/posthog/server";
import { registerPostHogLogProvider } from "@/lib/posthog/logs";
import { isEndedSessionRefreshError } from "@/lib/auth/expected-auth-errors";
import type { Instrumentation } from "next";

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
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
    ...getServerActionErrorMetadata(error, request, context),
  });
};
