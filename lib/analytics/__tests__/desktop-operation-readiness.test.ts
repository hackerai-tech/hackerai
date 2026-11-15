jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(() => true),
  getIdentifiedAnalyticsUserId: jest.fn(() => "user_A"),
  getPermittedAnalyticsUserId: jest.fn(() => "user_A"),
}));

import {
  captureAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
  getPermittedAnalyticsUserId,
} from "@/lib/analytics/client";
import {
  captureDesktopOperationReadinessFailure,
  sanitizeDesktopOperationReadinessEvent,
} from "../desktop-operation-readiness";

const CONNECTION_ID = "0193a5b2-7c41-7a10-8f00-111111111111";
const OPERATION_ID = "0193a5b2-7c41-7a10-8f00-222222222222";
const originalBuild = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;

const diagnostic = {
  state: "error",
  clientSurface: "desktop_bridge",
  source: "operation_channel",
  errorType: "operation_readiness",
  connectionId: CONNECTION_ID,
  operation_readiness_version: 1,
  operation_readiness_phase: "readiness_publish",
  operation_readiness_kind: "file",
  operation_readiness_operation_id: OPERATION_ID,
  build_state: "measured",
  hackerai_frontend_build_commit: "b".repeat(40),
};

afterEach(() => {
  jest.clearAllMocks();
  jest.mocked(getPermittedAnalyticsUserId).mockReturnValue("user_A");
  jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue("user_A");
  if (originalBuild === undefined)
    delete process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
  else process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = originalBuild;
});

describe("captureDesktopOperationReadinessFailure", () => {
  const failure = {
    owner: "user_A",
    connectionId: CONNECTION_ID,
    phase: "readiness_publish",
    kind: "file",
    operationId: OPERATION_ID,
  };

  it("captures the finite tuple with the measured or unavailable build", () => {
    process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = "B".repeat(40);
    expect(captureDesktopOperationReadinessFailure(failure)).toBe(true);
    process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = "not-a-commit";
    expect(captureDesktopOperationReadinessFailure(failure)).toBe(true);
    const { hackerai_frontend_build_commit: _commit, ...unmeasured } =
      diagnostic;
    expect(jest.mocked(captureAuthenticatedEvent).mock.calls).toEqual([
      ["desktop_bridge_relay_error", diagnostic],
      [
        "desktop_bridge_relay_error",
        { ...unmeasured, build_state: "unavailable" },
      ],
    ]);
  });

  it.each([
    ["another permitted owner", () => mockOwners("user_B", "user_B")],
    ["a pending identification", () => mockOwners("user_A", null)],
    ["withdrawn consent", () => mockOwners(null, null)],
    [
      "an unreadable owner",
      () =>
        jest.mocked(getPermittedAnalyticsUserId).mockImplementation(() => {
          throw new Error("unavailable");
        }),
    ],
  ])("captures nothing for %s", (_name, setup) => {
    setup();
    expect(captureDesktopOperationReadinessFailure(failure)).toBe(false);
    expect(captureAuthenticatedEvent).not.toHaveBeenCalled();
  });

  it.each([
    { owner: "user@example.com" },
    { phase: "operation_ready" },
    { kind: "terminal" },
    { operationId: "cat /etc/passwd" },
    { operationId: `${OPERATION_ID}0` },
    { connectionId: "conn-123" },
  ])("captures nothing for an out-of-schema %p", (override) => {
    if (override.owner) mockOwners(override.owner, override.owner);
    expect(
      captureDesktopOperationReadinessFailure({ ...failure, ...override }),
    ).toBe(false);
    expect(captureAuthenticatedEvent).not.toHaveBeenCalled();
  });
});

function mockOwners(permitted: string | null, identified: string | null) {
  jest.mocked(getPermittedAnalyticsUserId).mockReturnValue(permitted);
  jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue(identified);
}

describe("sanitizeDesktopOperationReadinessEvent", () => {
  const expected = () => ({ owner: "user_A", token: "phc_test" });
  const transport = {
    token: "phc_test",
    distinct_id: "user_A",
    $session_id: "0193a5b2-7c41-7a10-8f00-aaaaaaaaaaaa",
    $lib: "web",
    $is_identified: true,
  };
  const event = (properties: object) => ({
    uuid: "0193a5b2-7c41-7a10-8f00-333333333333",
    event: "desktop_bridge_relay_error",
    properties,
    timestamp: new Date(1_794_094_000_000),
  });

  it("rebuilds only the tuple and approved transport without running accessors", () => {
    const accessor = jest.fn(() => "PRIVATE");
    const properties = Object.defineProperty(
      {
        ...transport,
        ...diagnostic,
        $current_url: "https://hackerai.co/c/PRIVATE?code=PRIVATE",
        $set: { email: "PRIVATE" },
        error: "PRIVATE relay error",
        cause: "PRIVATE",
        code: 3,
        command: "cat PRIVATE",
        native_os_version: "PRIVATE",
      },
      "stack",
      { get: accessor, enumerable: true },
    );
    const sanitized = sanitizeDesktopOperationReadinessEvent(
      event(properties),
      expected,
    );
    expect(sanitized).toEqual(event({ ...transport, ...diagnostic }));
    expect(JSON.stringify(sanitized)).not.toMatch(/PRIVATE|"code"/);
    expect(accessor).not.toHaveBeenCalled();
  });

  it("accepts the null commit native capture writes for an unavailable build", () => {
    const { hackerai_frontend_build_commit: _commit, ...unmeasured } =
      diagnostic;
    const properties = {
      ...transport,
      ...unmeasured,
      build_state: "unavailable",
      hackerai_frontend_build_commit: null,
    };
    expect(
      sanitizeDesktopOperationReadinessEvent(event(properties), expected)
        ?.properties,
    ).toEqual({ ...transport, ...unmeasured, build_state: "unavailable" });
  });

  it.each([
    ["version", { operation_readiness_version: 2 }],
    ["phase", { operation_readiness_phase: "execution" }],
    ["kind", { operation_readiness_kind: "terminal" }],
    ["operation ID", { operation_readiness_operation_id: "PRIVATE" }],
    ["connection ID", { connectionId: `${CONNECTION_ID} ` }],
    [
      "build state",
      { build_state: "measured", hackerai_frontend_build_commit: null },
    ],
    ["build commit", { hackerai_frontend_build_commit: "B".repeat(40) }],
    ["envelope", { source: "subscription" }],
    ["owner", { distinct_id: "user_B" }],
  ])("drops a malformed %s", (_name, override) => {
    expect(
      sanitizeDesktopOperationReadinessEvent(
        event({ ...transport, ...diagnostic, ...override }),
        expected,
      ),
    ).toBeNull();
  });

  it("drops the diagnostic when the committed owner is absent or changed", () => {
    const properties = { ...transport, ...diagnostic };
    for (const owner of [null, "user_B"]) {
      expect(
        sanitizeDesktopOperationReadinessEvent(event(properties), () => ({
          owner,
          token: "phc_test",
        })),
      ).toBeNull();
    }
  });

  it("drops an accessor, inherited or throwing proxy diagnostic without throwing", () => {
    const getter = jest.fn(() => 1);
    const accessorVersion = Object.defineProperty(
      { ...transport, ...diagnostic },
      "operation_readiness_version",
      { get: getter, enumerable: true },
    );
    const inherited = Object.assign(Object.create(diagnostic), transport);
    const hostile = new Proxy(
      { ...transport, ...diagnostic },
      {
        getOwnPropertyDescriptor() {
          throw new Error("PRIVATE trap");
        },
      },
    );
    const accessorBag = Object.defineProperty(
      { event: "desktop_bridge_relay_error" },
      "properties",
      { get: () => ({ ...transport, ...diagnostic }), enumerable: true },
    );
    for (const candidate of [
      event(accessorVersion),
      event(inherited),
      event(hostile),
      accessorBag,
    ]) {
      expect(
        sanitizeDesktopOperationReadinessEvent(candidate, expected),
      ).toBeNull();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("returns unrelated relay errors and other events unchanged", () => {
    const resolve = jest.fn(expected);
    const relayError = event({
      ...transport,
      state: "error",
      clientSurface: "desktop_bridge",
      source: "subscription",
      errorType: "startup_readiness",
      error: "kept as before",
    });
    const other = { event: "ordinary_event", properties: { diagnostic } };
    expect(sanitizeDesktopOperationReadinessEvent(relayError, resolve)).toBe(
      relayError,
    );
    expect(sanitizeDesktopOperationReadinessEvent(other, resolve)).toBe(other);
    expect(resolve).not.toHaveBeenCalled();
  });
});
