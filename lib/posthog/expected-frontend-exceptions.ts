import { shouldDropExpectedConvexException } from "@/lib/posthog/expected-convex-errors";

type PostHogEventLike = {
  event?: string;
  properties?: Record<string, unknown>;
};

const RESIZE_OBSERVER_MESSAGES = new Set([
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
]);

const MANUAL_CHAT_STOP_ABORT_MESSAGES = new Set([
  "AbortError: Fetch is aborted",
  "AbortError: signal is aborted without reason",
]);

const REACT_DOM_MUTATION_MESSAGES = new Set([
  "NotFoundError: Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.",
  "NotFoundError: Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
  "NotFoundError: The object can not be found here.",
]);

const OPAQUE_SYNTHETIC_MESSAGES = new Set([
  "Event captured as exception with keys: isTrusted",
  "'Error' captured as exception with message: 'Aa'",
  "'TypeError' captured as exception with message: 'undefined is not an object (evaluating 'a.J')'",
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

const hasExactStringFrom = (
  strings: string[],
  expected: Set<string>,
): boolean => strings.some((value) => expected.has(value));

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
  hasTriggerStreamCloseMessage(strings);

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
    hasExactStringFrom(strings, MANUAL_CHAT_STOP_ABORT_MESSAGES) ||
    hasExactStringFrom(strings, REACT_DOM_MUTATION_MESSAGES) ||
    hasExactStringFrom(strings, OPAQUE_SYNTHETIC_MESSAGES) ||
    matchesExpectedFrontendPattern(strings) ||
    matchesTriggerStreamClosePattern(strings)
  );
}
