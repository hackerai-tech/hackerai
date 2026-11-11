import { shouldDropExpectedConvexException } from "@/lib/posthog/expected-convex-errors";
import { getComposerChangeDiagnostics } from "./composer-change-diagnostics";
import { getRecentMessageTimestampDiagnostics } from "./message-time-diagnostics";
import {
  getUnhandledRejectionDiagnostics,
  getNearbyDispatchDiagnostics,
  type NearbyDispatchGroup,
} from "./unhandled-rejection-diagnostics";

type PostHogEventLike = {
  event?: string;
  properties?: Record<string, unknown>;
};

type FrontendExceptionCategory =
  "react_max_update_depth" | "stack_overflow" | "unknown";

const RESIZE_OBSERVER_MESSAGES = new Set([
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
]);

const BROWSER_FETCH_TRANSPORT_MESSAGES = new Set([
  "Failed to fetch",
  "Load failed",
  "NetworkError when attempting to fetch resource.",
  "network error",
  "Error in input stream",
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
  "NotFoundError: Node.removeChild: The node to be removed is not a child of this node",
  "NotFoundError: The object can not be found here.",
]);

const OPAQUE_SYNTHETIC_MESSAGES = new Set([
  "Event captured as exception with keys: isTrusted",
  "'Error' captured as exception with message: 'Aa'",
  "'TypeError' captured as exception with message: 'undefined is not an object (evaluating 'a.J')'",
  "'Error' captured as exception with message: 'Invalid call to runtime.sendMessage(). Tab not found.'",
  "Cannot read properties of undefined (reading 'CoinType')",
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

const NEXT_SERVER_ACTION_SOURCE_FRAGMENTS = [
  "next/src/client/components/router-reducer/reducers/server-action-reducer.ts",
  "next/src/client/components/segment-cache/fetch.ts",
  "/docs/messages/failed-to-find-server-action",
];

const NEXT_GENERATED_CHUNK_SOURCE_PATTERN =
  /^(?:https?:\/\/[^/]+)?\/_next\/static\/(?:immutable\/)?chunks\/[^?\s]+\.js(?:\?[^#\s]*)?(?::\d+){0,2}$/i;
const VERCEL_DEPLOYMENT_ID_PATTERN = /[?&]dpl=(dpl_[A-Za-z0-9]+)/;

const INJECTED_THIRD_PARTY_SOURCE_PREFIXES = [
  "chrome-extension://",
  "moz-extension://",
  "safari-web-extension://",
  "ms-browser-extension://",
  "iabjs://",
];

const STALE_SERVER_ACTION_MESSAGE_FRAGMENTS = [
  "Failed to find Server Action",
  "was not found on the server",
  "failed-to-find-server-action",
  "older or newer deployment",
];

const REACT_MAX_UPDATE_DEPTH_MESSAGE_FRAGMENT = "Minified React error #185";
const STACK_OVERFLOW_MESSAGES = new Set([
  "Maximum call stack size exceeded",
  "Maximum call stack size exceeded.",
  "too much recursion",
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

const hasStaleServerActionMessage = (strings: string[]): boolean =>
  includesAny(strings, STALE_SERVER_ACTION_MESSAGE_FRAGMENTS);

const isExpectedNextServerActionFrame = (source: string): boolean =>
  NEXT_SERVER_ACTION_SOURCE_FRAGMENTS.some((fragment) =>
    source.includes(fragment),
  ) || NEXT_GENERATED_CHUNK_SOURCE_PATTERN.test(source);

const hasOnlyInjectedThirdPartyFrames = (frameSources: string[]): boolean =>
  frameSources.length > 0 &&
  frameSources.every((source) =>
    INJECTED_THIRD_PARTY_SOURCE_PREFIXES.some((prefix) =>
      source.toLowerCase().startsWith(prefix),
    ),
  );

const hasOnlyExpectedNextServerActionFrames = (
  frameSources: string[],
): boolean =>
  frameSources.length > 0 &&
  frameSources.every(isExpectedNextServerActionFrame);

const hasStackOverflowMessage = (strings: string[]): boolean =>
  hasExactStringFrom(strings, STACK_OVERFLOW_MESSAGES);

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

const matchesNextServerActionTransportPattern = (
  strings: string[],
  frameSources: string[],
): boolean =>
  hasBrowserFetchTransportMessage(strings) &&
  hasOnlyExpectedNextServerActionFrames(frameSources);

const matchesStaleServerActionPattern = (
  strings: string[],
  frameSources: string[],
): boolean =>
  hasStaleServerActionMessage(strings) &&
  (frameSources.length === 0 ||
    hasOnlyExpectedNextServerActionFrames(frameSources));

const getExceptionCategory = (strings: string[]): FrontendExceptionCategory => {
  if (includesAny(strings, [REACT_MAX_UPDATE_DEPTH_MESSAGE_FRAGMENT])) {
    return "react_max_update_depth";
  }
  if (hasStackOverflowMessage(strings)) return "stack_overflow";
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
    matchesNextServerActionTransportPattern(strings, frameSources) ||
    matchesStaleServerActionPattern(strings, frameSources) ||
    hasOnlyInjectedThirdPartyFrames(frameSources) ||
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

const stripUrlQueryAndFragment = (value: string): string => {
  const queryIndex = value.indexOf("?");
  const fragmentIndex = value.indexOf("#");
  const firstSensitiveIndex =
    queryIndex === -1
      ? fragmentIndex
      : fragmentIndex === -1
        ? queryIndex
        : Math.min(queryIndex, fragmentIndex);

  return firstSensitiveIndex === -1
    ? value
    : value.slice(0, firstSensitiveIndex);
};

export function sanitizeFrontendExceptionUrlProperties<
  T extends PostHogEventLike,
>(event: T): T {
  if (event.event !== "$exception" || !event.properties) return event;

  const currentUrl = event.properties.$current_url;
  const referrer = event.properties.$referrer;
  event.properties = {
    ...event.properties,
    ...(typeof currentUrl === "string"
      ? { $current_url: stripUrlQueryAndFragment(currentUrl) }
      : {}),
    ...(typeof referrer === "string"
      ? { $referrer: stripUrlQueryAndFragment(referrer) }
      : {}),
  };

  return event;
}

const getDeploymentIdFromFrameSources = (
  frameSources: string[],
): string | undefined => {
  for (const source of frameSources) {
    const match = source.match(VERCEL_DEPLOYMENT_ID_PATTERN);
    if (match?.[1]) return match[1];
  }
  return undefined;
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

/** Match the SDK's unhandled non-Error shape without trusting its synthetic flag. */
function isSdkNonErrorUnhandledRejection(properties: Record<string, unknown>) {
  const list = properties.$exception_list;
  if (!Array.isArray(list) || list.length !== 1) return false;
  const exception = list[0];
  return (
    exception?.type === "UnhandledRejection" &&
    typeof exception?.value === "string" &&
    exception.value.startsWith(
      "Non-Error promise rejection captured with value: ",
    ) &&
    exception?.mechanism?.handled === false
  );
}

/** Narrow retained shapes needing native context; this never suppresses an error. */
function nearbyDispatchGroup(
  properties: Record<string, unknown>,
): NearbyDispatchGroup | undefined {
  try {
    const list = properties.$exception_list;
    if (!Array.isArray(list) || list.length !== 1) return undefined;
    const exception = list[0];
    if (
      exception?.mechanism?.handled !== false ||
      typeof exception.value !== "string"
    )
      return undefined;
    if (
      exception.type === "TypeError" &&
      exception.value.includes("Request with GET/HEAD method cannot have body")
    )
      return "get_head_body_typeerror";
    if (
      exception.type === "TypeError" &&
      ["ethereum", "selectedAddress", "undefined"].every((part) =>
        exception.value.includes(part),
      )
    )
      return "wallet_property_typeerror";
    const frames = exception.stacktrace?.frames;
    if (
      exception.type === "ReferenceError" &&
      exception.mechanism.synthetic === false &&
      exception.mechanism.type === "generic" &&
      exception.value.length <= 128 &&
      /^[A-Za-z_$][\w$]{0,63} is not defined$/.test(exception.value) &&
      Array.isArray(frames) &&
      frames.length === 2 &&
      [frames[0], frames[1]].every(
        (frame) => frame?.filename === "<anonymous>" && frame?.in_app === false,
      )
    )
      return "anonymous_missing_identifier_referenceerror";
    if (
      exception.type === "Error" &&
      exception.mechanism.synthetic === true &&
      (frames === undefined || (Array.isArray(frames) && frames.length === 0))
    )
      return "synthetic_stackless_error";
    if (
      exception.type === "Error" &&
      exception.value.length === 2 &&
      exception.mechanism.synthetic === false &&
      exception.mechanism.type === "generic" &&
      typeof properties.$current_url === "string" &&
      properties.$current_url.length <= 4096 &&
      Array.isArray(frames) &&
      frames.length === 3
    ) {
      const current = new URL(properties.$current_url);
      const chatDocumentPath = /^\/c\/[A-Za-z0-9_-]{1,128}\/?$/;
      if (
        current.protocol === "https:" &&
        !current.username &&
        !current.password &&
        chatDocumentPath.test(current.pathname) &&
        frames.every(
          /** Interpret filenames transiently; stored source and in_app do not prove authorship. */
          (frame) => {
            if (
              typeof frame?.filename !== "string" ||
              frame.filename.length > 4096
            )
              return false;
            const source = new URL(frame.filename);
            return (
              source.origin === current.origin &&
              !source.username &&
              !source.password &&
              chatDocumentPath.test(source.pathname) &&
              source.pathname.replace(/\/$/, "") !==
                current.pathname.replace(/\/$/, "")
            );
          },
        )
      )
        return "chat_document_short_error";
      if (
        current.protocol === "https:" &&
        !current.username &&
        !current.password &&
        frames.every(
          /** Compare transient URLs exactly; never export their paths or infer authorship. */
          (frame) => {
            if (
              typeof frame?.filename !== "string" ||
              frame.filename.length > 4096
            )
              return false;
            const source = new URL(frame.filename);
            return (
              source.origin === current.origin &&
              !source.username &&
              !source.password &&
              source.pathname === current.pathname
            );
          },
        )
      )
        return "same_document_short_error";
    }
    // Reuse native context only for the observed retained five-to-seven-frame shape.
    if (
      exception.type === "RangeError" &&
      exception.value === "Maximum call stack size exceeded." &&
      exception.mechanism.synthetic === false &&
      exception.mechanism.type === "generic" &&
      typeof properties.$current_url === "string" &&
      properties.$current_url.length <= 4096 &&
      Array.isArray(frames) &&
      frames.length >= 5 &&
      frames.length <= 7
    ) {
      const current = new URL(properties.$current_url);
      if (
        current.protocol === "https:" &&
        !current.username &&
        !current.password &&
        Array.from(frames).every((frame) => {
          // Only compare bounded SDK filenames transiently; never export paths
          // or infer script authorship from a document URL or resolved source.
          if (
            typeof frame?.filename !== "string" ||
            frame.filename.length > 4096
          )
            return false;
          const source = new URL(frame.filename);
          return (
            source.origin === current.origin &&
            !source.username &&
            !source.password &&
            source.pathname === current.pathname
          );
        })
      )
        return "same_document_stack_overflow";
    }
    if (
      exception.type === "DOMException" &&
      exception.mechanism.synthetic === false &&
      exception.mechanism.type === "generic" &&
      exception.value.length <= 256 &&
      (frames === undefined || (Array.isArray(frames) && frames.length === 0))
    )
      return "stackless_dom_exception";
    if (
      exception.type === "SyntaxError" &&
      exception.mechanism.synthetic === false &&
      exception.mechanism.type === "generic" &&
      (frames === undefined || (Array.isArray(frames) && frames.length === 0))
    ) {
      if (exception.value === "Unexpected end of script")
        return "stackless_end_of_script_syntaxerror";
      if (
        exception.value.length <= 256 &&
        /Unexpected token/i.test(exception.value)
      )
        return "stackless_unexpected_token_syntaxerror";
    }
    if (
      exception.type === "Error" &&
      exception.mechanism.synthetic === false &&
      exception.mechanism.type === "generic" &&
      // Coarse UTF-16 units, never an exact stored-byte or frame-source match.
      exception.value.length > 256 &&
      exception.value.length <= 4096
    )
      return "long_generic_error";
  } catch {
    /* Optional attribution cannot change the retained exception. */
  }
}

/** Enrich retained exceptions with bounded build and recent-context diagnostics. */
export function enrichFrontendExceptionEvent<T extends PostHogEventLike>(
  event: T,
): T {
  if (event.event !== "$exception") return event;

  const properties = { ...event.properties };
  // Reprocessing an event must not carry another account's old observation.
  for (const key of Object.keys(properties)) {
    if (
      key.startsWith("hackerai_recent_rejection_") ||
      key.startsWith("hackerai_recent_formatter_") ||
      key.startsWith("hackerai_nearby_dispatch_")
    )
      delete properties[key];
  }
  const strings = collectStrings(properties);
  const frameSources = collectStackFrameSources(properties);
  const category = getExceptionCategory(strings);
  const routeKind = getRouteKind(properties.$current_url);
  const deploymentId = getDeploymentIdFromFrameSources(frameSources);
  const buildCommit = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
  const dispatchGroup = nearbyDispatchGroup(properties);

  event.properties = {
    ...properties,
    hackerai_exception_category: category,
    ...(category === "stack_overflow"
      ? getRecentMessageTimestampDiagnostics()
      : {}),
    ...(category === "react_max_update_depth"
      ? getComposerChangeDiagnostics()
      : {}),
    ...(isSdkNonErrorUnhandledRejection(properties)
      ? getUnhandledRejectionDiagnostics()
      : {}),
    ...(dispatchGroup ? getNearbyDispatchDiagnostics(dispatchGroup) : {}),
    ...(buildCommit && /^[a-f0-9]{40}$/i.test(buildCommit)
      ? { hackerai_exception_build_commit: buildCommit.toLowerCase() }
      : {}),
    ...(routeKind ? { hackerai_route_kind: routeKind } : {}),
    ...(deploymentId ? { hackerai_exception_deployment_id: deploymentId } : {}),
    ...(typeof document !== "undefined"
      ? { hackerai_visibility_state: document.visibilityState }
      : {}),
    ...getBrowserNetworkDetails(),
  };

  return event;
}
