import { getIdentifiedAnalyticsUserId } from "@/lib/analytics/client";
import {
  startUnhandledRejectionDiagnostics,
  getUnhandledRejectionDiagnostics,
} from "../unhandled-rejection-diagnostics";
import {
  enrichFrontendExceptionEvent,
  shouldDropExpectedFrontendException,
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

it("enriches only four retained shapes, preserving original exceptions and filtering", () => {
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
