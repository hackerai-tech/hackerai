import { getIdentifiedAnalyticsUserId } from "@/lib/analytics/client";
import {
  startUnhandledRejectionDiagnostics,
  getUnhandledRejectionDiagnostics,
} from "../unhandled-rejection-diagnostics";
import {
  enrichFrontendExceptionEvent,
  shouldDropExpectedFrontendException,
  sanitizeFrontendExceptionUrlProperties,
} from "../expected-frontend-exceptions";

jest.mock("@/lib/analytics/client", () => ({
  getIdentifiedAnalyticsUserId: jest.fn(),
}));
const identity = jest.mocked(getIdentifiedAnalyticsUserId);
let stop: () => void;
let now = 10000;
const entry = () => ({
  type: "Error",
  value: "private-message-canary",
  mechanism: { handled: false, synthetic: true, type: "generic" },
  stacktrace: { frames: [] as unknown[] },
});
function snapshot(exception: unknown = entry()) {
  const event = enrichFrontendExceptionEvent({
    event: "$exception",
    properties: { $exception_list: [exception] },
  });
  return Object.fromEntries(
    Object.entries(event.properties).filter(([key]) =>
      key.startsWith("hackerai_nearby_dispatch_"),
    ),
  );
}
const longErrorEntry = (value = "x".repeat(1108)) => ({
  type: "Error",
  value,
  mechanism: { handled: false, synthetic: false, type: "generic" },
  // Owned fixture only; stored resolved frames do not reconstruct client frames.
  stacktrace: {
    frames: [{ filename: "PRIVATE-fixture-source?token=canary", in_app: true }],
  },
});

it("retains long generic Errors with private-safe nearby dispatch context and owner fencing", () => {
  const dispatched = new ErrorEvent("error", {
    message: "PRIVATE native message",
    filename: `${location.origin}/PRIVATE-source?token=canary`,
    error: new Error("PRIVATE error object"),
    cancelable: true,
  });
  window.dispatchEvent(dispatched);
  const exception = longErrorEntry("PRIVATE-".repeat(140));
  const list = [exception];
  const event = { event: "$exception", properties: { $exception_list: list } };
  expect(shouldDropExpectedFrontendException(event)).toBe(false);
  const enriched = enrichFrontendExceptionEvent(event);
  expect(enriched.properties.$exception_list).toBe(list);
  expect(shouldDropExpectedFrontendException(enriched)).toBe(false);
  const context = snapshot(exception);
  expect(context).toMatchObject({
    hackerai_nearby_dispatch_group: "long_generic_error",
    hackerai_nearby_dispatch_association: "nearby_only",
    hackerai_nearby_dispatch_error_native_count: 1,
    hackerai_nearby_dispatch_error_untrusted_count: 1,
    hackerai_nearby_dispatch_error_trusted_native_count: 0,
    hackerai_nearby_dispatch_error_latest_source: "same_origin",
    hackerai_nearby_dispatch_error_latest_object: true,
  });
  expect(JSON.stringify(context)).not.toMatch(/PRIVATE|canary|token=/);
  expect(dispatched.defaultPrevented).toBe(false);
  identity.mockReturnValue("another-owner");
  expect(snapshot(exception)).toEqual({});
});

it.each([
  ["lower included bound", "x".repeat(257)],
  ["upper included bound", "x".repeat(4096)],
  ["1108 UTF8 bytes of BMP text", "界".repeat(369) + "x"],
  ["1108 UTF8 bytes of astral text", "🚀".repeat(277)],
])(
  "observes long Error %s without requiring a particular client stack",
  (_, value) => {
    const exception = longErrorEntry(value);
    Reflect.deleteProperty(exception, "stacktrace");
    expect(snapshot(exception).hackerai_nearby_dispatch_group).toBe(
      "long_generic_error",
    );
  },
);

it.each([256, 4097])(
  "does not widen long Error context to %i code units",
  (length) => {
    expect(snapshot(longErrorEntry("x".repeat(length)))).toEqual({});
  },
);

it("keeps the long Error selector scoped to one retained generic nonsynthetic error", () => {
  const exception = longErrorEntry();
  for (const candidate of [
    { ...exception, type: "TypeError" },
    { ...exception, type: "DOMException" },
    { ...exception, mechanism: { ...exception.mechanism, handled: true } },
    { ...exception, mechanism: { ...exception.mechanism, synthetic: true } },
    { ...exception, mechanism: { handled: false, type: "generic" } },
    { ...exception, mechanism: { ...exception.mechanism, type: "onerror" } },
    { ...exception, value: undefined },
  ])
    expect(snapshot(candidate)).toEqual({});
  expect(
    enrichFrontendExceptionEvent({
      event: "$exception",
      properties: { $exception_list: [exception, exception] },
    }).properties,
  ).not.toHaveProperty("hackerai_nearby_dispatch_group");
  expect(
    snapshot({
      ...exception,
      mechanism: { ...exception.mechanism, synthetic: true },
      stacktrace: { frames: [] },
    }).hackerai_nearby_dispatch_group,
  ).toBe("synthetic_stackless_error");
});
beforeEach(() => {
  identity.mockReturnValue("fixture-owner");
  now = 10000;
  jest.spyOn(performance, "now").mockImplementation(() => now);
  stop = startUnhandledRejectionDiagnostics();
});
afterEach(() => {
  stop();
  jest.restoreAllMocks();
});

it("exports only nearby finite native event context without inspecting private Error contents", () => {
  const trap = jest.fn();
  const error = new Proxy(
    {},
    {
      get: () => {
        trap("get");
        return undefined;
      },
      getPrototypeOf: () => {
        trap("prototype");
        return null;
      },
      ownKeys: () => {
        trap("keys");
        return [];
      },
    },
  );
  const event = new ErrorEvent("error", {
    message: "private-message-canary",
    filename: `${location.origin}/private-path?token=canary`,
    error,
    lineno: 12,
    colno: 4,
    cancelable: true,
  });
  window.dispatchEvent(event);
  const context = snapshot();
  expect(context).toMatchObject({
    hackerai_nearby_dispatch_version: 1,
    hackerai_nearby_dispatch_association: "nearby_only",
    hackerai_nearby_dispatch_group: "synthetic_stackless_error",
    hackerai_nearby_dispatch_error_count: 1,
    hackerai_nearby_dispatch_error_native_count: 1,
    hackerai_nearby_dispatch_error_untrusted_count: 1,
    hackerai_nearby_dispatch_error_trusted_native_count: 0,
    hackerai_nearby_dispatch_error_latest_source: "same_origin",
    hackerai_nearby_dispatch_error_latest_position: true,
    hackerai_nearby_dispatch_error_latest_object: true,
    hackerai_nearby_dispatch_error_latest_age: "lt_50ms",
  });
  expect(trap).not.toHaveBeenCalled();
  expect(JSON.stringify(context)).not.toMatch(/private|canary|token/);
  const allowed = new Set(
    [
      "version",
      "window_ms",
      "association",
      "group",
      "error_event_supported",
      "rejection_event_supported",
      "error_count",
      "error_native_count",
      "error_trusted_native_count",
      "error_untrusted_count",
      "error_at_capacity",
      "error_latest_source",
      "error_latest_position",
      "error_latest_object",
      "error_latest_unreadable",
      "error_latest_age",
      "rejection_count",
      "rejection_native_count",
      "rejection_trusted_native_count",
      "rejection_native_object_reason_count",
      "rejection_at_capacity",
      "rejection_latest_age",
    ].map((key) => `hackerai_nearby_dispatch_${key}`),
  );
  expect(Object.keys(context).every((key) => allowed.has(key))).toBe(true);
  expect(
    Object.values(context).every((value) =>
      ["string", "number", "boolean"].includes(typeof value),
    ),
  ).toBe(true);
  expect(event.defaultPrevented).toBe(false);
});

it("excludes element resource-load errors while distinguishing foreign window dispatches", () => {
  const img = document.createElement("img");
  document.body.append(img);
  img.dispatchEvent(new Event("error"));
  img.remove();
  window.dispatchEvent(new Event("error"));
  expect(snapshot()).toMatchObject({
    hackerai_nearby_dispatch_error_count: 1,
    hackerai_nearby_dispatch_error_native_count: 0,
    hackerai_nearby_dispatch_error_latest_source: "unbranded_event",
  });
});

it.each([
  ["", "absent"],
  [`${location.origin}.evil.test/private`, "other"],
  ["CHROME-EXTENSION://private-extension/private-path", "extension"],
  ["webkit-masked-url://private-path", "masked"],
  ["https://other.invalid/private?secret=canary", "other"],
  ["x".repeat(4097), "unreadable"],
])("buckets a filename without retaining it (%s)", (filename, source) => {
  window.dispatchEvent(new ErrorEvent("error", { filename }));
  const context = snapshot();
  expect(context.hackerai_nearby_dispatch_error_latest_source).toBe(source);
  expect(JSON.stringify(context)).not.toMatch(/private|canary|evil\.test/);
});

it("bounds independent rings and preserves latest write order at equal timestamps", () => {
  for (let n = 0; n < 16; n++)
    window.dispatchEvent(
      new CustomEvent("unhandledrejection", { detail: { reason: undefined } }),
    );
  const old = getUnhandledRejectionDiagnostics();
  for (let n = 0; n < 100; n++)
    window.dispatchEvent(
      new ErrorEvent("error", {
        filename:
          n === 99
            ? "chrome-extension://private/path"
            : `${location.origin}/private`,
      }),
    );
  expect(snapshot()).toMatchObject({
    hackerai_nearby_dispatch_error_count: 16,
    hackerai_nearby_dispatch_error_at_capacity: true,
    hackerai_nearby_dispatch_error_latest_source: "extension",
    hackerai_nearby_dispatch_rejection_count: 16,
    hackerai_nearby_dispatch_rejection_at_capacity: true,
  });
  expect(getUnhandledRejectionDiagnostics()).toEqual(old);
});

it("expires context and uses bounded age buckets across clock changes", () => {
  window.dispatchEvent(new ErrorEvent("error"));
  for (const [age, bucket] of [
    [49, "lt_50ms"],
    [50, "lt_250ms"],
    [249, "lt_250ms"],
    [250, "lt_1000ms"],
    [999, "lt_1000ms"],
    [1000, "none"],
  ] as const) {
    now = 10000 + age;
    expect(snapshot().hackerai_nearby_dispatch_error_latest_age).toBe(bucket);
  }
  expect(snapshot().hackerai_nearby_dispatch_error_count).toBe(0);
  window.dispatchEvent(new ErrorEvent("error"));
  now -= 1;
  expect(snapshot().hackerai_nearby_dispatch_error_count).toBe(0);
  now = NaN;
  expect(snapshot()).toEqual({});
  jest.mocked(performance.now).mockImplementation(() => {
    throw new Error("clock unavailable");
  });
  expect(() => window.dispatchEvent(new Event("error"))).not.toThrow();
  expect(snapshot()).toEqual({});
});

it("clears both rings across owner/consent changes and fences stale cleanup", () => {
  window.dispatchEvent(new ErrorEvent("error"));
  window.dispatchEvent(
    new CustomEvent("unhandledrejection", { detail: { reason: undefined } }),
  );
  identity.mockReturnValue(null);
  expect(snapshot()).toEqual({});
  identity.mockReturnValue("fixture-owner");
  expect(snapshot()).toMatchObject({
    hackerai_nearby_dispatch_error_count: 0,
    hackerai_nearby_dispatch_rejection_count: 0,
  });
  identity.mockReturnValue("another-owner");
  const stopNew = startUnhandledRejectionDiagnostics();
  try {
    stop();
    window.dispatchEvent(new ErrorEvent("error"));
    expect(snapshot().hackerai_nearby_dispatch_error_count).toBe(1);
  } finally {
    stopNew();
  }
  expect(snapshot()).toEqual({});
});

it("leaves existing handlers and event cancellation alone, including nested dispatch", () => {
  const previous = window.onerror;
  const handler = jest.fn();
  window.onerror = handler;
  const add = jest.spyOn(window, "addEventListener");
  const remove = jest.spyOn(window, "removeEventListener");
  startUnhandledRejectionDiagnostics()();
  expect(add).not.toHaveBeenCalled();
  let nested = false;
  const listener = () => {
    if (!nested) {
      nested = true;
      window.dispatchEvent(new ErrorEvent("error"));
    }
  };
  window.addEventListener("error", listener);
  try {
    const event = new ErrorEvent("error", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(window.onerror).toBe(handler);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(snapshot().hackerai_nearby_dispatch_error_count).toBe(2);
  } finally {
    window.removeEventListener("error", listener);
    window.onerror = previous;
  }
  stop();
  expect(
    remove.mock.calls.some(
      ([name, , capture]) => name === "error" && capture === true,
    ),
  ).toBe(true);
  expect(
    remove.mock.calls.some(
      ([name, , capture]) => name === "unhandledrejection" && capture === true,
    ),
  ).toBe(true);
});

it("preserves rejection observation if the optional error listener cannot register", () => {
  stop();
  const original = window.addEventListener.bind(window);
  jest
    .spyOn(window, "addEventListener")
    .mockImplementation((name, listener, options) => {
      if (name === "error") throw new Error("listener unavailable");
      original(name, listener, options);
    });
  stop = startUnhandledRejectionDiagnostics();
  window.dispatchEvent(
    new CustomEvent("unhandledrejection", { detail: { reason: undefined } }),
  );
  expect(
    getUnhandledRejectionDiagnostics().hackerai_recent_rejection_count,
  ).toBe(1);
  expect(snapshot().hackerai_nearby_dispatch_error_event_supported).toBe(false);
});

it("keeps legacy diagnostics when optional ErrorEvent setup is unavailable or throws", () => {
  stop();
  const descriptor = Object.getOwnPropertyDescriptor(window, "ErrorEvent");
  try {
    Object.defineProperty(window, "ErrorEvent", {
      configurable: true,
      get: () => {
        throw new Error("unavailable constructor");
      },
    });
    stop = startUnhandledRejectionDiagnostics();
    window.dispatchEvent(
      new CustomEvent("unhandledrejection", { detail: { reason: undefined } }),
    );
    expect(
      getUnhandledRejectionDiagnostics().hackerai_recent_rejection_count,
    ).toBe(1);
    expect(snapshot().hackerai_nearby_dispatch_error_event_supported).toBe(
      false,
    );
  } finally {
    stop();
    if (descriptor) Object.defineProperty(window, "ErrorEvent", descriptor);
    else Reflect.deleteProperty(window, "ErrorEvent");
  }
});

it("reads only a branded rejection slot and never properties of its reason", () => {
  stop();
  const descriptor = Object.getOwnPropertyDescriptor(
    window,
    "PromiseRejectionEvent",
  );
  const reasons = new WeakMap<Event, unknown>();
  // jsdom lacks this browser class. This fixture tests slot use, not browser provenance.
  class RejectionFixture extends Event {
    constructor(reason: unknown) {
      super("unhandledrejection");
      reasons.set(this, reason);
    }
    get reason() {
      if (!reasons.has(this)) throw new TypeError("brand");
      return reasons.get(this);
    }
  }
  const trap = jest.fn();
  const reason = new Proxy(
    {},
    {
      get: () => {
        trap();
        return undefined;
      },
    },
  );
  try {
    Object.defineProperty(window, "PromiseRejectionEvent", {
      configurable: true,
      value: RejectionFixture,
    });
    stop = startUnhandledRejectionDiagnostics();
    window.dispatchEvent(new RejectionFixture(reason));
    window.dispatchEvent(new Event("unhandledrejection"));
    expect(snapshot()).toMatchObject({
      hackerai_nearby_dispatch_rejection_event_supported: true,
      hackerai_nearby_dispatch_rejection_count: 2,
      hackerai_nearby_dispatch_rejection_native_count: 1,
      hackerai_nearby_dispatch_rejection_trusted_native_count: 0,
      hackerai_nearby_dispatch_rejection_native_object_reason_count: 1,
    });
    expect(trap).not.toHaveBeenCalled();
  } finally {
    stop();
    if (descriptor)
      Object.defineProperty(window, "PromiseRejectionEvent", descriptor);
    else Reflect.deleteProperty(window, "PromiseRejectionEvent");
  }
});

it("enriches retained shapes, preserving original exceptions and filtering", () => {
  const cases = [
    entry(),
    {
      ...entry(),
      type: "TypeError",
      value:
        "Failed to construct 'Request': Request with GET/HEAD method cannot have body.",
    },
    {
      ...entry(),
      type: "TypeError",
      value:
        "undefined is not an object (evaluating 'window.ethereum.selectedAddress')",
    },
    {
      type: "SyntaxError",
      value: "Unexpected end of script",
      mechanism: { handled: false, synthetic: false, type: "generic" },
      stacktrace: { frames: [] },
    },
    {
      type: "SyntaxError",
      value: "SyntaxError: Unexpected token",
      mechanism: { handled: false, synthetic: false, type: "generic" },
      stacktrace: { frames: [] },
    },
  ];
  for (const exception of cases) {
    const list = [exception];
    const event = {
      event: "$exception",
      properties: { $exception_list: list },
    };
    const before = shouldDropExpectedFrontendException(event);
    const result = enrichFrontendExceptionEvent(event);
    expect(result.properties.$exception_list).toBe(list);
    expect(shouldDropExpectedFrontendException(result)).toBe(before);
    expect(
      Object.keys(result.properties).some((key) =>
        key.startsWith("hackerai_nearby_dispatch_"),
      ),
    ).toBe(true);
  }
  const negatives = [
    { ...entry(), mechanism: { handled: true, synthetic: true } },
    { ...entry(), mechanism: { handled: false, synthetic: false } },
    { ...entry(), type: "RangeError" },
    { ...entry(), stacktrace: { frames: [{}] } },
    { ...entry(), type: "TypeError", value: "unrelated failure" },
  ];
  for (const exception of negatives) expect(snapshot(exception)).toEqual({});
  const repeated = enrichFrontendExceptionEvent({
    event: "$exception",
    properties: {
      $exception_list: [entry(), entry()],
      hackerai_nearby_dispatch_group: "private-stale",
    },
  });
  expect(
    Object.keys(repeated.properties).some((key) =>
      key.startsWith("hackerai_nearby_dispatch_"),
    ),
  ).toBe(false);
  const captured = enrichFrontendExceptionEvent({
    event: "$exception",
    properties: { $exception_list: [entry()] },
  });
  identity.mockReturnValue(null);
  expect(
    Object.keys(enrichFrontendExceptionEvent(captured).properties).some((key) =>
      key.startsWith("hackerai_nearby_dispatch_"),
    ),
  ).toBe(false);
});

const syntaxEntry = () => ({
  type: "SyntaxError",
  value: "Unexpected end of script",
  mechanism: { handled: false, synthetic: false, type: "generic" },
  stacktrace: { frames: [] as unknown[] },
});

it.each([false, true])(
  "retains a stackless DOMException with private-safe nearby context (frames absent: %s)",
  (absent) => {
    const exception = {
      type: "DOMException",
      value: "PRIVATE retained reason",
      mechanism: { handled: false, synthetic: false, type: "generic" },
      stacktrace: { frames: [] as unknown[] },
    };
    if (absent) Reflect.deleteProperty(exception, "stacktrace");
    const dispatched = new ErrorEvent("error", {
      message: "PRIVATE native reason",
      filename: `${location.origin}/PRIVATE-path?token=canary`,
      error: new DOMException("PRIVATE object reason"),
      cancelable: true,
    });
    window.dispatchEvent(dispatched);
    const list = [exception];
    const event = {
      event: "$exception",
      properties: { $exception_list: list },
    };
    expect(shouldDropExpectedFrontendException(event)).toBe(false);
    const enriched = enrichFrontendExceptionEvent(event);
    expect(enriched.properties.$exception_list).toBe(list);
    expect(shouldDropExpectedFrontendException(enriched)).toBe(false);
    const context = snapshot(exception);
    expect(context).toMatchObject({
      hackerai_nearby_dispatch_version: 1,
      hackerai_nearby_dispatch_group: "stackless_dom_exception",
      hackerai_nearby_dispatch_association: "nearby_only",
      hackerai_nearby_dispatch_error_native_count: 1,
      hackerai_nearby_dispatch_error_untrusted_count: 1,
      hackerai_nearby_dispatch_error_trusted_native_count: 0,
      hackerai_nearby_dispatch_error_latest_source: "same_origin",
      hackerai_nearby_dispatch_error_latest_object: true,
    });
    expect(JSON.stringify(context)).not.toMatch(/PRIVATE|canary|token=/);
    expect(dispatched.defaultPrevented).toBe(false);
    identity.mockReturnValue("another-owner");
    expect(snapshot(exception)).toEqual({});
  },
);

it("limits stackless DOMException context to the retained bounded mechanism", () => {
  const exception = {
    type: "DOMException",
    value: "x".repeat(256),
    mechanism: { handled: false, synthetic: false, type: "generic" },
    stacktrace: { frames: [] as unknown[] },
  };
  expect(snapshot(exception).hackerai_nearby_dispatch_group).toBe(
    "stackless_dom_exception",
  );
  for (const candidate of [
    { ...exception, type: "Error" },
    { ...exception, type: "AbortError" },
    { ...exception, mechanism: { ...exception.mechanism, handled: true } },
    { ...exception, mechanism: { ...exception.mechanism, synthetic: true } },
    { ...exception, mechanism: { handled: false, type: "generic" } },
    { ...exception, mechanism: { ...exception.mechanism, type: "onerror" } },
    { ...exception, value: "x".repeat(257) },
    { ...exception, value: undefined },
    { ...exception, stacktrace: { frames: [{}] } },
    { ...exception, stacktrace: { frames: null } },
  ])
    expect(snapshot(candidate)).toEqual({});
  expect(
    enrichFrontendExceptionEvent({
      event: "$exception",
      properties: { $exception_list: [exception, exception] },
    }).properties,
  ).not.toHaveProperty("hackerai_nearby_dispatch_group");
});

const anonymousReferenceEntry = () => ({
  type: "ReferenceError",
  value: "PRIVATE_identifier is not defined",
  mechanism: { handled: false, synthetic: false, type: "generic" },
  stacktrace: {
    frames: [
      { filename: "<anonymous>", in_app: false },
      { filename: "<anonymous>", in_app: false },
    ],
  },
});

it.each(["same_origin", "absent"])(
  "retains anonymous ReferenceErrors with finite nearby source %s",
  (source) => {
    const dispatched = new ErrorEvent("error", {
      message: "PRIVATE native message",
      filename:
        source === "same_origin"
          ? `${location.origin}/PRIVATE-source?token=canary`
          : "",
      error: new ReferenceError("PRIVATE error"),
      lineno: 5,
      cancelable: true,
    });
    window.dispatchEvent(dispatched);
    const exception = anonymousReferenceEntry();
    const context = snapshot(exception);
    expect(context).toMatchObject({
      hackerai_nearby_dispatch_group:
        "anonymous_missing_identifier_referenceerror",
      hackerai_nearby_dispatch_association: "nearby_only",
      hackerai_nearby_dispatch_error_native_count: 1,
      hackerai_nearby_dispatch_error_untrusted_count: 1,
      hackerai_nearby_dispatch_error_trusted_native_count: 0,
      hackerai_nearby_dispatch_error_latest_source: source,
      hackerai_nearby_dispatch_error_latest_object: true,
    });
    expect(JSON.stringify(context)).not.toMatch(/PRIVATE|canary|token=/);
    expect(dispatched.defaultPrevented).toBe(false);
    const event = {
      event: "$exception",
      properties: { $exception_list: [exception] },
    };
    const enriched = enrichFrontendExceptionEvent(event);
    expect(enriched.properties.$exception_list).toBe(
      event.properties.$exception_list,
    );
    expect(shouldDropExpectedFrontendException(enriched)).toBe(false);
    identity.mockReturnValue("another-owner");
    expect(snapshot(exception)).toEqual({});
  },
);

it("does not extend anonymous ReferenceError attribution to first-party or different error shapes", () => {
  const exception = anonymousReferenceEntry();
  for (const candidate of [
    { ...exception, type: "Error" },
    { ...exception, type: "TypeError" },
    { ...exception, mechanism: { ...exception.mechanism, handled: true } },
    { ...exception, mechanism: { ...exception.mechanism, synthetic: true } },
    { ...exception, mechanism: { handled: false, type: "generic" } },
    { ...exception, mechanism: { ...exception.mechanism, type: "onerror" } },
    { ...exception, value: "PRIVATE property is unavailable" },
    { ...exception, value: "ReferenceError: PRIVATE is not defined" },
    { ...exception, value: "PRIVATE is not defined." },
    { ...exception, value: "\u00e9 is not defined" },
    { ...exception, value: `${"x".repeat(65)} is not defined` },
    { ...exception, value: `${"x".repeat(256)} is not defined` },
    { ...exception, stacktrace: { frames: [] } },
    { ...exception, stacktrace: { frames: [exception.stacktrace.frames[0]] } },
    {
      ...exception,
      stacktrace: {
        frames: [
          ...exception.stacktrace.frames,
          exception.stacktrace.frames[0],
        ],
      },
    },
    { ...exception, stacktrace: { frames: Array(2) } },
    {
      ...exception,
      stacktrace: {
        frames: [
          exception.stacktrace.frames[0],
          { filename: "/_next/static/chunks/app.js", in_app: true },
        ],
      },
    },
    {
      ...exception,
      stacktrace: {
        frames: [{ filename: "<anonymous>" }, exception.stacktrace.frames[1]],
      },
    },
  ])
    expect(snapshot(candidate)).toEqual({});
  expect(
    enrichFrontendExceptionEvent({
      event: "$exception",
      properties: { $exception_list: [exception, exception] },
    }).properties,
  ).not.toHaveProperty("hackerai_nearby_dispatch_group");
});

it.each([false, true])(
  "adds only nearby finite context for the exact retained SyntaxError (frames absent: %s)",
  (absent) => {
    const exception = syntaxEntry();
    if (absent) Reflect.deleteProperty(exception, "stacktrace");
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "Unexpected end of script",
        filename: `${location.origin}/_next/static/chunks/PRIVATE-canary.js?dpl=dpl_PRIVATE`,
        error: new SyntaxError("PRIVATE error"),
        lineno: 7,
        colno: 2,
        cancelable: true,
      }),
    );
    const context = snapshot(exception);
    expect(context).toMatchObject({
      hackerai_nearby_dispatch_group: "stackless_end_of_script_syntaxerror",
      hackerai_nearby_dispatch_association: "nearby_only",
      hackerai_nearby_dispatch_error_latest_source: "same_origin",
    });
    expect(JSON.stringify(context)).not.toMatch(/PRIVATE|canary|dpl_|_next/);
    const event = {
      event: "$exception",
      properties: { $exception_list: [exception] },
    };
    const enriched = enrichFrontendExceptionEvent(event);
    expect(enriched.properties.$exception_list).toBe(
      event.properties.$exception_list,
    );
    expect(shouldDropExpectedFrontendException(event)).toBe(false);
    expect(shouldDropExpectedFrontendException(enriched)).toBe(false);
  },
);

it("keeps near-miss SyntaxErrors out of this specific attribution gate", () => {
  const entry = syntaxEntry();
  const negatives = [
    { ...entry, mechanism: { ...entry.mechanism, handled: true } },
    { ...entry, mechanism: { ...entry.mechanism, synthetic: true } },
    { ...entry, mechanism: { handled: false, type: "generic" } },
    {
      ...entry,
      mechanism: { ...entry.mechanism, type: "onunhandledrejection" },
    },
    { ...entry, stacktrace: { frames: [{}] } },
    { ...entry, type: "Error" },
    ...[
      "Unexpected end of script.",
      "SyntaxError: Unexpected end of script",
      "Unexpected end of input",
      "JSON Parse error: Unexpected EOF",
    ].map((value) => ({ ...entry, value })),
  ];
  for (const exception of negatives) expect(snapshot(exception)).toEqual({});
  expect(
    enrichFrontendExceptionEvent({
      event: "$exception",
      properties: { $exception_list: [entry, entry] },
    }).properties,
  ).not.toHaveProperty("hackerai_nearby_dispatch_group");
});

it.each([false, true])(
  "adds finite nearby context for retained unexpected-token SyntaxErrors (frames absent: %s)",
  (absent) => {
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "PRIVATE browser message",
        filename: `${location.origin}/PRIVATE-path?token=PRIVATE`,
        error: new SyntaxError("PRIVATE error"),
        lineno: 2,
      }),
    );
    for (const value of [
      "Unexpected token 'PRIVATE', PRIVATE response is not valid JSON",
      "SyntaxError: unexpected TOKEN PRIVATE",
    ]) {
      const exception = { ...syntaxEntry(), value };
      if (absent) Reflect.deleteProperty(exception, "stacktrace");
      const context = snapshot(exception);
      expect(context).toMatchObject({
        hackerai_nearby_dispatch_group:
          "stackless_unexpected_token_syntaxerror",
        hackerai_nearby_dispatch_association: "nearby_only",
        hackerai_nearby_dispatch_error_latest_source: "same_origin",
      });
      expect(JSON.stringify(context)).not.toMatch(/PRIVATE|token=|path/);
      const event = {
        event: "$exception",
        properties: { $exception_list: [exception] },
      };
      const enriched = enrichFrontendExceptionEvent(event);
      expect(enriched.properties.$exception_list).toBe(
        event.properties.$exception_list,
      );
      expect(shouldDropExpectedFrontendException(enriched)).toBe(false);
      expect(shouldDropExpectedFrontendException(event)).toBe(false);
    }
  },
);

it("keeps unexpected-token attribution within the retained shape and active owner", () => {
  const exception = {
    ...syntaxEntry(),
    value: "SyntaxError: Unexpected token",
  };
  for (const candidate of [
    { ...exception, mechanism: { ...exception.mechanism, handled: true } },
    { ...exception, mechanism: { ...exception.mechanism, synthetic: true } },
    { ...exception, mechanism: { handled: false, type: "generic" } },
    {
      ...exception,
      mechanism: { ...exception.mechanism, type: "onunhandledrejection" },
    },
    { ...exception, stacktrace: { frames: [{}] } },
    { ...exception, type: "Error" },
    { ...exception, value: "Unexpected identifier PRIVATE" },
    { ...exception, value: `Unexpected token ${"PRIVATE".repeat(40)}` },
  ])
    expect(snapshot(candidate)).toEqual({});
  expect(
    enrichFrontendExceptionEvent({
      event: "$exception",
      properties: { $exception_list: [exception, exception] },
    }).properties,
  ).not.toHaveProperty("hackerai_nearby_dispatch_group");
  const enriched = enrichFrontendExceptionEvent({
    event: "$exception",
    properties: { $exception_list: [exception] },
  });
  identity.mockReturnValue(null);
  expect(
    Object.keys(enrichFrontendExceptionEvent(enriched).properties).some((key) =>
      key.startsWith("hackerai_nearby_dispatch_"),
    ),
  ).toBe(false);
});

const chatDocumentEntry = () => ({
  type: "Error",
  value: "xy",
  mechanism: { handled: false, synthetic: false, type: "generic" },
  stacktrace: {
    frames: ["private-a", "private-b", "private-a"].map((id) => ({
      filename: `https://hackerai.co/c/${id}?private-query#private-fragment`,
      in_app: true,
      lineno: 199,
      colno: 338,
    })),
  },
});

function chatDocumentEvent(exception: unknown = chatDocumentEntry()) {
  return {
    event: "$exception",
    properties: {
      $current_url:
        "https://hackerai.co/c/current?private-query#private-fragment",
      $exception_list: [exception],
    },
  };
}

/** Privacy assertions inspect added metadata without recapturing the retained exception. */
function nearbyProperties(event: { properties: Record<string, unknown> }) {
  return Object.fromEntries(
    Object.entries(event.properties).filter(([key]) =>
      key.startsWith("hackerai_nearby_dispatch_"),
    ),
  );
}

const sameDocumentEntry = (path = "/document") => ({
  type: "Error",
  value: "xy",
  mechanism: { handled: false, synthetic: false, type: "generic" },
  stacktrace: {
    frames: Array.from({ length: 3 }, () => ({
      filename: `https://qa.invalid${path}?PRIVATE-frame#PRIVATE-fragment`,
      in_app: true,
    })),
  },
});

function sameDocumentEvent(exception: unknown = sameDocumentEntry()) {
  return {
    event: "$exception",
    properties: {
      $current_url:
        "https://qa.invalid/document?PRIVATE-query#PRIVATE-fragment",
      $exception_list: [exception],
    },
  };
}

it.each(["/document", "/c/current"])(
  "retains same-document short Errors on %s with bounded private-safe native context",
  (path) => {
    const dispatched = new ErrorEvent("error", {
      filename: `${location.origin}/PRIVATE-source?token=canary`,
      message: "PRIVATE native message",
      error: new Error("PRIVATE error object"),
      cancelable: true,
    });
    window.dispatchEvent(dispatched);
    const event = sameDocumentEvent(sameDocumentEntry(path));
    event.properties.$current_url = `https://qa.invalid${path}?PRIVATE-query`;
    const list = event.properties.$exception_list;
    expect(shouldDropExpectedFrontendException(event)).toBe(false);
    const enriched = enrichFrontendExceptionEvent(
      sanitizeFrontendExceptionUrlProperties(event),
    );
    const context = nearbyProperties(enriched);
    expect(context).toMatchObject({
      hackerai_nearby_dispatch_group: "same_document_short_error",
      hackerai_nearby_dispatch_association: "nearby_only",
      hackerai_nearby_dispatch_error_native_count: 1,
      hackerai_nearby_dispatch_error_untrusted_count: 1,
      hackerai_nearby_dispatch_error_trusted_native_count: 0,
      hackerai_nearby_dispatch_error_latest_source: "same_origin",
      hackerai_nearby_dispatch_error_latest_object: true,
    });
    expect(JSON.stringify(context)).not.toMatch(
      /PRIVATE|canary|qa\.invalid|\/document|token=|xy/,
    );
    expect(enriched.properties.$exception_list).toBe(list);
    expect(shouldDropExpectedFrontendException(enriched)).toBe(false);
    expect(dispatched.defaultPrevented).toBe(false);
    identity.mockReturnValue("another-owner");
    expect(nearbyProperties(enrichFrontendExceptionEvent(enriched))).toEqual(
      {},
    );
  },
);

it("limits same-document context to the retained short singleton mechanism", () => {
  const entry = sameDocumentEntry();
  for (const candidate of [
    { ...entry, value: "x" },
    { ...entry, value: "xyz" },
    { ...entry, type: "TypeError" },
    { ...entry, mechanism: { ...entry.mechanism, handled: true } },
    { ...entry, mechanism: { ...entry.mechanism, synthetic: true } },
    { ...entry, mechanism: { handled: false, type: "generic" } },
    { ...entry, mechanism: { ...entry.mechanism, type: "other" } },
    { ...entry, stacktrace: { frames: entry.stacktrace.frames.slice(0, 2) } },
    {
      ...entry,
      stacktrace: {
        frames: [...entry.stacktrace.frames, entry.stacktrace.frames[0]],
      },
    },
    {
      ...entry,
      stacktrace: {
        frames: entry.stacktrace.frames.map(({ filename }) => ({
          source: filename,
        })),
      },
    },
  ])
    expect(
      nearbyProperties(
        enrichFrontendExceptionEvent(sameDocumentEvent(candidate)),
      ),
    ).toEqual({});
  const event = sameDocumentEvent();
  event.properties.$exception_list.push(entry);
  expect(nearbyProperties(enrichFrontendExceptionEvent(event))).toEqual({});
});

it.each([
  "https://other.invalid/document",
  "https://qa.invalid.other.example/document",
  "https://qa.invalid:444/document",
  "http://qa.invalid/document",
  "https://PRIVATE-user@qa.invalid/document",
  "https://qa.invalid/document/",
  "https://qa.invalid/other-document",
  "https://qa.invalid/_next/static/chunks/PRIVATE.js",
  `https://qa.invalid/${"x".repeat(4096)}`,
  "<anonymous>",
])("rejects a mismatched or unsafe same-document filename %s", (filename) => {
  const entry = sameDocumentEntry();
  entry.stacktrace.frames[0].filename = filename;
  expect(
    nearbyProperties(enrichFrontendExceptionEvent(sameDocumentEvent(entry))),
  ).toEqual({});
});

it.each([
  undefined,
  "not a URL",
  "http://qa.invalid/document",
  "https://PRIVATE-user@qa.invalid/document",
  `https://qa.invalid/${"x".repeat(4096)}`,
])("rejects an unsafe current document %s", (current) => {
  const event = sameDocumentEvent();
  expect(
    nearbyProperties(
      enrichFrontendExceptionEvent({
        ...event,
        properties: { ...event.properties, $current_url: current },
      }),
    ),
  ).toEqual({});
});

it("reuses nearby native context for short errors with other chat-document frames", () => {
  window.dispatchEvent(
    new ErrorEvent("error", {
      filename: `${location.origin}/private-error-source?private-token`,
      error: new Error("private-error-message"),
      lineno: 12,
      colno: 4,
    }),
  );
  const event = chatDocumentEvent();
  const exceptions = event.properties.$exception_list;
  expect(shouldDropExpectedFrontendException(event)).toBe(false);
  const enriched = enrichFrontendExceptionEvent(
    sanitizeFrontendExceptionUrlProperties(event),
  );
  const context = nearbyProperties(enriched);
  expect(context).toMatchObject({
    hackerai_nearby_dispatch_version: 1,
    hackerai_nearby_dispatch_group: "chat_document_short_error",
    hackerai_nearby_dispatch_association: "nearby_only",
    hackerai_nearby_dispatch_error_count: 1,
    hackerai_nearby_dispatch_error_native_count: 1,
    hackerai_nearby_dispatch_error_untrusted_count: 1,
    hackerai_nearby_dispatch_error_trusted_native_count: 0,
  });
  expect(JSON.stringify(context)).not.toMatch(/private|hackerai\.co|\/c\/|xy/);
  expect(enriched.properties.$exception_list).toBe(exceptions);
  expect(shouldDropExpectedFrontendException(enriched)).toBe(false);
  identity.mockReturnValue("another-owner");
  expect(nearbyProperties(enrichFrontendExceptionEvent(enriched))).toEqual({});
});

type ChatDocumentFixture = ReturnType<typeof chatDocumentEntry>;
const otherChatErrorShapes: Array<
  [string, (entry: ChatDocumentFixture) => unknown]
> = [
  ["a longer error", (entry) => ({ ...entry, value: "xyz" })],
  ["a one-unit error", (entry) => ({ ...entry, value: "x" })],
  ["a different error class", (entry) => ({ ...entry, type: "TypeError" })],
  [
    "a handled error",
    (entry) => ({ ...entry, mechanism: { ...entry.mechanism, handled: true } }),
  ],
  [
    "a synthetic error",
    (entry) => ({
      ...entry,
      mechanism: { ...entry.mechanism, synthetic: true },
    }),
  ],
  [
    "a different mechanism",
    (entry) => ({ ...entry, mechanism: { ...entry.mechanism, type: "other" } }),
  ],
  [
    "two frames",
    (entry) => ({
      ...entry,
      stacktrace: { frames: entry.stacktrace.frames.slice(0, 2) },
    }),
  ],
  [
    "four frames",
    (entry) => ({
      ...entry,
      stacktrace: {
        frames: [...entry.stacktrace.frames, entry.stacktrace.frames[0]],
      },
    }),
  ],
  ...[
    [
      "the current document with another query",
      "https://hackerai.co/c/current?other#fragment",
    ],
    [
      "the current document with a trailing slash",
      "https://hackerai.co/c/current/",
    ],
    ["a different origin", "https://other.example/c/private-a"],
    ["an origin-prefix spoof", "https://hackerai.co.other.example/c/private-a"],
    [
      "a credential-bearing source",
      "https://private-user@hackerai.co/c/private-a",
    ],
    [
      "a generated script",
      "https://hackerai.co/_next/static/chunks/private.js",
    ],
    ["an empty chat path", "https://hackerai.co/c/"],
    ["a nested chat path", "https://hackerai.co/c/private-a/extra"],
    ["an oversized filename", `https://hackerai.co/c/${"a".repeat(4096)}`],
    ["an anonymous filename", "<anonymous>"],
  ].map(
    ([label, filename]): [string, (entry: ChatDocumentFixture) => unknown] => [
      label,
      (entry) => ({
        ...entry,
        stacktrace: {
          frames: [
            { ...entry.stacktrace.frames[0], filename },
            ...entry.stacktrace.frames.slice(1),
          ],
        },
      }),
    ],
  ),
  [
    "server-normalized source instead of browser filename",
    (entry) => ({
      ...entry,
      stacktrace: {
        frames: entry.stacktrace.frames.map(({ filename, ...frame }) => ({
          ...frame,
          source: filename,
        })),
      },
    }),
  ],
];

it.each(otherChatErrorShapes)(
  "does not expand nearby context to %s",
  (_label, change) => {
    const event = chatDocumentEvent(change(chatDocumentEntry()));
    expect(nearbyProperties(enrichFrontendExceptionEvent(event))).toEqual({});
  },
);

it.each([
  undefined,
  "not a URL",
  "http://hackerai.co/c/current",
  "https://hackerai.co/share/current",
  "https://private-user@hackerai.co/c/current",
  `https://hackerai.co/c/${"a".repeat(4096)}`,
])(
  "omits the group when the current document is not eligible (%s)",
  (current) => {
    const event = chatDocumentEvent();
    const enriched = enrichFrontendExceptionEvent({
      ...event,
      properties: { ...event.properties, $current_url: current },
    });
    expect(nearbyProperties(enriched)).toEqual({});
  },
);
