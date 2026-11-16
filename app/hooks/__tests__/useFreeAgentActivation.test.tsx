import "@testing-library/jest-dom";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { FreeAgentActivationStatus } from "@/lib/activation/free-agent-activation";

let mockAnalyticsOwner: string | null = "user_a";
const mockCaptureQueued = jest.fn<
  (input: { event: string; properties?: Record<string, unknown> }) => boolean
>(() => true);

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(() => true),
  captureQueuedAuthenticatedEvent: (input: {
    event: string;
    properties?: Record<string, unknown>;
  }) => mockCaptureQueued(input),
  getPermittedAnalyticsUserId: () => mockAnalyticsOwner,
  subscribeAuthenticatedAnalytics: () => () => {},
}));

const {
  FREE_AGENT_ACTIVATION_STATUS_PATH,
  selectFreeAgentGateSandboxPreference,
  useFreeAgentActivationExposure,
  useFreeAgentActivationStatus,
} = jest.requireActual<typeof import("../useFreeAgentActivation")>(
  "../useFreeAgentActivation",
);

const gated: FreeAgentActivationStatus = {
  variant: "test",
  completedAskResponses: 3,
  introLimit: 3,
  requiresAgent: true,
};

const jsonResponse = (body: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

describe("selectFreeAgentGateSandboxPreference", () => {
  const remoteOld = {
    connectionId: "runner-old",
    isDesktop: false,
    createdAt: 1,
  };
  const desktop = {
    connectionId: "desktop-session",
    environmentId: "env-1",
    isDesktop: true,
    createdAt: 2,
  };
  const remoteNew = {
    connectionId: "runner-new",
    isDesktop: false,
    createdAt: 3,
  };

  it("keeps an explicitly selected computer, even while it is offline", () => {
    expect(
      selectFreeAgentGateSandboxPreference("runner-gone", [remoteNew]),
    ).toBeNull();
  });

  it("does nothing when no computer is connected", () => {
    expect(selectFreeAgentGateSandboxPreference("e2b", [])).toBeNull();
    expect(selectFreeAgentGateSandboxPreference("e2b", undefined)).toBeNull();
  });

  it("prefers a connected Desktop over a newer remote runner", () => {
    expect(
      selectFreeAgentGateSandboxPreference("e2b", [
        remoteOld,
        remoteNew,
        desktop,
      ]),
    ).toBe("desktop-environment:env-1");
  });

  it("falls back to the newest remote runner", () => {
    expect(
      selectFreeAgentGateSandboxPreference("e2b", [remoteOld, remoteNew]),
    ).toBe("runner-new");
  });
});

describe("useFreeAgentActivationStatus", () => {
  beforeEach(() => {
    global.fetch = jest.fn(() =>
      jsonResponse({ status: gated }),
    ) as unknown as typeof fetch;
  });

  it("does not request status while the user is ineligible", () => {
    const { result } = renderHook(() =>
      useFreeAgentActivationStatus({ userId: "user_a", enabled: false }),
    );

    expect(result.current.status).toBeNull();
    expect(result.current.statusKnown).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("treats a pending status as unknown and a valid null as known", async () => {
    global.fetch = jest.fn(() =>
      jsonResponse({ status: null }),
    ) as unknown as typeof fetch;
    const { result } = renderHook(() =>
      useFreeAgentActivationStatus({ userId: "user_a", enabled: true }),
    );
    expect(result.current.statusKnown).toBe(false);

    await waitFor(() => expect(result.current.statusKnown).toBe(true));
    expect(result.current.status).toBeNull();
  });

  it("loads the authenticated status without caching", async () => {
    const { result } = renderHook(() =>
      useFreeAgentActivationStatus({ userId: "user_a", enabled: true }),
    );

    await waitFor(() => expect(result.current.status).toEqual(gated));
    expect(global.fetch).toHaveBeenCalledWith(
      FREE_AGENT_ACTIVATION_STATUS_PATH,
      expect.objectContaining({ credentials: "include", cache: "no-store" }),
    );
  });

  it("drops status immediately when access changes, such as after upgrading", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useFreeAgentActivationStatus({ userId: "user_a", enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.status).toEqual(gated));

    rerender({ enabled: false });

    expect(result.current.status).toBeNull();
  });

  it("never applies one account's status to another account", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    global.fetch = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation(() =>
        jsonResponse({ status: null }),
      ) as unknown as typeof fetch;

    const { result, rerender } = renderHook(
      ({ userId }) => useFreeAgentActivationStatus({ userId, enabled: true }),
      { initialProps: { userId: "user_a" } },
    );
    rerender({ userId: "user_b" });
    await act(async () => {
      resolveFirst({
        ok: true,
        json: () => Promise.resolve({ status: gated }),
      });
    });

    expect(result.current.status).toBeNull();
    // Only user_b's own answer makes its status known.
    await waitFor(() => expect(result.current.statusKnown).toBe(true));
    expect(result.current.status).toBeNull();
  });

  it("starts a new account as unknown even after the previous account was known", async () => {
    global.fetch = jest
      .fn()
      .mockImplementationOnce(() => jsonResponse({ status: null }))
      .mockImplementation(
        () => new Promise(() => {}),
      ) as unknown as typeof fetch;
    const { result, rerender } = renderHook(
      ({ userId }) => useFreeAgentActivationStatus({ userId, enabled: true }),
      { initialProps: { userId: "user_a" } },
    );
    await waitFor(() => expect(result.current.statusKnown).toBe(true));

    rerender({ userId: "user_b" });

    expect(result.current.statusKnown).toBe(false);
  });

  it.each([
    ["a failed request", () => Promise.resolve({ ok: false })],
    ["a malformed body", () => jsonResponse({ status: { variant: "test" } })],
    ["a body without status", () => jsonResponse({})],
  ])(
    "clears a previously gated status but leaves it unknown after %s",
    async (_, nextResponse) => {
      const { result } = renderHook(() =>
        useFreeAgentActivationStatus({ userId: "user_a", enabled: true }),
      );
      await waitFor(() => expect(result.current.status).toEqual(gated));

      jest
        .mocked(global.fetch)
        .mockImplementation(nextResponse as unknown as typeof fetch);
      act(() => result.current.refresh());

      await waitFor(() => expect(result.current.statusKnown).toBe(false));
      expect(result.current.status).toBeNull();
    },
  );
});

describe("useFreeAgentActivationExposure", () => {
  beforeEach(() => {
    mockAnalyticsOwner = "user_a";
    mockCaptureQueued.mockClear();
  });

  it("records exposure and the flag call once when the composer is visible", () => {
    const { rerender } = renderHook(
      ({ visible }) =>
        useFreeAgentActivationExposure({
          userId: "user_a",
          status: { ...gated, variant: "control", requiresAgent: false },
          visible,
          surface: "chat_input",
        }),
      { initialProps: { visible: false } },
    );
    expect(mockCaptureQueued).not.toHaveBeenCalled();

    rerender({ visible: true });
    rerender({ visible: true });

    // Exactly one generic exposure type, the one the experiment reads.
    expect(mockCaptureQueued.mock.calls.map(([input]) => input.event)).toEqual([
      "free_agent_activation_exposed",
      "$experiment_exposure",
    ]);
    expect(mockCaptureQueued.mock.calls[1][0].properties).toEqual({
      $feature_flag: "free_agent_activation_gate_v1",
      $feature_flag_response: "control",
    });
  });

  it("waits for a background tab to become visible before recording exposure", () => {
    const setVisibility = (state: DocumentVisibilityState) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    setVisibility("hidden");
    try {
      renderHook(() =>
        useFreeAgentActivationExposure({
          userId: "user_a",
          status: gated,
          visible: true,
          surface: "chat_input",
        }),
      );
      expect(mockCaptureQueued).not.toHaveBeenCalled();

      act(() => setVisibility("visible"));
      act(() => setVisibility("hidden"));
      act(() => setVisibility("visible"));

      expect(
        mockCaptureQueued.mock.calls.map(([input]) => input.event),
      ).toEqual(["free_agent_activation_exposed", "$experiment_exposure"]);
    } finally {
      setVisibility("visible");
    }
  });

  it("retries only the exposure that could not be recorded", () => {
    mockCaptureQueued
      .mockImplementationOnce(() => true)
      .mockImplementationOnce(() => false);
    const { rerender } = renderHook(
      ({ completedAskResponses }) =>
        useFreeAgentActivationExposure({
          userId: "user_a",
          status: { ...gated, completedAskResponses },
          visible: true,
          surface: "chat_input",
        }),
      { initialProps: { completedAskResponses: 2 } },
    );

    // A status refresh re-runs the effect; the custom event is not repeated.
    rerender({ completedAskResponses: 3 });

    expect(mockCaptureQueued.mock.calls.map(([input]) => input.event)).toEqual([
      "free_agent_activation_exposed",
      "$experiment_exposure",
      "$experiment_exposure",
    ]);
  });

  it("waits until analytics belongs to the same account", () => {
    mockAnalyticsOwner = "someone_else";
    renderHook(() =>
      useFreeAgentActivationExposure({
        userId: "user_a",
        status: gated,
        visible: true,
        surface: "chat_input",
      }),
    );

    expect(mockCaptureQueued).not.toHaveBeenCalled();
  });
});
