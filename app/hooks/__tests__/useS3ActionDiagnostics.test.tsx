import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { act, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";

const mockCapture = jest.fn();
const mockPostHog = {
  __loaded: true,
  capture: mockCapture,
  get_distinct_id: jest.fn(() => "user_a"),
};
jest.mock("posthog-js", () => ({ __esModule: true, default: mockPostHog }));

// The mapped module itself, not an automock of it.
const { resetMockConvexAuth, setMockConvexAuth } =
  require("convex/react") as typeof import("../../../__mocks__/convex-react");
const {
  confirmAuthenticatedAnalyticsUserId,
  loadPostHogClient,
  setAuthenticatedAnalyticsUserId,
} =
  require("@/lib/analytics/client") as typeof import("@/lib/analytics/client");
const {
  advanceConvexAuthTokenDecisionContext,
  beginConvexAuthTokenDecision,
  createConvexAuthTokenDecisionOwner,
  publishConvexAuthProviderState,
} =
  require("@/lib/auth/convex-auth-diagnostics") as typeof import("@/lib/auth/convex-auth-diagnostics");
const { sanitizeFileActionAuthDiagnosticEvent } =
  require("@/lib/analytics/file-auth-diagnostics") as typeof import("@/lib/analytics/file-auth-diagnostics");
const { useS3ActionDiagnostics } =
  require("../useS3ActionDiagnostics") as typeof import("../useS3ActionDiagnostics");

type FileActionCaller = Parameters<typeof useS3ActionDiagnostics>[0];
type Action = (args: Record<string, unknown>) => Promise<unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = "0123456789abcdef";
const redacted = (fn = "getFileUrlAction", id = REQUEST_ID) =>
  `[CONVEX A(s3Actions:${fn})] [Request ID: ${id}] Server Error\n  Called by client`;

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function capturedDiagnostics() {
  return mockCapture.mock.calls
    .filter(([event]) => event === "file_action_auth_diagnostic")
    .map(([, properties]) => properties as Record<string, unknown>);
}

function renderObserved(
  action: Action,
  caller: FileActionCaller = "inline_image",
  wrapper?: ({ children }: { children: ReactNode }) => ReactNode,
) {
  return renderHook(
    ({ observed }: { observed: Action }) =>
      useS3ActionDiagnostics(caller, observed),
    { initialProps: { observed: action }, wrapper },
  );
}

async function settle(promise: Promise<unknown>) {
  await promise.catch(() => {});
}

function setOwner(owner: string | null) {
  act(() => {
    setAuthenticatedAnalyticsUserId(owner);
    if (owner) confirmAuthenticatedAnalyticsUserId(owner);
  });
}

describe("useS3ActionDiagnostics", () => {
  let tokenDecisions: ReturnType<typeof createConvexAuthTokenDecisionOwner>;
  let unpublish: () => void;

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    await loadPostHogClient();
  });

  beforeEach(() => {
    mockCapture.mockReset();
    resetMockConvexAuth();
    setOwner("user_a");
    tokenDecisions = createConvexAuthTokenDecisionOwner();
    unpublish = publishConvexAuthProviderState("ready", tokenDecisions);
  });

  afterEach(() => {
    unpublish();
    setAuthenticatedAnalyticsUserId(null);
  });

  describe("leaves the action contract unchanged", () => {
    it("calls once with the same arguments and returns the same promise and result", async () => {
      const value = { url: "https://bucket.test/object" };
      const pending = Promise.resolve(value);
      const action = jest.fn<Action>(() => pending);
      const { result } = renderObserved(action);
      const args = { fileId: "file_1" };

      const returned = result.current(args);

      expect(returned).toBe(pending);
      expect(action).toHaveBeenCalledTimes(1);
      expect(action.mock.calls[0][0]).toBe(args);
      expect(action.mock.calls[0]).toHaveLength(1);
      await expect(returned).resolves.toBe(value);
      expect(capturedDiagnostics()).toEqual([]);
    });

    it.each<[string, () => unknown, boolean]>([
      ["a recognized failure", () => new Error(redacted()), true],
      ["an unrecognized failure", () => new Error("Connection lost"), false],
      [
        "a frozen recognized failure",
        () => Object.freeze(new Error(redacted())),
        true,
      ],
      [
        "a malformed failure",
        () =>
          Object.defineProperty(new Error(), "message", {
            get: () => {
              throw new Error("PRIVATE_GETTER");
            },
          }),
        false,
      ],
      ["a non-error rejection", () => redacted(), false],
    ])(
      "rejects with the original reason for %s",
      async (_name, makeError, reported) => {
        const error = makeError();
        const pending = Promise.reject(error);
        const action = jest.fn<Action>(() => pending);
        const { result } = renderObserved(action);

        const returned = result.current({ fileId: "file_1" });

        expect(returned).toBe(pending);
        await expect(returned).rejects.toBe(error);
        expect(action).toHaveBeenCalledTimes(1);
        expect(capturedDiagnostics()).toHaveLength(reported ? 1 : 0);
      },
    );

    it("keeps the original rejection when telemetry and readers throw", async () => {
      mockCapture.mockImplementation(() => {
        throw new Error("SDK unavailable");
      });
      Object.defineProperty(tokenDecisions, "latest", {
        get: () => {
          throw new Error("PRIVATE_READER");
        },
      });
      const error = new Error(redacted());
      const action = jest.fn<Action>(() => Promise.reject(error));
      const { result } = renderObserved(action);

      await expect(result.current({ fileId: "file_1" })).rejects.toBe(error);
      // Delivery was attempted (the client's queue retries once) and failed.
      expect(mockCapture).toHaveBeenCalled();
    });

    it("propagates a synchronous throw unchanged", () => {
      const error = new Error("sync");
      const { result } = renderObserved(() => {
        throw error;
      });
      expect(() => result.current({ fileId: "file_1" })).toThrow(error);
    });

    it("keeps a stable function across renders and follows a new action", () => {
      const first = jest.fn<Action>(() => Promise.resolve(null));
      const { result, rerender } = renderObserved(first);
      const observed = result.current;

      act(() => setMockConvexAuth({ isLoading: true }));
      rerender({ observed: first });
      expect(result.current).toBe(observed);

      const second = jest.fn<Action>(() => Promise.resolve(null));
      rerender({ observed: second });
      expect(result.current).not.toBe(observed);
    });
  });

  describe("context", () => {
    it("reports committed Convex, provider and token state at invocation and rejection", async () => {
      process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = "b".repeat(40);
      try {
        setMockConvexAuth({ isLoading: true, isAuthenticated: false });
        unpublish();
        unpublish = publishConvexAuthProviderState(
          "authkit_loading",
          tokenDecisions,
        );
        const settleToken = beginConvexAuthTokenDecision(
          tokenDecisions,
          "ordinary",
          true,
        );
        const request = deferred();
        const { result, rerender } = renderObserved(() => request.promise);

        const returned = result.current({ fileId: "file_1" });

        // Later commits and token settlement before the rejection arrives.
        setMockConvexAuth({ isLoading: false, isAuthenticated: true });
        rerender({ observed: () => request.promise });
        unpublish();
        unpublish = publishConvexAuthProviderState("ready", tokenDecisions);
        settleToken("token", true);
        request.reject(new Error(redacted()));
        await settle(returned);

        const [properties] = capturedDiagnostics();
        expect(properties).toEqual({
          file_action_auth_diagnostic_version: 1,
          caller: "inline_image",
          operation: "getFileUrlAction",
          failure_class: "redacted_server_error",
          convex_request_id: REQUEST_ID,
          request_convex_auth_state: "loading",
          convex_auth_state: "authenticated",
          request_provider_state: "authkit_loading",
          provider_state: "ready",
          request_token_mode: "ordinary",
          request_token_outcome: "pending",
          request_token_result: "pending",
          request_token_age: "lt_1s",
          request_token_context: "same",
          token_mode: "ordinary",
          token_outcome: "token",
          token_result: "token",
          token_age: "lt_1s",
          token_context: "same",
          token_attempt: "same",
          input_relation: "first",
          observer_scope_id: expect.stringMatching(UUID),
          hackerai_frontend_build_commit: "b".repeat(40),
        });
        // Exactly what before_send retains for this owner.
        expect(
          sanitizeFileActionAuthDiagnosticEvent(
            {
              event: "file_action_auth_diagnostic",
              properties: { ...properties, distinct_id: "user_a" },
            },
            () => ({ owner: "user_a", token: undefined }),
          ),
        ).toEqual({
          event: "file_action_auth_diagnostic",
          properties: { ...properties, distinct_id: "user_a" },
        });
      } finally {
        delete process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
      }
    });

    it("distinguishes a changed attempt, a superseded context and an absent provider", async () => {
      beginConvexAuthTokenDecision(
        tokenDecisions,
        "ordinary",
        true,
      )("null", false);
      const request = deferred();
      const { result } = renderObserved(() => request.promise, "upload");

      const returned = result.current({ fileName: "PRIVATE_NAME.pdf" });

      beginConvexAuthTokenDecision(tokenDecisions, "forced_refresh", true);
      advanceConvexAuthTokenDecisionContext(tokenDecisions);
      unpublish();
      request.reject(new Error(redacted("generateS3UploadUrlAction")));
      await settle(returned);

      const [properties] = capturedDiagnostics();
      expect(properties).toMatchObject({
        caller: "upload",
        operation: "generateS3UploadUrlAction",
        request_provider_state: "ready",
        provider_state: "unavailable",
        request_token_mode: "ordinary",
        request_token_outcome: "null",
        request_token_result: "null",
        request_token_context: "same",
        token_mode: "unavailable",
        token_attempt: "unavailable",
        input_relation: "unavailable",
      });
      expect(JSON.stringify(properties)).not.toContain("PRIVATE");

      // With the provider committed again: the same pending attempt, whose
      // auth context was superseded before the rejection.
      unpublish = publishConvexAuthProviderState("ready", tokenDecisions);
      beginConvexAuthTokenDecision(tokenDecisions, "forced_refresh", true);
      const third = deferred();
      const { result: superseded } = renderObserved(
        () => third.promise,
        "upload",
      );
      const pending = superseded.current({});
      advanceConvexAuthTokenDecisionContext(tokenDecisions);
      third.reject(new Error(redacted("generateS3UploadUrlAction")));
      await settle(pending);
      expect(capturedDiagnostics()[1]).toMatchObject({
        request_token_mode: "forced_refresh",
        request_token_outcome: "pending",
        request_token_context: "same",
        token_mode: "forced_refresh",
        token_outcome: "pending",
        token_context: "superseded",
        token_attempt: "same",
      });
    });

    it("relates repeated and concurrent inputs within one observer scope only", async () => {
      const requests = [deferred(), deferred(), deferred(), deferred()];
      let call = 0;
      const { result } = renderObserved(() => requests[call++].promise);

      const first = result.current({ fileId: "PRIVATE_FILE_1" });
      const concurrentSame = result.current({ fileId: "PRIVATE_FILE_1" });
      const different = result.current({ fileId: "PRIVATE_FILE_2" });
      const missing = result.current({});
      for (const request of requests) request.reject(new Error(redacted()));
      await Promise.all(
        [first, concurrentSame, different, missing].map(settle),
      );

      const reported = capturedDiagnostics();
      expect(reported.map((event) => event.input_relation)).toEqual([
        "first",
        "same",
        "different",
        "unavailable",
      ]);
      expect(
        new Set(reported.map((event) => event.observer_scope_id)).size,
      ).toBe(1);
      expect(JSON.stringify(reported)).not.toContain("PRIVATE");

      // A separate observer has its own scope and history.
      const other = deferred();
      const { result: sibling } = renderObserved(
        () => other.promise,
        "file_preview",
      );
      const siblingCall = sibling.current({ fileId: "PRIVATE_FILE_1" });
      other.reject(new Error(redacted()));
      await settle(siblingCall);
      const [siblingEvent] = capturedDiagnostics().slice(4);
      expect(siblingEvent).toMatchObject({
        caller: "file_preview",
        input_relation: "first",
      });
      expect(siblingEvent.observer_scope_id).not.toBe(
        reported[0].observer_scope_id,
      );
    });
  });

  describe("privacy fences", () => {
    it("drops a rejection that settles after unmount", async () => {
      const request = deferred();
      const { result, unmount } = renderObserved(() => request.promise);
      const returned = result.current({ fileId: "file_1" });

      unmount();
      const error = new Error(redacted());
      request.reject(error);

      await expect(returned).rejects.toBe(error);
      expect(capturedDiagnostics()).toEqual([]);
    });

    it.each([
      ["an A→B→A owner switch", ["user_b", "user_a"]],
      ["consent withdrawn and restored", [null, "user_a"]],
    ] as const)(
      "drops a rejection that spans %s",
      async (_name, transitions) => {
        const request = deferred();
        const { result } = renderObserved(() => request.promise);
        const returned = result.current({ fileId: "file_1" });

        for (const owner of transitions) setOwner(owner);
        request.reject(new Error(redacted()));
        await settle(returned);
        expect(capturedDiagnostics()).toEqual([]);

        // Control: a new invocation under the restored owner is reported in a
        // new scope, with no input history from before the switch.
        const next = deferred();
        const { result: fresh } = renderObserved(() => next.promise);
        const call = fresh.current({ fileId: "file_1" });
        next.reject(new Error(redacted()));
        await settle(call);
        expect(capturedDiagnostics()).toEqual([
          expect.objectContaining({ input_relation: "first" }),
        ]);
      },
    );

    it("starts a new input scope in an existing observer after an owner switch", async () => {
      const requests = [deferred(), deferred()];
      let call = 0;
      const { result } = renderObserved(() => requests[call++].promise);

      const before = result.current({ fileId: "file_1" });
      requests[0].reject(new Error(redacted()));
      await settle(before);
      setOwner("user_b");
      setOwner("user_a");
      const after = result.current({ fileId: "file_1" });
      requests[1].reject(new Error(redacted()));
      await settle(after);

      const [first, second] = capturedDiagnostics();
      expect(second.input_relation).toBe("first");
      expect(second.observer_scope_id).not.toBe(first.observer_scope_id);
    });

    it("never attributes an invocation made without a permitted owner", async () => {
      setOwner(null);
      const request = deferred();
      const { result } = renderObserved(() => request.promise);
      const returned = result.current({ fileId: "file_1" });

      setOwner("user_a");
      request.reject(new Error(redacted()));
      await settle(returned);
      expect(capturedDiagnostics()).toEqual([]);
    });

    it("keeps observing after a strict-mode effect remount", async () => {
      const request = deferred();
      const { result } = renderObserved(
        () => request.promise,
        "inline_image",
        ({ children }) => <StrictMode>{children}</StrictMode>,
      );
      const returned = result.current({ fileId: "file_1" });
      request.reject(new Error(redacted()));
      await settle(returned);
      expect(capturedDiagnostics()).toHaveLength(1);
    });
  });
});
