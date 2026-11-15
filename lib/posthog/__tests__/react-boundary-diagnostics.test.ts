import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

// A minimal stand-in for the analytics owner store: two reads and the change
// notification the provider's setAuthenticated/confirm calls emit.
const mockOwners: { permitted: string | null; identified: string | null } = {
  permitted: null,
  identified: null,
};
const mockListeners = new Set<() => void>();
jest.mock("@/lib/analytics/client", () => ({
  getIdentifiedAnalyticsUserId: jest.fn(() =>
    mockOwners.identified === mockOwners.permitted
      ? mockOwners.identified
      : null,
  ),
  getPermittedAnalyticsUserId: jest.fn(() => mockOwners.permitted),
  subscribeAuthenticatedAnalytics: jest.fn((listener: () => void) => {
    mockListeners.add(listener);
    return () => {
      mockListeners.delete(listener);
    };
  }),
}));

const {
  clearReactBoundaryCatches,
  getReactBoundaryDiagnostics,
  recordReactBoundaryCatch,
  registerReactBoundaryScope,
  startReactBoundaryDiagnostics,
} =
  require("../react-boundary-diagnostics") as typeof import("../react-boundary-diagnostics");
const client = jest.requireMock<typeof import("@/lib/analytics/client")>(
  "@/lib/analytics/client",
);

/** Mirror setAuthenticatedAnalyticsUserId then confirm: each notifies. */
function switchOwner(owner: string | null) {
  mockOwners.permitted = owner;
  mockOwners.identified = null;
  mockListeners.forEach((listener) => listener());
  if (!owner) return;
  mockOwners.identified = owner;
  mockListeners.forEach((listener) => listener());
}

const recent = (owner: string | null = "owner-a") => {
  const fields = getReactBoundaryDiagnostics(owner);
  return {
    observer: fields.hackerai_react_boundary_observer_state,
    state: fields.hackerai_react_boundary_recent_catch_state,
    scope: fields.hackerai_react_boundary_recent_scope,
    age: fields.hackerai_react_boundary_recent_age,
  };
};

describe("React boundary diagnostics", () => {
  let now = 10_000;
  const stops: Array<() => void> = [];
  const disposers: Array<() => void> = [];
  const start = () => {
    const stop = startReactBoundaryDiagnostics();
    stops.push(stop);
    return stop;
  };
  const register = (scope: unknown) => {
    const dispose = registerReactBoundaryScope(scope);
    disposers.push(dispose);
    return dispose;
  };

  beforeEach(() => {
    now = 10_000;
    jest.spyOn(performance, "now").mockImplementation(() => now);
    switchOwner("owner-a");
  });

  afterEach(() => {
    stops.splice(0).forEach((stop) => stop());
    disposers.splice(0).forEach((dispose) => dispose());
    switchOwner(null);
    jest.restoreAllMocks();
  });

  it("reports the current mounted scopes, including boundaries mounted before identification", () => {
    switchOwner(null);
    const content = register("chat_content");
    const secondContent = register("chat_content");
    register("PRIVATE-user-derived-scope");
    switchOwner("owner-a");
    start();

    const fields = getReactBoundaryDiagnostics("owner-a");
    expect(fields).toEqual({
      hackerai_react_boundary_context_version: 1,
      hackerai_react_boundary_observer_state: "active",
      hackerai_react_boundary_chat_content_mounted: true,
      hackerai_react_boundary_chat_layout_mounted: false,
      hackerai_react_boundary_unknown_scope_mounted: true,
      hackerai_react_boundary_recent_catch_state: "none",
    });
    expect(JSON.stringify(fields)).not.toMatch(/PRIVATE|owner-a/);

    // A repeated disposer cannot remove another mounted boundary's presence.
    content();
    content();
    expect(
      getReactBoundaryDiagnostics("owner-a")
        .hackerai_react_boundary_chat_content_mounted,
    ).toBe(true);
    secondContent();
    expect(
      getReactBoundaryDiagnostics("owner-a")
        .hackerai_react_boundary_chat_content_mounted,
    ).toBe(false);
  });

  it("reports an inactive observer as unavailable rather than as no catch", () => {
    recordReactBoundaryCatch("chat_content");
    expect(recent()).toEqual({
      observer: "inactive",
      state: "unavailable",
      scope: undefined,
      age: undefined,
    });
  });

  it("reports a recent catch's fixed scope and coarse age within one second", () => {
    start();
    recordReactBoundaryCatch("chat_layout");
    expect(recent()).toEqual({
      observer: "active",
      state: "observed",
      scope: "chat_layout",
      age: "lt_50ms",
    });
    now += 249;
    expect(recent().age).toBe("lt_250ms");
    now += 750;
    expect(recent().age).toBe("lt_1000ms");
    now += 1;
    expect(recent()).toMatchObject({ state: "none", scope: undefined });
  });

  it("reports multiple recent scopes without counts, and evicts beyond the cap", () => {
    start();
    recordReactBoundaryCatch("chat_layout");
    recordReactBoundaryCatch("PRIVATE-user-derived-scope");
    expect(recent().scope).toBe("multiple");
    expect(
      JSON.stringify(getReactBoundaryDiagnostics("owner-a")),
    ).not.toContain("PRIVATE");

    for (let index = 0; index < 16; index++) {
      recordReactBoundaryCatch("chat_content");
    }
    expect(recent()).toMatchObject({
      state: "observed",
      scope: "chat_content",
    });
  });

  it("fails closed after a clock regression instead of reporting an age", () => {
    start();
    recordReactBoundaryCatch("chat_content");
    now -= 1;
    expect(recent()).toMatchObject({
      observer: "active",
      state: "unavailable",
    });
    now += 1;
    expect(recent().state).toBe("none");
  });

  it("attaches nothing without the current committed owner and discards the catch", () => {
    start();
    recordReactBoundaryCatch("chat_content");
    expect(getReactBoundaryDiagnostics(null)).toEqual({});
    expect(recent().state).toBe("none");

    recordReactBoundaryCatch("chat_content");
    expect(getReactBoundaryDiagnostics("owner-b")).toEqual({});
    expect(recent().state).toBe("none");
  });

  it("never records for a mismatched permitted and identified owner", () => {
    start();
    mockOwners.permitted = "owner-b";
    recordReactBoundaryCatch("chat_content");
    mockOwners.permitted = "owner-a";
    expect(recent().state).toBe("none");
  });

  it("clears on A to B to A, then records a fresh catch for the returning owner", () => {
    start();
    recordReactBoundaryCatch("chat_content");
    switchOwner("owner-b");
    // B never sees A's observer as its own.
    expect(recent("owner-b")).toMatchObject({
      observer: "inactive",
      state: "unavailable",
    });
    recordReactBoundaryCatch("chat_layout");
    switchOwner("owner-a");
    expect(recent().state).toBe("none");

    recordReactBoundaryCatch("chat_layout");
    expect(recent()).toMatchObject({ state: "observed", scope: "chat_layout" });
  });

  it("does not let a late cleanup stop a newer observer", () => {
    const first = start();
    recordReactBoundaryCatch("chat_layout");
    const second = start();
    expect(recent().state).toBe("none");
    first();
    recordReactBoundaryCatch("chat_content");
    expect(recent()).toMatchObject({
      observer: "active",
      scope: "chat_content",
    });

    second();
    second();
    expect(recent().observer).toBe("inactive");
    // The replaced and stopped observers no longer receive owner changes.
    expect(mockListeners.size).toBe(0);
  });

  it("keeps unreadable owner reads optional and fail-closed", () => {
    start();
    recordReactBoundaryCatch("chat_content");
    jest
      .mocked(client.getIdentifiedAnalyticsUserId)
      .mockImplementationOnce(() => {
        throw new Error("PRIVATE identity failure");
      });
    expect(() => recordReactBoundaryCatch("chat_layout")).not.toThrow();
    expect(recent()).toMatchObject({ observer: "active", state: "none" });

    recordReactBoundaryCatch("chat_content");
    jest
      .mocked(client.getPermittedAnalyticsUserId)
      .mockImplementationOnce(() => {
        throw new Error("PRIVATE identity failure");
      });
    expect(getReactBoundaryDiagnostics("owner-a")).toEqual({});
    expect(recent().state).toBe("none");

    // An unreadable start leaves no observer and no prior data behind.
    recordReactBoundaryCatch("chat_content");
    jest
      .mocked(client.getIdentifiedAnalyticsUserId)
      .mockImplementationOnce(() => {
        throw new Error("PRIVATE identity failure");
      });
    expect(() => start()).not.toThrow();
    expect(recent()).toMatchObject({
      observer: "inactive",
      state: "unavailable",
    });
    expect(mockListeners.size).toBe(0);
  });

  it("clears recent catches without stopping the observer", () => {
    start();
    recordReactBoundaryCatch("chat_content");
    clearReactBoundaryCatches();
    expect(recent()).toMatchObject({ observer: "active", state: "none" });
    recordReactBoundaryCatch("chat_content");
    expect(recent().state).toBe("observed");
  });
});
