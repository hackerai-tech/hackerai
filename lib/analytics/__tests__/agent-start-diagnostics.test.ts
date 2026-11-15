import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockCapture = jest.fn();
jest.mock("posthog-js", () => ({
  __esModule: true,
  default: { __loaded: true, capture: mockCapture },
}));

const {
  confirmAuthenticatedAnalyticsUserId,
  loadPostHogClient,
  setAuthenticatedAnalyticsUserId,
} = require("../client") as typeof import("../client");
const { beginAgentStartDiagnostic, countUtf8Bytes } =
  require("../agent-start-diagnostics") as typeof import("../agent-start-diagnostics");
const { AGENT_START_BODY_SCAN_LIMIT_CODE_UNITS } =
  require("../agent-start-privacy") as typeof import("../agent-start-privacy");

const EVENT = "agent_start_http413_diagnostic";
const BUILD = "0123456789".repeat(4);
const REQUEST_ID = "iad1::8x2kq-1794094000000-0123456789ab";
const originalKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const originalBuild = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;

function identify(userId: string | null) {
  setAuthenticatedAnalyticsUserId(userId);
  if (userId) confirmAuthenticatedAnalyticsUserId(userId);
}

function diagnostics() {
  return mockCapture.mock.calls
    .filter(([event]) => event === EVENT)
    .map(([, properties]) => properties as Record<string, unknown>);
}

const response = (status: number, headers: Record<string, string> = {}) => ({
  status,
  headers: {
    get: (name: string) => headers[name.toLowerCase()] ?? null,
  } as Headers,
});

const utf8 = (value: string) => new TextEncoder().encode(value).length;

describe("countUtf8Bytes", () => {
  it.each([
    ["empty", ""],
    ["ASCII", '{"chatId":"c"}'],
    ["two-byte", "é£ñ"],
    ["three-byte", "€中文"],
    ["a surrogate pair", "a😀b"],
    ["a lone high surrogate", "a\ud83db"],
    ["a lone low surrogate", "a\ude00b"],
    ["a trailing high surrogate", "ab\ud83d"],
    ["reversed surrogates", "\ude00\ud83d"],
    ["a high surrogate before a pair", "\ud83d😀"],
  ])("matches TextEncoder for %s", (_name, value) => {
    expect(countUtf8Bytes(value)).toBe(utf8(value));
  });

  it("stops at the diagnostic scan budget instead of a partial count", () => {
    expect(countUtf8Bytes("abcd", 4)).toBe(4);
    expect(countUtf8Bytes("abcde", 4)).toBeNull();
  });
});

describe("beginAgentStartDiagnostic", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = BUILD;
    await loadPostHogClient();
  });

  afterAll(() => {
    for (const [key, value] of [
      ["NEXT_PUBLIC_POSTHOG_KEY", originalKey],
      ["NEXT_PUBLIC_HACKERAI_BUILD_COMMIT", originalBuild],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = BUILD;
    identify(null);
    identify("user-a");
    mockCapture.mockClear();
  });

  it("reports one closed 413 receipt with the exact body size", () => {
    const body = JSON.stringify({ chatId: "c", text: "€😀" });
    const diagnostic = beginAgentStartDiagnostic(body);
    diagnostic.onHttpErrorResponse?.(
      response(413, {
        "x-hackerai-agent-start-rejection": "trigger_payload_too_large",
        "x-vercel-id": REQUEST_ID,
      }),
    );
    diagnostic.onHttpErrorResponse?.(response(413));

    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(
      EVENT,
      {
        agent_start_http413_diagnostic_version: 1,
        http_status: 413,
        request_body_state: "measured",
        request_body_utf8_bytes: utf8(body),
        app_rejection_marker_state: "known",
        vercel_error_state: "absent",
        platform_request_id_state: "valid",
        platform_request_id: REQUEST_ID,
        build_state: "measured",
        hackerai_frontend_build_commit: BUILD,
        attempt_denominator_kind: "unmeasured",
      },
      { uuid: expect.any(String) },
    );
  });

  it("classifies platform and unknown header values without copying them", () => {
    process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = "not-a-commit";
    beginAgentStartDiagnostic("{}").onHttpErrorResponse?.(
      response(413, {
        "x-hackerai-agent-start-rejection": "TRIGGER_PAYLOAD_TOO_LARGE",
        "x-vercel-error": "FUNCTION_PAYLOAD_TOO_LARGE",
        "x-vercel-id": "PRIVATE-request-id",
      }),
    );
    beginAgentStartDiagnostic("{}").onHttpErrorResponse?.(
      response(413, { "x-vercel-error": "function_payload_too_large" }),
    );

    expect(diagnostics()).toEqual([
      expect.objectContaining({
        app_rejection_marker_state: "other",
        vercel_error_state: "known",
        platform_request_id_state: "invalid",
        build_state: "unavailable",
      }),
      expect.objectContaining({
        app_rejection_marker_state: "absent",
        vercel_error_state: "other",
        platform_request_id_state: "absent",
      }),
    ]);
    expect(JSON.stringify(mockCapture.mock.calls)).not.toMatch(
      /PRIVATE|payload_too_large|not-a-commit/i,
    );
  });

  it("marks throwing or malformed headers unreadable", () => {
    beginAgentStartDiagnostic("{}").onHttpErrorResponse?.({
      status: 413,
      get headers(): Headers {
        throw new Error("PRIVATE");
      },
    });
    beginAgentStartDiagnostic("{}").onHttpErrorResponse?.({
      status: 413,
      headers: { get: () => 42 } as unknown as Headers,
    });
    expect(diagnostics()).toEqual([
      expect.objectContaining({
        app_rejection_marker_state: "unreadable",
        vercel_error_state: "unreadable",
        platform_request_id_state: "unreadable",
      }),
      expect.objectContaining({ platform_request_id_state: "unreadable" }),
    ]);
  });

  it("does not consume or coerce unsupported bodies", () => {
    const toString = jest.fn(() => "PRIVATE");
    const stream = { toString, getReader: jest.fn(), text: jest.fn() };
    beginAgentStartDiagnostic(stream).onHttpErrorResponse?.(response(413));
    beginAgentStartDiagnostic(undefined).onHttpErrorResponse?.(response(413));

    expect(diagnostics()).toEqual([
      expect.objectContaining({ request_body_state: "unmeasured_unsupported" }),
      expect.objectContaining({ request_body_state: "absent" }),
    ]);
    for (const properties of diagnostics()) {
      expect(properties).not.toHaveProperty("request_body_utf8_bytes");
    }
    expect(toString).not.toHaveBeenCalled();
    expect(stream.getReader).not.toHaveBeenCalled();
    expect(stream.text).not.toHaveBeenCalled();
  });

  it("reports a body beyond the scan budget as unmeasured", () => {
    beginAgentStartDiagnostic(
      "a".repeat(AGENT_START_BODY_SCAN_LIMIT_CODE_UNITS + 1),
    ).onHttpErrorResponse?.(response(413));
    expect(diagnostics()).toEqual([
      expect.objectContaining({ request_body_state: "unmeasured_budget" }),
    ]);
    expect(diagnostics()[0]).not.toHaveProperty("request_body_utf8_bytes");
  });

  it("ignores non-413 failures and responses after the attempt settles", () => {
    const failed = beginAgentStartDiagnostic("{}");
    failed.onHttpErrorResponse?.(response(403));
    failed.onHttpErrorResponse?.(response(413));
    const disposed = beginAgentStartDiagnostic("{}");
    disposed.dispose();
    disposed.onHttpErrorResponse?.(response(413));
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("gives each attempt its own event identity", () => {
    beginAgentStartDiagnostic("{}").onHttpErrorResponse?.(response(413));
    beginAgentStartDiagnostic("{}").onHttpErrorResponse?.(response(413));
    const uuids = mockCapture.mock.calls.map(
      ([, , options]) => (options as { uuid: string }).uuid,
    );
    expect(uuids).toHaveLength(2);
    expect(uuids[0]).not.toBe(uuids[1]);
  });

  it("does not observe permitted-but-unidentified or anonymous owners", () => {
    setAuthenticatedAnalyticsUserId("user-pending");
    const pending = beginAgentStartDiagnostic("{}");
    confirmAuthenticatedAnalyticsUserId("user-pending");
    pending.onHttpErrorResponse?.(response(413));
    identify(null);
    beginAgentStartDiagnostic("{}").onHttpErrorResponse?.(response(413));
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it.each<[string, (string | null)[]]>([
    ["switches account", ["user-b"]],
    ["revokes consent", [null]],
    ["leaves and re-enters", [null, "user-a"]],
  ])("drops an in-flight 413 when the owner %s", (_name, transitions) => {
    const diagnostic = beginAgentStartDiagnostic("{}");
    transitions.forEach(identify);
    diagnostic.onHttpErrorResponse?.(response(413));
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("keeps the attempt through a same-owner identification", () => {
    const diagnostic = beginAgentStartDiagnostic("{}");
    confirmAuthenticatedAnalyticsUserId("user-a");
    diagnostic.onHttpErrorResponse?.(response(413));
    expect(diagnostics()).toHaveLength(1);
  });

  it.each<[string, (string | null)[]]>([
    ["switches account", ["user-b"]],
    ["leaves and re-enters", [null, "user-a"]],
  ])(
    "drops a 413 whose header read %s, without throwing",
    (_name, transitions) => {
      const diagnostic = beginAgentStartDiagnostic("{}");
      expect(() =>
        diagnostic.onHttpErrorResponse?.({
          status: 413,
          headers: {
            get: () => {
              transitions.forEach(identify);
              return null;
            },
          } as unknown as Headers,
        }),
      ).not.toThrow();
      expect(mockCapture).not.toHaveBeenCalled();
    },
  );

  it("drops a report when attempt identity creation changes or fails", () => {
    const randomUUID = jest.spyOn(globalThis.crypto, "randomUUID");
    try {
      randomUUID.mockImplementationOnce(() => {
        identify("user-b");
        return "00000000-0000-4000-8000-000000000000";
      });
      beginAgentStartDiagnostic("{}").onHttpErrorResponse?.(response(413));
      identify("user-a");
      randomUUID.mockImplementationOnce(() => {
        throw new Error("crypto unavailable");
      });
      const failing = beginAgentStartDiagnostic("{}");
      expect(() => failing.onHttpErrorResponse?.(response(413))).not.toThrow();
      expect(mockCapture).not.toHaveBeenCalled();
    } finally {
      randomUUID.mockRestore();
    }
  });

  it.each([
    ["a malformed", "not-a-uuid"],
    ["an oversized", `00000000-0000-4000-8000-000000000000${"0".repeat(1e6)}`],
    ["a non-string", { toString: jest.fn(() => "PRIVATE") }],
  ])("drops a report when attempt identity is %s value", (_name, attemptId) => {
    const randomUUID = jest
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue(attemptId as ReturnType<Crypto["randomUUID"]>);
    try {
      const diagnostic = beginAgentStartDiagnostic("{}");
      diagnostic.onHttpErrorResponse?.(response(413));
      diagnostic.onHttpErrorResponse?.(response(413));
      expect(mockCapture).not.toHaveBeenCalled();
      if (typeof attemptId === "object") {
        expect(attemptId.toString).not.toHaveBeenCalled();
      }
    } finally {
      randomUUID.mockRestore();
    }
  });
});

describe("registration failure cleanup", () => {
  it("unsubscribes once and leaves the start unchanged when identity becomes unreadable after subscribing", async () => {
    // Each attempt: the first identity read succeeds, the second throws.
    let permittedReads = 0;
    const listeners = new Set<() => void>();
    const unsubscribe = jest.fn();
    const capture = jest.fn();
    await jest.isolateModulesAsync(async () => {
      jest.doMock("@/lib/analytics/client", () => ({
        captureQueuedAuthenticatedEvent: capture,
        getIdentifiedAnalyticsUserId: () => "user-a",
        getPermittedAnalyticsUserId: () => {
          permittedReads += 1;
          if (permittedReads % 2 === 0) throw new Error("identity unreadable");
          return "user-a";
        },
        subscribeAuthenticatedAnalytics: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            unsubscribe();
            listeners.delete(listener);
          };
        },
      }));
      jest.doMock("@/lib/chat/trigger-browser-realtime", () => ({
        readTriggerRunStream: jest.fn(),
        retrieveTriggerRunStatus: jest.fn(),
      }));
      const isolated =
        require("../agent-start-diagnostics") as typeof import("../agent-start-diagnostics");
      const { fetchAgentLongStream } =
        require("@/lib/chat/agent-long-transport") as typeof import("@/lib/chat/agent-long-transport");

      const diagnostic = isolated.beginAgentStartDiagnostic("{}");
      expect(diagnostic.onHttpErrorResponse).toBeUndefined();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      // No listener keeps the attempt's closure, or its body, reachable.
      expect(listeners.size).toBe(0);
      diagnostic.dispose();
      expect(unsubscribe).toHaveBeenCalledTimes(1);

      const originalFetch = globalThis.fetch;
      const fetchMock = jest.fn(async () => ({
        ok: false,
        status: 413,
        headers: { get: () => null },
        clone: () => ({
          json: async () => {
            throw new SyntaxError("Not JSON");
          },
        }),
        text: async () => "Request Entity Too Large",
      }));
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: fetchMock,
      });
      try {
        await expect(
          fetchAgentLongStream({
            method: "POST",
            body: JSON.stringify({ chatId: "registration-chat" }),
          }),
        ).rejects.toMatchObject({
          cause: "Request Entity Too Large",
          statusCode: 413,
        });
      } finally {
        Object.defineProperty(globalThis, "fetch", {
          configurable: true,
          writable: true,
          value: originalFetch,
        });
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(unsubscribe).toHaveBeenCalledTimes(2);
      expect(listeners.size).toBe(0);
      expect(capture).not.toHaveBeenCalled();
    });
  });
});
