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
const { beginServerActionDiagnostic, recordGlobalServerActionDecision } =
  require("../server-action-diagnostics") as typeof import("../server-action-diagnostics");

const EVENT = "server_action_client_context";
const BUILD = "0123456789".repeat(4);
const unavailable = () =>
  new Error(
    `Server Action "${"0a".repeat(21)}" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action`,
  );
const originalKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const originalBuild = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;

function identify(userId: string | null) {
  setAuthenticatedAnalyticsUserId(userId);
  if (userId) confirmAuthenticatedAnalyticsUserId(userId);
}

function contexts() {
  return mockCapture.mock.calls
    .filter(([event]) => event === EVENT)
    .map(([, properties]) => properties as Record<string, unknown>);
}

function settleConsent(error?: unknown) {
  beginServerActionDiagnostic("analytics_consent")(error);
}

describe("server action diagnostics", () => {
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
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    // Every test starts in a new owner epoch.
    identify(null);
    identify("user-a");
    mockCapture.mockClear();
  });

  it("counts same-owner settlements once and reports only recognized rejections", () => {
    settleConsent();
    settleConsent(new Error("network"));
    const settle = beginServerActionDiagnostic("analytics_consent");
    settle(unavailable());
    settle(unavailable());
    settle();

    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(
      EVENT,
      {
        server_action_client_diagnostic_version: 1,
        caller: "analytics_consent",
        matched_pattern: "next_unrecognized_action_message",
        reference_shape: "hex42",
        recovery_decision: "locally_handled_no_reload",
        build_state: "measured",
        hackerai_frontend_build_commit: BUILD,
        attempt_denominator_kind: "caller_settled_prefix",
        caller_settled_attempt_count: 3,
        caller_recognized_rejection_count: 1,
      },
      { uuid: expect.any(String) },
    );
  });

  it.each<[string, (string | null)[]]>([
    ["switches account", ["user-b"]],
    ["revokes consent", [null]],
    ["leaves and re-enters", [null, "user-a"]],
  ])(
    "drops an in-flight settlement when the owner %s",
    (_name, transitions) => {
      const settle = beginServerActionDiagnostic("billing_renewal_recovery");
      transitions.forEach(identify);
      settle(unavailable());
      expect(contexts()).toEqual([]);

      // The current owner's next attempt starts a fresh prefix.
      if (transitions.at(-1)) {
        beginServerActionDiagnostic("billing_renewal_recovery")(unavailable());
        expect(contexts()).toEqual([
          expect.objectContaining({
            caller_settled_attempt_count: 1,
            caller_recognized_rejection_count: 1,
          }),
        ]);
      }
    },
  );

  it("keeps the epoch through a duplicate same-owner confirmation", () => {
    const settle = beginServerActionDiagnostic("analytics_consent");
    confirmAuthenticatedAnalyticsUserId("user-a");
    settle(unavailable());
    expect(contexts()).toHaveLength(1);
  });

  it("does not observe permitted-but-unidentified or anonymous owners", () => {
    setAuthenticatedAnalyticsUserId("user-pending");
    beginServerActionDiagnostic("analytics_consent")(unavailable());
    recordGlobalServerActionDecision(
      "global_error",
      unavailable(),
      "reload_requested",
    );
    identify(null);
    beginServerActionDiagnostic("analytics_consent")(unavailable());
    recordGlobalServerActionDecision(
      "global_error",
      unavailable(),
      "reload_requested",
    );
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("dedupes repeated contexts while preserving distinct callers and decisions", () => {
    settleConsent(unavailable());
    settleConsent(unavailable());
    beginServerActionDiagnostic("billing_renewal_recovery")(unavailable());
    for (const decision of [
      "reload_requested",
      "cooldown_skipped",
      "cooldown_skipped",
    ] as const) {
      recordGlobalServerActionDecision(
        "global_unhandled_rejection",
        unavailable(),
        decision,
      );
    }
    recordGlobalServerActionDecision(
      "global_error",
      new Error("ChunkLoadError: Loading chunk 7 failed."),
      "reload_requested",
    );

    expect(
      contexts().map(({ caller, recovery_decision }) => [
        caller,
        recovery_decision,
      ]),
    ).toEqual([
      ["analytics_consent", "locally_handled_no_reload"],
      ["billing_renewal_recovery", "locally_handled_no_reload"],
      ["global_unhandled_rejection", "reload_requested"],
      ["global_unhandled_rejection", "cooldown_skipped"],
    ]);
    expect(contexts()[2]).toEqual({
      server_action_client_diagnostic_version: 1,
      caller: "global_unhandled_rejection",
      matched_pattern: "next_unrecognized_action_message",
      reference_shape: "hex42",
      recovery_decision: "reload_requested",
      build_state: "measured",
      hackerai_frontend_build_commit: BUILD,
      attempt_denominator_kind: "unmeasured",
    });

    identify("user-b");
    settleConsent(unavailable());
    expect(contexts()).toHaveLength(5);
  });

  it("lets a later eligible attempt report after the queue rejects capture", () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    settleConsent(unavailable());
    expect(mockCapture).not.toHaveBeenCalled();

    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    settleConsent(unavailable());
    expect(contexts()).toEqual([
      expect.objectContaining({
        caller_settled_attempt_count: 2,
        caller_recognized_rejection_count: 2,
      }),
    ]);
  });

  it("reports an overflowed prefix as unmeasured", () => {
    for (let attempt = 0; attempt < 10_000; attempt += 1) settleConsent();
    settleConsent(unavailable());

    expect(contexts()).toHaveLength(1);
    expect(contexts()[0]).toMatchObject({
      attempt_denominator_kind: "unmeasured",
    });
    expect(contexts()[0]).not.toHaveProperty("caller_settled_attempt_count");
    expect(contexts()[0]).not.toHaveProperty(
      "caller_recognized_rejection_count",
    );
  });

  it("fails closed without throwing for hostile rejection values", () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("blocked");
        },
      },
    );
    expect(() => settleConsent(hostile)).not.toThrow();
    expect(() =>
      recordGlobalServerActionDecision(
        "global_error",
        hostile,
        "cooldown_skipped",
      ),
    ).not.toThrow();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it.each<[string, (string | null)[]]>([
    ["switches account", ["user-b"]],
    ["leaves and re-enters", [null, "user-a"]],
  ])(
    "drops a recognized value whose message read %s, then starts a clean prefix",
    (_name, transitions) => {
      // Reading the message synchronously changes analytics identity.
      const switching = () =>
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor(_target, key) {
              if (key !== "message") return undefined;
              transitions.forEach(identify);
              return {
                value: unavailable().message,
                writable: true,
                enumerable: true,
                configurable: true,
              };
            },
          },
        );
      settleConsent();
      settleConsent(switching());
      expect(contexts()).toEqual([]);

      // The new owner's next real settlement starts an uncontaminated prefix.
      settleConsent(unavailable());
      expect(contexts()).toEqual([
        expect.objectContaining({
          caller_settled_attempt_count: 1,
          caller_recognized_rejection_count: 1,
        }),
      ]);

      identify("user-a");
      mockCapture.mockClear();
      recordGlobalServerActionDecision(
        "global_error",
        switching(),
        "reload_requested",
      );
      expect(contexts()).toEqual([]);
    },
  );

  it("drops a report when nonce creation changes the owner", async () => {
    await jest.isolateModulesAsync(async () => {
      const isolatedClient = require("../client") as typeof import("../client");
      const isolated =
        require("../server-action-diagnostics") as typeof import("../server-action-diagnostics");
      const identifyIsolated = (userId: string) => {
        isolatedClient.setAuthenticatedAnalyticsUserId(userId);
        isolatedClient.confirmAuthenticatedAnalyticsUserId(userId);
      };
      await isolatedClient.loadPostHogClient();
      identifyIsolated("user-a");
      const randomUUID = jest
        .spyOn(globalThis.crypto, "randomUUID")
        .mockImplementation(() => {
          identifyIsolated("user-b");
          return "00000000-0000-4000-8000-000000000000";
        });
      try {
        isolated.beginServerActionDiagnostic("analytics_consent")(
          unavailable(),
        );
        expect(mockCapture).not.toHaveBeenCalled();
      } finally {
        randomUUID.mockRestore();
      }

      isolated.beginServerActionDiagnostic("analytics_consent")(unavailable());
      expect(contexts()).toEqual([
        expect.objectContaining({
          caller_settled_attempt_count: 1,
          caller_recognized_rejection_count: 1,
        }),
      ]);
      expect(mockCapture.mock.calls[0][2]).toEqual({
        uuid: expect.any(String),
      });
    });
  });

  it("does not report until a document nonce can be created", async () => {
    await jest.isolateModulesAsync(async () => {
      const isolatedClient = require("../client") as typeof import("../client");
      const isolated =
        require("../server-action-diagnostics") as typeof import("../server-action-diagnostics");
      await isolatedClient.loadPostHogClient();
      isolatedClient.setAuthenticatedAnalyticsUserId("user-a");
      isolatedClient.confirmAuthenticatedAnalyticsUserId("user-a");
      const randomUUID = jest
        .spyOn(globalThis.crypto, "randomUUID")
        .mockImplementation(() => {
          throw new Error("crypto unavailable");
        });
      try {
        expect(() =>
          isolated.beginServerActionDiagnostic("analytics_consent")(
            unavailable(),
          ),
        ).not.toThrow();
        expect(mockCapture).not.toHaveBeenCalled();
      } finally {
        randomUUID.mockRestore();
      }

      isolated.beginServerActionDiagnostic("analytics_consent")(unavailable());
      expect(contexts()).toEqual([
        expect.objectContaining({ caller_recognized_rejection_count: 2 }),
      ]);
    });
  });
});
