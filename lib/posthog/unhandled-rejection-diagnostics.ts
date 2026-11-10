import { getIdentifiedAnalyticsUserId } from "@/lib/analytics/client";

const WINDOW_MS = 1000;
const CAPACITY = 16;
type Observation = {
  at: number;
  native: boolean;
  wrapper: boolean;
  undefinedReason: boolean;
  unreadable: boolean;
  trusted: boolean | undefined;
  nativeObjectReason: boolean;
};
type ErrorObservation = {
  at: number;
  native: boolean;
  trusted: boolean | undefined;
  source:
    | "same_origin"
    | "extension"
    | "masked"
    | "other"
    | "absent"
    | "unreadable"
    | "unbranded_event";
  position: boolean;
  object: boolean;
  unreadable: boolean;
};
type State = {
  owner: string;
  samples: Array<Observation | undefined>;
  next: number;
  errors: Array<ErrorObservation | undefined>;
  nextError: number;
  errorSupported: boolean;
  rejectionSupported: boolean;
};
let active: { state: State; stop: () => void } | undefined;

/** Read only built-in event slots and a data descriptor, never reason content. */
function classify(
  event: Event,
  reasonGetter: PropertyDescriptor["get"],
  detailGetter: PropertyDescriptor["get"],
): Pick<
  Observation,
  "native" | "wrapper" | "undefinedReason" | "unreadable" | "nativeObjectReason"
> {
  try {
    if (reasonGetter) {
      const reason: unknown = reasonGetter.call(event);
      return {
        native: true,
        wrapper: false,
        undefinedReason: reason === undefined,
        unreadable: false,
        nativeObjectReason:
          reason !== null &&
          (typeof reason === "object" || typeof reason === "function"),
      };
    }
  } catch {
    // A different Event brand is not a native PromiseRejectionEvent.
  }
  try {
    const detail: unknown = detailGetter?.call(event);
    const descriptor =
      detail && typeof detail === "object"
        ? Object.getOwnPropertyDescriptor(detail, "reason")
        : undefined;
    return {
      native: false,
      wrapper: Boolean(descriptor),
      undefinedReason:
        Boolean(descriptor && "value" in descriptor) &&
        descriptor?.value === undefined,
      unreadable: !descriptor || !("value" in descriptor),
      nativeObjectReason: false,
    };
  } catch {
    return {
      native: false,
      wrapper: false,
      undefinedReason: false,
      unreadable: true,
      nativeObjectReason: false,
    };
  }
}

/** Capture a built-in slot without reading event-owned shadow properties. */
function slot(prototype: object | undefined, name: string) {
  try {
    return prototype
      ? Object.getOwnPropertyDescriptor(prototype, name)?.get
      : undefined;
  } catch {
    return undefined;
  }
}

/** Bucket a transient filename, retaining no URL, path, query, or extension ID. */
function sourceCategory(
  filename: unknown,
  origin: string,
): ErrorObservation["source"] {
  if (typeof filename !== "string" || filename.length > 4096)
    return "unreadable";
  if (!filename) return "absent";
  const head = filename.slice(0, 64).toLowerCase();
  if (
    [
      "chrome-extension://",
      "moz-extension://",
      "safari-web-extension://",
      "safari-extension://",
      "ms-browser-extension://",
    ].some((prefix) => head.startsWith(prefix))
  )
    return "extension";
  if (head.startsWith("webkit-masked-url://")) return "masked";
  if (
    origin &&
    origin !== "null" &&
    (filename === origin || filename.startsWith(`${origin}/`))
  )
    return "same_origin";
  return "other";
}

/** Observe native slots only; neither the event's message nor Error is inspected. */
function classifyError(
  event: Event,
  getters: Array<PropertyDescriptor["get"]>,
  origin: string,
): Omit<ErrorObservation, "at" | "trusted"> {
  const empty = {
    native: false,
    source: "unbranded_event" as const,
    position: false,
    object: false,
    unreadable: false,
  };
  let filename: unknown;
  try {
    if (!getters[0]) return empty;
    filename = getters[0].call(event);
  } catch {
    return empty;
  }
  const source = sourceCategory(filename, origin);
  try {
    const line: unknown = getters[1]?.call(event);
    const column: unknown = getters[2]?.call(event);
    const error: unknown = getters[3]?.call(event);
    return {
      native: true,
      source,
      position:
        (typeof line === "number" && Number.isFinite(line) && line > 0) ||
        (typeof column === "number" && Number.isFinite(column) && column > 0),
      object:
        error !== null &&
        (typeof error === "object" || typeof error === "function"),
      unreadable: getters.some((getter) => !getter),
    };
  } catch {
    return { ...empty, native: true, source, unreadable: true };
  }
}

/** Observe nearby global dispatches without replacing/canceling SDK handlers. */
export function startUnhandledRejectionDiagnostics(): () => void {
  try {
    const owner = getIdentifiedAnalyticsUserId();
    if (!owner || typeof window === "undefined") return () => {};
    if (active?.state.owner === owner) return () => {};
    active?.stop();
    const reasonGetter =
      typeof window.PromiseRejectionEvent === "function"
        ? Object.getOwnPropertyDescriptor(
            window.PromiseRejectionEvent.prototype,
            "reason",
          )?.get
        : undefined;
    const detailGetter = Object.getOwnPropertyDescriptor(
      window.CustomEvent.prototype,
      "detail",
    )?.get;
    let errorGetters: Array<PropertyDescriptor["get"]> = [];
    let phaseGetter: PropertyDescriptor["get"];
    let origin = "";
    try {
      phaseGetter = slot(window.Event.prototype, "eventPhase");
      const errorPrototype =
        typeof window.ErrorEvent === "function"
          ? window.ErrorEvent.prototype
          : undefined;
      errorGetters = ["filename", "lineno", "colno", "error"].map((name) =>
        slot(errorPrototype, name),
      );
      origin = window.location.origin;
    } catch {
      /* Optional ErrorEvent support must not disable the existing observer. */
    }
    const state: State = {
      owner,
      samples: new Array(CAPACITY),
      next: 0,
      errors: new Array(CAPACITY),
      nextError: 0,
      errorSupported: Boolean(
        phaseGetter && errorGetters.length === 4 && errorGetters.every(Boolean),
      ),
      rejectionSupported: Boolean(reasonGetter),
    };
    const listener = (event: Event) => {
      try {
        if (
          active?.state !== state ||
          getIdentifiedAnalyticsUserId() !== owner
        ) {
          state.samples.fill(undefined);
          state.errors.fill(undefined);
          return;
        }
        const at = performance.now();
        if (!Number.isFinite(at) || at < 0) return;
        const trusted = event.isTrusted;
        state.samples[state.next] = {
          at,
          ...classify(event, reasonGetter, detailGetter),
          trusted: typeof trusted === "boolean" ? trusted : undefined,
        };
        state.next = (state.next + 1) % CAPACITY;
      } catch {
        // Optional diagnostics cannot interrupt an unhandled exception.
      }
    };
    const errorListener = (event: Event) => {
      try {
        if (
          active?.state !== state ||
          getIdentifiedAnalyticsUserId() !== owner
        ) {
          state.samples.fill(undefined);
          state.errors.fill(undefined);
          return;
        }
        // Window capture also sees element resource errors. Only observe
        // dispatches at the window itself, without reading their target.
        if (phaseGetter?.call(event) !== 2) return;
        const at = performance.now();
        if (!Number.isFinite(at) || at < 0) return;
        const trusted = event.isTrusted;
        state.errors[state.nextError] = {
          at,
          ...classifyError(event, errorGetters, origin),
          trusted: typeof trusted === "boolean" ? trusted : undefined,
        };
        state.nextError = (state.nextError + 1) % CAPACITY;
      } catch {
        /* Optional observation cannot interrupt an error. */
      }
    };
    const stop = () => {
      try {
        window.removeEventListener("unhandledrejection", listener, true);
      } finally {
        try {
          window.removeEventListener("error", errorListener, true);
        } finally {
          state.samples.fill(undefined);
          state.errors.fill(undefined);
          if (active?.state === state) active = undefined;
        }
      }
    };
    window.addEventListener("unhandledrejection", listener, {
      capture: true,
      passive: true,
    });
    try {
      window.addEventListener("error", errorListener, {
        capture: true,
        passive: true,
      });
    } catch {
      state.errorSupported = false;
      try {
        window.removeEventListener("error", errorListener, true);
      } catch {
        /* Preserve existing rejection observation. */
      }
    }
    active = { state, stop };
    return () => {
      if (active?.state !== state) return;
      try {
        stop();
      } catch {
        // Removing diagnostics cannot interrupt provider cleanup.
      }
    };
  } catch {
    return () => {};
  }
}

/** Capped recent context only: these counts never identify an exception's cause. */
export function getUnhandledRejectionDiagnostics(): Record<
  string,
  number | boolean
> {
  try {
    if (!active) return {};
    const { state } = active;
    if (getIdentifiedAnalyticsUserId() !== state.owner) {
      state.samples.fill(undefined);
      state.errors.fill(undefined);
      return {};
    }
    const now = performance.now();
    if (!Number.isFinite(now) || now < 0) return {};
    const recent: Observation[] = [];
    for (let index = 0; index < state.samples.length; index++) {
      const sample = state.samples[index];
      if (!sample) continue;
      const age = now - sample.at;
      if (age < 0 || age >= WINDOW_MS) state.samples[index] = undefined;
      else recent.push(sample);
    }
    return {
      hackerai_recent_rejection_version: 1,
      hackerai_recent_rejection_window_ms: WINDOW_MS,
      hackerai_recent_rejection_count: recent.length,
      hackerai_recent_rejection_at_capacity: recent.length === CAPACITY,
      hackerai_recent_rejection_native_event_count: recent.filter(
        (sample) => sample.native,
      ).length,
      hackerai_recent_rejection_detail_wrapper_count: recent.filter(
        (sample) => sample.wrapper,
      ).length,
      hackerai_recent_rejection_undefined_reason_count: recent.filter(
        (sample) => sample.undefinedReason,
      ).length,
      hackerai_recent_rejection_untrusted_count: recent.filter(
        (sample) => sample.trusted === false,
      ).length,
      hackerai_recent_rejection_unreadable_count: recent.filter(
        (sample) => sample.unreadable,
      ).length,
      hackerai_recent_rejection_trusted_native_undefined_count: recent.filter(
        (sample) => sample.native && sample.undefinedReason && sample.trusted,
      ).length,
    };
  } catch {
    return {};
  }
}

export type NearbyDispatchGroup =
  | "get_head_body_typeerror"
  | "wallet_property_typeerror"
  | "synthetic_stackless_error"
  | "chat_document_short_error"
  | "same_document_short_error"
  | "same_document_stack_overflow"
  | "stackless_dom_exception"
  | "anonymous_missing_identifier_referenceerror"
  | "stackless_end_of_script_syntaxerror"
  | "stackless_unexpected_token_syntaxerror"
  | "long_generic_error";

/** Prune a bounded ring, including samples made invalid by a clock reset. */
function recentSamples<T extends { at: number }>(
  samples: Array<T | undefined>,
  now: number,
): T[] {
  const recent: T[] = [];
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    if (!sample) continue;
    const age = now - sample.at;
    if (age < 0 || age >= WINDOW_MS) samples[index] = undefined;
    else recent.push(sample);
  }
  return recent;
}

/** Preserve write order even when several dispatches share a clock timestamp. */
function latestSample<T>(
  samples: Array<T | undefined>,
  next: number,
): T | undefined {
  for (let offset = 1; offset <= samples.length; offset++) {
    const sample = samples[(next - offset + samples.length) % samples.length];
    if (sample) return sample;
  }
}

const ageBucket = (sample: { at: number } | undefined, now: number) =>
  !sample
    ? "none"
    : now - sample.at < 50
      ? "lt_50ms"
      : now - sample.at < 250
        ? "lt_250ms"
        : "lt_1000ms";

/** Nearby dispatch context only: supported SDK APIs expose no original Error link. */
export function getNearbyDispatchDiagnostics(
  group: NearbyDispatchGroup,
): Record<string, string | number | boolean> {
  try {
    if (
      ![
        "get_head_body_typeerror",
        "wallet_property_typeerror",
        "synthetic_stackless_error",
        "chat_document_short_error",
        "same_document_short_error",
        "same_document_stack_overflow",
        "stackless_dom_exception",
        "anonymous_missing_identifier_referenceerror",
        "stackless_end_of_script_syntaxerror",
        "stackless_unexpected_token_syntaxerror",
        "long_generic_error",
      ].includes(group) ||
      !active
    )
      return {};
    const { state } = active;
    if (getIdentifiedAnalyticsUserId() !== state.owner) {
      state.samples.fill(undefined);
      state.errors.fill(undefined);
      return {};
    }
    const now = performance.now();
    if (!Number.isFinite(now) || now < 0) return {};
    const errors = recentSamples(state.errors, now);
    const rejections = recentSamples(state.samples, now);
    const latest = latestSample(state.errors, state.nextError);
    return {
      hackerai_nearby_dispatch_version: 1,
      hackerai_nearby_dispatch_window_ms: WINDOW_MS,
      hackerai_nearby_dispatch_association: "nearby_only",
      hackerai_nearby_dispatch_group: group,
      hackerai_nearby_dispatch_error_event_supported: state.errorSupported,
      hackerai_nearby_dispatch_rejection_event_supported:
        state.rejectionSupported,
      hackerai_nearby_dispatch_error_count: errors.length,
      hackerai_nearby_dispatch_error_native_count: errors.filter(
        (s) => s.native,
      ).length,
      hackerai_nearby_dispatch_error_trusted_native_count: errors.filter(
        (s) => s.native && s.trusted,
      ).length,
      hackerai_nearby_dispatch_error_untrusted_count: errors.filter(
        (s) => s.trusted === false,
      ).length,
      hackerai_nearby_dispatch_error_at_capacity: errors.length === CAPACITY,
      hackerai_nearby_dispatch_error_latest_source: latest?.source ?? "none",
      hackerai_nearby_dispatch_error_latest_position: latest?.position ?? false,
      hackerai_nearby_dispatch_error_latest_object: latest?.object ?? false,
      hackerai_nearby_dispatch_error_latest_unreadable:
        latest?.unreadable ?? false,
      hackerai_nearby_dispatch_error_latest_age: ageBucket(latest, now),
      hackerai_nearby_dispatch_rejection_count: rejections.length,
      hackerai_nearby_dispatch_rejection_native_count: rejections.filter(
        (s) => s.native,
      ).length,
      hackerai_nearby_dispatch_rejection_trusted_native_count:
        rejections.filter((s) => s.native && s.trusted).length,
      hackerai_nearby_dispatch_rejection_native_object_reason_count:
        rejections.filter((s) => s.nativeObjectReason).length,
      hackerai_nearby_dispatch_rejection_at_capacity:
        rejections.length === CAPACITY,
      hackerai_nearby_dispatch_rejection_latest_age: ageBucket(
        latestSample(state.samples, state.next),
        now,
      ),
    };
  } catch {
    return {};
  }
}
