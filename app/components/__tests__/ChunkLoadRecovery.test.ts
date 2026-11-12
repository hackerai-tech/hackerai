import { render } from "@testing-library/react";
import { createElement } from "react";
import {
  ChunkLoadRecovery,
  isChunkLoadFailure,
  isStaleServerActionFailure,
  maybeRecoverFromChunkLoadFailure,
} from "../ChunkLoadRecovery";
import {
  confirmAuthenticatedAnalyticsUserId,
  loadPostHogClient,
  setAuthenticatedAnalyticsUserId,
} from "@/lib/analytics/client";
import { recordGlobalServerActionDecision } from "@/lib/analytics/server-action-diagnostics";

const mockPostHogCapture = jest.fn();
jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    __loaded: true,
    capture: (...args: unknown[]) => mockPostHogCapture(...args),
  },
}));

const RELOAD_KEY = "hackerai:chunk-load-reload-at";
const unavailableAction = () =>
  new Error(
    `Server Action "${"0c".repeat(21)}" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action`,
  );

function identifyAnalyticsOwner(userId: string | null) {
  setAuthenticatedAnalyticsUserId(userId);
  if (userId) confirmAuthenticatedAnalyticsUserId(userId);
}

function serverActionContexts() {
  return mockPostHogCapture.mock.calls
    .filter(([event]) => event === "server_action_client_context")
    .map(([, properties]) => properties as Record<string, unknown>);
}

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: jest.fn((key: string) => values.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

describe("ChunkLoadRecovery", () => {
  it("detects stale Next chunk load failures", () => {
    expect(
      isChunkLoadFailure(
        new Error(
          "Failed to load chunk /_next/static/chunks/example.js from module 1",
        ),
      ),
    ).toBe(true);

    expect(
      isChunkLoadFailure({
        name: "ChunkLoadError",
        message: "Loading chunk 123 failed.",
      }),
    ).toBe(true);

    expect(
      isChunkLoadFailure(
        "Failed to fetch dynamically imported module: https://example.com/chunk.js",
      ),
    ).toBe(true);

    expect(isChunkLoadFailure(new Error("Failed to fetch"))).toBe(false);
  });

  it("handles cyclic rejection payloads while checking chunk load failures", () => {
    const reason: { message: string; self?: unknown } = {
      message: "ChunkLoadError",
    };
    reason.self = reason;

    expect(isChunkLoadFailure(reason)).toBe(true);
  });

  it("detects stale Server Action deployment failures", () => {
    expect(
      isStaleServerActionFailure(
        new Error(
          'Failed to find Server Action "008d652c1c1a320304c0f5508bce36145a66bf6c11". This request might be from an older or newer deployment.',
        ),
      ),
    ).toBe(true);

    expect(
      isStaleServerActionFailure(
        new Error(
          'Server Action "00b3ff60fce156a3bb78260aa8fa56550dc48b7f77" was not found on the server. Read more: https://nextjs.org/docs/messages/failed-to-find-server-action',
        ),
      ),
    ).toBe(true);

    expect(
      isStaleServerActionFailure({
        message: "This request might be from an older or newer deployment.",
      }),
    ).toBe(true);

    expect(isStaleServerActionFailure(new Error("Failed to fetch"))).toBe(
      false,
    );
  });

  it("reloads once for chunk load failures and records the attempt", () => {
    const storage = createStorage();
    const reload = jest.fn();

    expect(
      maybeRecoverFromChunkLoadFailure(new Error("ChunkLoadError"), {
        storage,
        reload,
        now: 1_000,
      }),
    ).toBe(true);

    expect(storage.setItem).toHaveBeenCalledWith(
      "hackerai:chunk-load-reload-at",
      "1000",
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads once for stale Server Action failures", () => {
    const storage = createStorage();
    const reload = jest.fn();

    expect(
      maybeRecoverFromChunkLoadFailure(
        new Error("Failed to find Server Action"),
        {
          storage,
          reload,
          now: 1_500,
        },
      ),
    ).toBe(true);

    expect(storage.setItem).toHaveBeenCalledWith(
      "hackerai:chunk-load-reload-at",
      "1500",
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload repeatedly inside the cooldown window", () => {
    const storage = createStorage({
      "hackerai:chunk-load-reload-at": "1000",
    });
    const reload = jest.fn();

    expect(
      maybeRecoverFromChunkLoadFailure(new Error("ChunkLoadError"), {
        storage,
        reload,
        now: 2_000,
        cooldownMs: 5_000,
      }),
    ).toBe(false);

    expect(reload).not.toHaveBeenCalled();
  });

  it("still reloads when storage is unavailable", () => {
    const storage = {
      getItem: jest.fn(() => {
        throw new Error("Storage disabled");
      }),
      setItem: jest.fn(),
    };
    const reload = jest.fn();

    expect(
      maybeRecoverFromChunkLoadFailure(new Error("ChunkLoadError"), {
        storage,
        reload,
      }),
    ).toBe(true);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  describe("recovery decision observation", () => {
    const originalPostHogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const originalBuild = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;

    beforeAll(async () => {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
      delete process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
      await loadPostHogClient();
    });

    afterAll(() => {
      for (const [key, value] of [
        ["NEXT_PUBLIC_POSTHOG_KEY", originalPostHogKey],
        ["NEXT_PUBLIC_HACKERAI_BUILD_COMMIT", originalBuild],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    beforeEach(() => {
      identifyAnalyticsOwner(null);
      identifyAnalyticsOwner("user-a");
      window.sessionStorage.clear();
    });

    it("records a reload request before reloading without changing the cooldown write", () => {
      const storage = createStorage();
      const reload = jest.fn();
      const onDecision = jest.fn(
        (decision: "reload_requested" | "cooldown_skipped") =>
          recordGlobalServerActionDecision(
            "global_unhandled_rejection",
            unavailableAction(),
            decision,
          ),
      );

      expect(
        maybeRecoverFromChunkLoadFailure(unavailableAction(), {
          storage,
          reload,
          now: 2_000,
          onDecision,
        }),
      ).toBe(true);

      expect(onDecision).toHaveBeenCalledWith("reload_requested");
      expect(storage.setItem).toHaveBeenCalledWith(RELOAD_KEY, "2000");
      expect(reload).toHaveBeenCalledTimes(1);
      expect(mockPostHogCapture.mock.invocationCallOrder[0]).toBeLessThan(
        reload.mock.invocationCallOrder[0],
      );
      expect(serverActionContexts()).toEqual([
        {
          server_action_client_diagnostic_version: 1,
          caller: "global_unhandled_rejection",
          matched_pattern: "next_unrecognized_action_message",
          reference_shape: "hex42",
          recovery_decision: "reload_requested",
          build_state: "unavailable",
          attempt_denominator_kind: "unmeasured",
        },
      ]);
    });

    it.each([
      ["cooldown", { [RELOAD_KEY]: "1000" }, false, "cooldown_skipped"],
      ["unavailable storage", null, true, "reload_requested"],
    ] as const)(
      "reports the existing %s decision",
      (_name, stored, expected, decision) => {
        const storage = stored
          ? createStorage(stored)
          : {
              getItem: jest.fn(() => {
                throw new Error("Storage disabled");
              }),
              setItem: jest.fn(),
            };
        const reload = jest.fn();
        const onDecision = jest.fn();

        expect(
          maybeRecoverFromChunkLoadFailure(new Error("ChunkLoadError"), {
            storage,
            reload,
            now: 2_000,
            cooldownMs: 5_000,
            onDecision,
          }),
        ).toBe(expected);
        expect(onDecision.mock.calls).toEqual([[decision]]);
        expect(reload).toHaveBeenCalledTimes(expected ? 1 : 0);
      },
    );

    it("does not observe unrelated failures", () => {
      const onDecision = jest.fn();
      const reload = jest.fn();
      expect(
        maybeRecoverFromChunkLoadFailure(new Error("Failed to fetch"), {
          storage: createStorage(),
          reload,
          onDecision,
        }),
      ).toBe(false);
      expect(onDecision).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    });

    it("keeps the cooldown and reload decisions when the observer throws", () => {
      const onDecision = jest.fn(() => {
        throw new Error("observer failed");
      });
      const cooled = createStorage({ [RELOAD_KEY]: "1000" });
      const cooledReload = jest.fn();
      expect(
        maybeRecoverFromChunkLoadFailure(unavailableAction(), {
          storage: cooled,
          reload: cooledReload,
          now: 2_000,
          cooldownMs: 5_000,
          onDecision,
        }),
      ).toBe(false);
      expect(cooled.setItem).not.toHaveBeenCalled();
      expect(cooledReload).not.toHaveBeenCalled();

      const fresh = createStorage();
      const reload = jest.fn();
      expect(
        maybeRecoverFromChunkLoadFailure(unavailableAction(), {
          storage: fresh,
          reload,
          now: 2_000,
          onDecision,
        }),
      ).toBe(true);
      expect(fresh.setItem).toHaveBeenCalledWith(RELOAD_KEY, "2000");
      expect(reload).toHaveBeenCalledTimes(1);
      expect(onDecision).toHaveBeenCalledTimes(2);
    });

    it("records the global caller for recognized failures inside the cooldown", () => {
      window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      const { unmount } = render(createElement(ChunkLoadRecovery));

      const errorEvent = new ErrorEvent("error", {
        error: unavailableAction(),
        cancelable: true,
      });
      const rejection = Object.assign(
        new Event("unhandledrejection", { cancelable: true }),
        { reason: unavailableAction() },
      );
      const chunkRejection = Object.assign(
        new Event("unhandledrejection", { cancelable: true }),
        { reason: new Error("ChunkLoadError") },
      );
      window.dispatchEvent(errorEvent);
      window.dispatchEvent(rejection);
      window.dispatchEvent(
        Object.assign(new Event("unhandledrejection", { cancelable: true }), {
          reason: unavailableAction(),
        }),
      );
      window.dispatchEvent(chunkRejection);

      expect(errorEvent.defaultPrevented).toBe(false);
      expect(rejection.defaultPrevented).toBe(false);
      expect(chunkRejection.defaultPrevented).toBe(false);
      expect(
        serverActionContexts().map(({ caller, recovery_decision }) => [
          caller,
          recovery_decision,
        ]),
      ).toEqual([
        ["global_error", "cooldown_skipped"],
        ["global_unhandled_rejection", "cooldown_skipped"],
      ]);
      unmount();
    });
  });

  it("registers the global error listener in capture mode", () => {
    const addEventListener = jest.spyOn(window, "addEventListener");
    const removeEventListener = jest.spyOn(window, "removeEventListener");

    const { unmount } = render(createElement(ChunkLoadRecovery));

    expect(addEventListener).toHaveBeenCalledWith(
      "error",
      expect.any(Function),
      true,
    );

    unmount();

    expect(removeEventListener).toHaveBeenCalledWith(
      "error",
      expect.any(Function),
      true,
    );

    addEventListener.mockRestore();
    removeEventListener.mockRestore();
  });

  it("does not mask errors whose ErrorEvent fields are inaccessible", () => {
    let errorListener: ((event: ErrorEvent) => void) | undefined;
    const addEventListener = jest
      .spyOn(window, "addEventListener")
      .mockImplementation((type, listener) => {
        if (type === "error" && typeof listener === "function") {
          errorListener = listener as (event: ErrorEvent) => void;
        }
      });
    const preventDefault = jest.fn();
    const event = { preventDefault } as unknown as ErrorEvent;
    Object.defineProperties(event, {
      error: {
        get: () => {
          throw new Error('Permission denied to access property "error"');
        },
      },
      message: {
        get: () => {
          throw new Error('Permission denied to access property "message"');
        },
      },
    });

    const { unmount } = render(createElement(ChunkLoadRecovery));

    expect(() => errorListener?.(event)).not.toThrow();
    expect(preventDefault).not.toHaveBeenCalled();

    unmount();
    addEventListener.mockRestore();
  });
});
