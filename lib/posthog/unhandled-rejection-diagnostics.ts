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
};
type State = {
  owner: string;
  samples: Array<Observation | undefined>;
  next: number;
};
let active: { state: State; stop: () => void } | undefined;

/** Read only built-in event slots and a data descriptor, never reason content. */
function classify(
  event: Event,
  reasonGetter: PropertyDescriptor["get"],
  detailGetter: PropertyDescriptor["get"],
): Pick<Observation, "native" | "wrapper" | "undefinedReason" | "unreadable"> {
  try {
    if (reasonGetter)
      return {
        native: true,
        wrapper: false,
        undefinedReason: reasonGetter.call(event) === undefined,
        unreadable: false,
      };
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
    };
  } catch {
    return {
      native: false,
      wrapper: false,
      undefinedReason: false,
      unreadable: true,
    };
  }
}

/** Observe nearby global dispatches without replacing/canceling SDK handlers. */
export function startUnhandledRejectionDiagnostics(): () => void {
  try {
    const owner = getIdentifiedAnalyticsUserId();
    if (!owner || typeof window === "undefined") return () => {};
    if (active?.state.owner === owner) return () => {};
    active?.stop();
    const state: State = {
      owner,
      samples: new Array(CAPACITY),
      next: 0,
    };
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
    const listener = (event: Event) => {
      try {
        if (
          active?.state !== state ||
          getIdentifiedAnalyticsUserId() !== owner
        ) {
          state.samples.fill(undefined);
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
    const stop = () => {
      try {
        window.removeEventListener("unhandledrejection", listener, true);
      } finally {
        state.samples.fill(undefined);
        if (active?.state === state) active = undefined;
      }
    };
    window.addEventListener("unhandledrejection", listener, {
      capture: true,
      passive: true,
    });
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
