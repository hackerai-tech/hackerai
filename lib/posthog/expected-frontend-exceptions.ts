import { shouldDropExpectedConvexException } from "@/lib/posthog/expected-convex-errors";

type PostHogEventLike = {
  event?: string;
  properties?: Record<string, unknown>;
};

const RESIZE_OBSERVER_MESSAGES = new Set([
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
]);

const collectStrings = (value: unknown, strings: string[] = []): string[] => {
  if (typeof value === "string") {
    strings.push(value);
    return strings;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, strings);
    }
    return strings;
  }

  if (value && typeof value === "object") {
    for (const nestedValue of Object.values(value)) {
      collectStrings(nestedValue, strings);
    }
  }

  return strings;
};

const includesAny = (strings: string[], fragments: string[]): boolean =>
  strings.some((value) =>
    fragments.some((fragment) => value.includes(fragment)),
  );

const hasExactString = (strings: string[], expected: string): boolean =>
  strings.some((value) => value === expected);

const hasResizeObserverMessage = (strings: string[]): boolean =>
  strings.some((value) => RESIZE_OBSERVER_MESSAGES.has(value));

const isExpectedManualChatStopAbort = (strings: string[]): boolean =>
  hasExactString(strings, "AbortError: Fetch is aborted") &&
  includesAny(strings, ["app/hooks/useChatHandlers.ts"]);

const isExpectedAuthRefreshFailure = (strings: string[]): boolean =>
  hasExactString(strings, "Failed to refresh access token") &&
  includesAny(strings, [
    "@workos-inc/authkit-nextjs",
    "convex/dist/esm/browser/sync/authentication_manager.js",
    "lib/auth/shared-token.ts",
    "lib/auth/use-auth-from-authkit.ts",
    "lib/auth/cross-tab-mutex.ts",
  ]);

const isPostHogTransportTimeout = (strings: string[]): boolean =>
  hasExactString(strings, "PostHog request timed out after 3000ms") &&
  includesAny(strings, ["posthog-js/src/request.ts"]);

const isMonacoCancellation = (strings: string[]): boolean =>
  hasExactString(strings, "Canceled") &&
  includesAny(strings, ["monaco-editor@"]);

export function shouldDropExpectedFrontendException(event: PostHogEventLike) {
  if (event.event !== "$exception") {
    return false;
  }

  if (shouldDropExpectedConvexException(event)) {
    return true;
  }

  const strings = collectStrings(event.properties);

  return (
    hasResizeObserverMessage(strings) ||
    isExpectedManualChatStopAbort(strings) ||
    isExpectedAuthRefreshFailure(strings) ||
    isPostHogTransportTimeout(strings) ||
    isMonacoCancellation(strings)
  );
}
