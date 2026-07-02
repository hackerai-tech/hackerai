import { shouldDropExpectedConvexException } from "@/lib/posthog/expected-convex-errors";

type PostHogEventLike = {
  event?: string;
  properties?: Record<string, unknown>;
};

const RESIZE_OBSERVER_MESSAGES = new Set([
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
]);

const TRIGGER_STREAM_CLOSE_MESSAGE_FRAGMENTS = [
  "Failed to execute 'close' on 'ReadableStreamDefaultController': Cannot close an errored readable stream",
  "ReadableStreamDefaultController is not in a state where it can be closed",
  "ReadableStreamDefaultController.close: Cannot close a stream that is already closed.",
];

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

const hasTriggerStreamCloseMessage = (strings: string[]): boolean =>
  includesAny(strings, TRIGGER_STREAM_CLOSE_MESSAGE_FRAGMENTS);

type ExpectedFrontendPattern = {
  message: string;
  sourceFragments: string[];
};

const EXPECTED_FRONTEND_PATTERNS: ExpectedFrontendPattern[] = [
  {
    message: "AbortError: Fetch is aborted",
    sourceFragments: ["app/hooks/useChatHandlers.ts"],
  },
  {
    message: "Failed to refresh access token",
    sourceFragments: [
      "@workos-inc/authkit-nextjs",
      "convex/dist/esm/browser/sync/authentication_manager.js",
      "lib/auth/shared-token.ts",
      "lib/auth/use-auth-from-authkit.ts",
      "lib/auth/cross-tab-mutex.ts",
    ],
  },
  {
    message: "PostHog request timed out after 3000ms",
    sourceFragments: ["posthog-js/src/request.ts"],
  },
  {
    message: "Canceled",
    sourceFragments: ["monaco-editor@"],
  },
];

const matchesExpectedFrontendPattern = (strings: string[]): boolean =>
  EXPECTED_FRONTEND_PATTERNS.some(
    ({ message, sourceFragments }) =>
      hasExactString(strings, message) && includesAny(strings, sourceFragments),
  );

const matchesTriggerStreamClosePattern = (strings: string[]): boolean =>
  hasTriggerStreamCloseMessage(strings) &&
  includesAny(strings, [
    "@trigger.dev/core/src/v3/streams/asyncIterableStream.ts",
    "@trigger.dev+core",
  ]);

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
    matchesExpectedFrontendPattern(strings) ||
    matchesTriggerStreamClosePattern(strings)
  );
}
