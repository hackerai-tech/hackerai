import { shouldDropExpectedConvexException } from "@/lib/posthog/expected-convex-errors";

type PostHogEventLike = {
  event?: string;
  properties?: Record<string, unknown>;
};

type FrontendExceptionCategory =
  | "browser_transport"
  | "chunk_load"
  | "react_max_update_depth"
  | "stack_overflow"
  | "auth_refresh"
  | "posthog_transport"
  | "monaco_cancellation"
  | "trigger_stream_close"
  | "react_dom_mutation"
  | "resize_observer"
  | "opaque_browser"
  | "unknown";

const RESIZE_OBSERVER_MESSAGES = new Set([
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
]);

const BROWSER_FETCH_TRANSPORT_MESSAGES = new Set([
  "Failed to fetch",
  "Load failed",
  "NetworkError when attempting to fetch resource.",
  "network error",
  "timeout",
  "connection closed",
  "An unexpected response was received from the server.",
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

const CHUNK_LOAD_MESSAGE_FRAGMENTS = [
  "ChunkLoadError",
  "Failed to load chunk",
  "Loading chunk",
  "error loading dynamically imported module",
  "Importing a module script failed",
  "Failed to fetch dynamically imported module",
];

const REACT_MAX_UPDATE_DEPTH_MESSAGE_FRAGMENT = "Minified React error #185";
const STACK_OVERFLOW_MESSAGE = "Maximum call stack size exceeded.";

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

const collectStackFrameSources = (
  value: unknown,
  sources: string[] = [],
): string[] => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStackFrameSources(item, sources);
    }
    return sources;
  }

  if (!value || typeof value !== "object") {
    return sources;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (
      (key === "source" || key === "filename") &&
      typeof nestedValue === "string"
    ) {
      sources.push(nestedValue);
      continue;
    }

    collectStackFrameSources(nestedValue, sources);
  }

  return sources;
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

const hasBrowserFetchTransportMessage = (strings: string[]): boolean =>
  strings.some((value) => BROWSER_FETCH_TRANSPORT_MESSAGES.has(value));

const hasChunkLoadMessage = (strings: string[]): boolean =>
  includesAny(strings, CHUNK_LOAD_MESSAGE_FRAGMENTS);

const hasTriggerStreamCloseMessage = (strings: string[]): boolean =>
  includesAny(strings, TRIGGER_STREAM_CLOSE_MESSAGE_FRAGMENTS);

const matchesTriggerStreamClosePattern = (strings: string[]): boolean =>
  hasTriggerStreamCloseMessage(strings);

type ExpectedFrontendPattern = {
  message: string;
  sourceFragments: string[];
};

const EXPECTED_FRONTEND_PATTERNS: ExpectedFrontendPattern[] = [
  {
    message: "Failed to refresh access token",
    sourceFragments: [
      "@workos-inc+authkit-nextjs",
      "@workos-inc/authkit-nextjs",
      "src/components/tokenStore.ts",
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

const matchesBareBrowserTransportPattern = (
  strings: string[],
  frameSources: string[],
): boolean =>
  hasBrowserFetchTransportMessage(strings) && frameSources.length === 0;

const getExceptionCategory = (
  strings: string[],
  frameSources: string[],
): FrontendExceptionCategory => {
  if (hasResizeObserverMessage(strings)) return "resize_observer";
  if (hasExactStringFrom(strings, REACT_DOM_MUTATION_MESSAGES)) {
    return "react_dom_mutation";
  }
  if (hasExactStringFrom(strings, OPAQUE_SYNTHETIC_MESSAGES)) {
    return "opaque_browser";
  }
  if (matchesBareBrowserTransportPattern(strings, frameSources)) {
    return "browser_transport";
  }
  if (hasChunkLoadMessage(strings)) return "chunk_load";
  if (matchesTriggerStreamClosePattern(strings)) return "trigger_stream_close";
  if (
    hasExactString(strings, "Failed to refresh access token") &&
    matchesExpectedFrontendPattern(strings)
  ) {
    return "auth_refresh";
  }
  if (
    hasExactString(strings, "PostHog request timed out after 3000ms") &&
    matchesExpectedFrontendPattern(strings)
  ) {
    return "posthog_transport";
  }
  if (
    hasExactString(strings, "Canceled") &&
    matchesExpectedFrontendPattern(strings)
  ) {
    return "monaco_cancellation";
  }
  if (includesAny(strings, [REACT_MAX_UPDATE_DEPTH_MESSAGE_FRAGMENT])) {
    return "react_max_update_depth";
  }
  if (hasExactString(strings, STACK_OVERFLOW_MESSAGE)) return "stack_overflow";
  return "unknown";
};

export function shouldDropExpectedFrontendException(event: PostHogEventLike) {
  if (event.event !== "$exception") {
    return false;
  }

  if (shouldDropExpectedConvexException(event)) {
    return true;
  }

  const strings = collectStrings(event.properties);
  const frameSources = collectStackFrameSources(event.properties);

  return (
    hasResizeObserverMessage(strings) ||
    matchesBareBrowserTransportPattern(strings, frameSources) ||
    hasChunkLoadMessage(strings) ||
    hasExactStringFrom(strings, MANUAL_CHAT_STOP_ABORT_MESSAGES) ||
    hasExactStringFrom(strings, REACT_DOM_MUTATION_MESSAGES) ||
    hasExactStringFrom(strings, OPAQUE_SYNTHETIC_MESSAGES) ||
    matchesExpectedFrontendPattern(strings) ||
    matchesTriggerStreamClosePattern(strings)
  );
}

const getRouteKind = (currentUrl: unknown): string | undefined => {
  if (typeof currentUrl !== "string") return undefined;

  try {
    const { pathname } = new URL(currentUrl, "https://hackerai.co");
    if (pathname === "/") return "home";
    if (pathname.startsWith("/c/")) return "chat";
    if (pathname.startsWith("/share/")) return "share";
    if (pathname.startsWith("/download")) return "download";
    if (pathname.startsWith("/auth-error")) return "auth";
    return "other";
  } catch {
    return undefined;
  }
};

function getBrowserNetworkDetails() {
  if (typeof navigator === "undefined") return {};

  const connection = (
    navigator as Navigator & {
      connection?: {
        effectiveType?: string;
        saveData?: boolean;
      };
    }
  ).connection;

  return {
    hackerai_online: navigator.onLine,
    ...(connection?.effectiveType
      ? { hackerai_connection_effective_type: connection.effectiveType }
      : {}),
    ...(typeof connection?.saveData === "boolean"
      ? { hackerai_connection_save_data: connection.saveData }
      : {}),
  };
}

export function enrichFrontendExceptionEvent<T extends PostHogEventLike>(
  event: T,
): T {
  if (event.event !== "$exception") return event;

  const properties = event.properties ?? {};
  const strings = collectStrings(properties);
  const frameSources = collectStackFrameSources(properties);
  const category = getExceptionCategory(strings, frameSources);

  event.properties = {
    ...properties,
    hackerai_exception_category: category,
    ...(getRouteKind(properties.$current_url)
      ? { hackerai_route_kind: getRouteKind(properties.$current_url) }
      : {}),
    ...(typeof document !== "undefined"
      ? { hackerai_visibility_state: document.visibilityState }
      : {}),
    ...getBrowserNetworkDetails(),
  };

  return event;
}
