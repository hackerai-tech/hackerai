import { getIdentifiedAnalyticsUserId } from "@/lib/analytics/client";
import {
  getUnhandledRejectionDiagnostics,
  startUnhandledRejectionDiagnostics,
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
let previousHandler: typeof window.onunhandledrejection;
beforeEach(() => {
  previousHandler = window.onunhandledrejection;
  identity.mockReturnValue("fixture-owner");
  now = 10000;
  jest.spyOn(performance, "now").mockImplementation(() => now);
  stop = startUnhandledRejectionDiagnostics();
});
afterEach(() => {
  stop();
  window.onunhandledrejection = previousHandler;
  jest.restoreAllMocks();
});
const reject = (reason: unknown) =>
  window.dispatchEvent(
    new CustomEvent("unhandledrejection", {
      detail: { reason },
      cancelable: true,
    }),
  );

test("records only finite context, without reading reason content or accessors", () => {
  const forbidden = jest.fn(() => {
    throw new Error("Private reason must not be inspected");
  });
  const detail = Object.defineProperty({}, "reason", { get: forbidden });
  const event = new CustomEvent("unhandledrejection", { detail });
  Object.defineProperty(event, "detail", { get: forbidden });
  window.dispatchEvent(event);
  reject("private string");
  reject("undefined");
  reject(Object.defineProperty({}, "message", { get: forbidden }));
  reject(undefined);
  expect(forbidden).not.toHaveBeenCalled();
  const snapshot = getUnhandledRejectionDiagnostics();
  expect(snapshot).toMatchObject({
    hackerai_recent_rejection_count: 5,
    hackerai_recent_rejection_detail_wrapper_count: 5,
    hackerai_recent_rejection_undefined_reason_count: 1,
    hackerai_recent_rejection_unreadable_count: 1,
    hackerai_recent_rejection_untrusted_count: 5,
    hackerai_recent_rejection_trusted_native_undefined_count: 0,
  });
  expect(
    Object.values(snapshot).every((v) =>
      ["number", "boolean"].includes(typeof v),
    ),
  ).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain("private string");
});

test("bounds storms, treats proxy failures as unreadable, and expires context", () => {
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor: () => {
        throw new Error("blocked");
      },
    },
  );
  window.dispatchEvent(
    new CustomEvent("unhandledrejection", { detail: proxy }),
  );
  expect(
    getUnhandledRejectionDiagnostics()
      .hackerai_recent_rejection_unreadable_count,
  ).toBe(1);
  for (let i = 0; i < 1000; i++) reject(undefined);
  expect(getUnhandledRejectionDiagnostics()).toMatchObject({
    hackerai_recent_rejection_count: 16,
    hackerai_recent_rejection_at_capacity: true,
    hackerai_recent_rejection_window_ms: 1000,
  });
  now += 999;
  expect(
    getUnhandledRejectionDiagnostics().hackerai_recent_rejection_count,
  ).toBe(16);
  now += 1;
  expect(getUnhandledRejectionDiagnostics()).toMatchObject({
    hackerai_recent_rejection_count: 0,
    hackerai_recent_rejection_at_capacity: false,
  });
});

test("clears context across account and consent changes, with stale cleanup fenced", () => {
  reject(undefined);
  identity.mockReturnValue(null);
  expect(getUnhandledRejectionDiagnostics()).toEqual({});
  reject(undefined);
  identity.mockReturnValue("fixture-owner");
  expect(
    getUnhandledRejectionDiagnostics().hackerai_recent_rejection_count,
  ).toBe(0);
  identity.mockReturnValue("new-owner");
  const stopNew = startUnhandledRejectionDiagnostics();
  stop();
  reject(undefined);
  expect(
    getUnhandledRejectionDiagnostics().hackerai_recent_rejection_count,
  ).toBe(1);
  stopNew();
  expect(getUnhandledRejectionDiagnostics()).toEqual({});
  identity.mockReturnValue(null);
  startUnhandledRejectionDiagnostics()();
  expect(getUnhandledRejectionDiagnostics()).toEqual({});
});

test("does not replace handlers, cancel events, duplicate listeners, or fail on nested dispatch", () => {
  const original = window.onunhandledrejection;
  const handler = jest.fn();
  window.onunhandledrejection = handler;
  const add = jest.spyOn(window, "addEventListener");
  const remove = jest.spyOn(window, "removeEventListener");
  const duplicateStop = startUnhandledRejectionDiagnostics();
  duplicateStop();
  expect(add).not.toHaveBeenCalled();
  let nested = false;
  const dispatchNested = () => {
    if (!nested) {
      nested = true;
      reject(undefined);
    }
  };
  window.addEventListener("unhandledrejection", dispatchNested);
  const event = new CustomEvent("unhandledrejection", {
    detail: { reason: undefined },
    cancelable: true,
  });
  window.dispatchEvent(event);
  window.removeEventListener("unhandledrejection", dispatchNested);
  expect(event.defaultPrevented).toBe(false);
  expect(handler).toHaveBeenCalledTimes(2);
  expect(window.onunhandledrejection).toBe(handler);
  expect(
    getUnhandledRejectionDiagnostics().hackerai_recent_rejection_count,
  ).toBe(2);
  stop();
  expect(
    remove.mock.calls.some(
      ([name, , capture]) => name === "unhandledrejection" && capture === true,
    ),
  ).toBe(true);
  expect(window.onunhandledrejection).toBe(handler);
  window.onunhandledrejection = original;
});

test("unavailable clock makes diagnostics absent without interrupting dispatch", () => {
  jest.mocked(performance.now).mockReturnValue(NaN);
  expect(() => reject(undefined)).not.toThrow();
  expect(getUnhandledRejectionDiagnostics()).toEqual({});
  jest.mocked(performance.now).mockImplementation(() => {
    throw new Error("clock");
  });
  expect(() => reject(undefined)).not.toThrow();
  expect(getUnhandledRejectionDiagnostics()).toEqual({});
});

test("enriches only the retained SDK undefined-unhandled shape without changing fingerprint inputs", () => {
  reject(undefined);
  const entry = {
    type: "UnhandledRejection",
    value: "Non-Error promise rejection captured with value: undefined",
    mechanism: { handled: false, synthetic: true, type: "generic" },
  };
  const event = {
    event: "$exception",
    properties: { $exception_list: [entry] },
  };
  const original = JSON.parse(JSON.stringify(event.properties));
  expect(shouldDropExpectedFrontendException(event)).toBe(false);
  const enriched = enrichFrontendExceptionEvent(event);
  expect(enriched.properties).toMatchObject({
    hackerai_recent_rejection_count: 1,
  });
  expect(enriched.properties.$exception_list).toEqual(original.$exception_list);
  for (const item of [
    { ...entry, mechanism: { ...entry.mechanism, handled: true } },
    { ...entry, type: "Error" },
    {
      ...entry,
      value: "A different rejection message",
    },
    { ...entry, value: 42 },
    { ...entry, mechanism: { synthetic: true, type: "generic" } },
    { ...entry, value: `prefix ${entry.value}` },
  ]) {
    const retained = enrichFrontendExceptionEvent({
      event: "$exception",
      properties: { $exception_list: [item] },
    });
    expect(
      Object.keys(retained.properties).some((key) =>
        key.startsWith("hackerai_recent_rejection_"),
      ),
    ).toBe(false);
  }
  const multiple = enrichFrontendExceptionEvent({
    event: "$exception",
    properties: { $exception_list: [entry, entry] },
  });
  expect(
    Object.keys(multiple.properties).some((key) =>
      key.startsWith("hackerai_recent_rejection_"),
    ),
  ).toBe(false);
  stop();
  expect(
    Object.keys(enrichFrontendExceptionEvent(event).properties).filter((key) =>
      key.startsWith("hackerai_recent_rejection_"),
    ).length,
  ).toBe(0);
  const fresh = enrichFrontendExceptionEvent({
    event: "$exception",
    properties: original,
  });
  expect(
    Object.keys(fresh.properties).some((key) =>
      key.startsWith("hackerai_recent_rejection_"),
    ),
  ).toBe(false);
});

test.each(["null", "[object Object]"])(
  "enriches the retained non-undefined SDK rejection %s without reading its reason",
  (value) => {
    const forbidden = jest.fn(() => {
      throw new Error("private-rejection-canary");
    });
    reject(
      value === "null"
        ? null
        : Object.defineProperty({}, "private", { get: forbidden }),
    );
    const entry = {
      type: "UnhandledRejection",
      value: `Non-Error promise rejection captured with value: ${value}`,
      mechanism: {
        handled: false,
        synthetic: value !== "null",
        type: "generic",
      },
    };
    const event = {
      event: "$exception",
      properties: { $exception_list: [entry] },
    };
    const original = JSON.parse(JSON.stringify(event.properties));
    expect(shouldDropExpectedFrontendException(event)).toBe(false);
    const enriched = enrichFrontendExceptionEvent(event);
    expect(enriched.properties).toMatchObject({
      hackerai_recent_rejection_count: 1,
      hackerai_recent_rejection_detail_wrapper_count: 1,
      hackerai_recent_rejection_undefined_reason_count: 0,
    });
    expect(enriched.properties.$exception_list).toEqual(
      original.$exception_list,
    );
    expect(forbidden).not.toHaveBeenCalled();
    const diagnostics = Object.fromEntries(
      Object.entries(enriched.properties).filter(([key]) =>
        key.startsWith("hackerai_recent_rejection_"),
      ),
    );
    expect(
      Object.values(diagnostics).every((item) =>
        ["number", "boolean"].includes(typeof item),
      ),
    ).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain(
      "private-rejection-canary",
    );
  },
);

test("removes stale non-undefined rejection context after account or consent changes", () => {
  reject(null);
  const event = {
    event: "$exception",
    properties: {
      $exception_list: [
        {
          type: "UnhandledRejection",
          value: "Non-Error promise rejection captured with value: null",
          mechanism: { handled: false },
        },
      ],
      hackerai_recent_rejection_count: 99,
      hackerai_recent_rejection_version: 1,
    },
  };
  for (const owner of ["different-owner", null]) {
    identity.mockReturnValue(owner);
    const enriched = enrichFrontendExceptionEvent({
      ...event,
      properties: { ...event.properties },
    });
    expect(
      Object.keys(enriched.properties).some((key) =>
        key.startsWith("hackerai_recent_rejection_"),
      ),
    ).toBe(false);
  }
});
