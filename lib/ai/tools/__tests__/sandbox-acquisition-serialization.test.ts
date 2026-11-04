const mockGetSandboxWithFallbackGuard = jest.fn();
const mockResetSandbox = jest.fn();
const mockQuarantineLocalConnection = jest.fn();
const mockIsE2BSandbox = jest.fn();
const mockLoggerWarn = jest.fn();
let mockTrackSandboxUsage: ((sandbox: unknown) => void) | undefined;
const mockNetworkQuery = jest.fn();
const mockCaptchaSolve = jest.fn();
jest.mock("../../captcha/solver", () => ({
  createTwoCaptchaSolver: () => ({ solve: mockCaptchaSolve }),
}));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockNetworkQuery }),
}));

jest.mock("../run-terminal-cmd", () => ({
  createRunTerminalCmd: jest.fn(() => ({})),
}));
jest.mock("../interact-terminal-session", () => ({
  createInteractTerminalSession: jest.fn(() => ({})),
}));
jest.mock("../get-terminal-files", () => ({
  createGetTerminalFiles: jest.fn(() => ({})),
}));
jest.mock("../file", () => ({
  createFile: jest.fn(() => ({})),
  createFileEdit: jest.fn(() => ({})),
  createFileWrite: jest.fn(() => ({})),
}));
jest.mock("../web-search", () => ({ createWebSearch: jest.fn(() => ({})) }));
jest.mock("../open-url", () => ({ createOpenUrlTool: jest.fn(() => ({})) }));
jest.mock("../todo-write", () => ({ createTodoWrite: jest.fn(() => ({})) }));
jest.mock("../notes", () => ({
  createCreateNote: jest.fn(() => ({})),
  createListNotes: jest.fn(() => ({})),
  createUpdateNote: jest.fn(() => ({})),
  createDeleteNote: jest.fn(() => ({})),
}));

jest.mock("../utils/hybrid-sandbox-manager", () => ({
  HybridSandboxManager: jest
    .fn()
    .mockImplementation((_userId, trackSandboxUsage, preference) => {
      mockTrackSandboxUsage = trackSandboxUsage;
      return {
        getEffectivePreference: () => preference,
        resetSandbox: mockResetSandbox,
        quarantineLocalConnection: mockQuarantineLocalConnection,
      };
    }),
}));

jest.mock("../utils/sandbox-manager", () => ({
  DefaultSandboxManager: jest.fn(() => ({
    getEffectivePreference: () => "e2b",
  })),
}));

jest.mock("../utils/sandbox-types", () => ({
  isE2BSandbox: (...args: unknown[]) => mockIsE2BSandbox(...args),
  getCloudSandboxProviderForInstance: (
    sandbox: { provider?: string } | null,
  ) => (sandbox?.provider === "e2b" ? sandbox.provider : null),
}));

jest.mock("../utils/sandbox-fallback", () => ({
  getSandboxWithFallbackGuard: (...args: unknown[]) =>
    mockGetSandboxWithFallbackGuard(...args),
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn() },
  getPostHogBooleanFlagDecisionForUser: jest.fn(async () => true),
}));
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args) },
}));

import { createTools } from "..";
import { E2B_COST_PER_MS } from "../utils/e2b-cost";
import { BrowserSessions } from "../utils/browser-sessions";
import { DETECT_CHALLENGES_SCRIPT } from "../../captcha/detection";

describe("sandbox acquisition serialization", () => {
  it("retains the CAPTCHA attempt budget across provider fallback and excludes Production", async () => {
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      HACKERAI_CAPTCHA_SOLVER_PREVIEW: "1",
      CAPTCHA_SOLVER_PREVIEW_USER_IDS: "user-1",
      TWOCAPTCHA_API_KEY: "test-provider-key",
    };
    const evaluator = jest
      .spyOn(BrowserSessions.prototype, "getChallengeBrowser")
      .mockResolvedValue({
        identity: "owner:default",
        evaluate: async (script) =>
          script === DETECT_CHALLENGES_SCRIPT
            ? {
                url: "https://www.google.com/recaptcha/api2/demo",
                documentId: "1",
                interstitial: false,
                widgets: [
                  {
                    kind: "recaptcha_v2",
                    siteKey: "6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-",
                    invisible: false,
                    observationId: "0123456789abcdef0123456789abcdef",
                    tokenPresent: false,
                  },
                ],
              }
            : { status: "token_delivered" },
      });
    mockCaptchaSolve.mockResolvedValue({
      token: "test-response",
      costDollars: 0.003,
    });
    try {
      const args: Parameters<typeof createTools> = [
        "user-1",
        "chat-1",
        {} as never,
        "agent",
        {} as never,
      ];
      args[20] = "run-1";
      args[22] = { environment: "PREVIEW" };
      const preview = createTools(...args);
      expect(preview.tools.browser_challenge).toBeDefined();
      await expect(
        preview.tools.browser_challenge.execute!(
          { action: "solve" },
          { toolCallId: "first", messages: [] },
        ),
      ).resolves.toMatchObject({ status: "token_delivered" });
      await expect(
        preview.getToolsForModel("fallback-model").browser_challenge.execute!(
          { action: "solve" },
          { toolCallId: "fallback", messages: [] },
        ),
      ).resolves.toMatchObject({ reason: "attempt_limit" });
      expect(mockCaptchaSolve).toHaveBeenCalledTimes(1);
      args[22] = { environment: "PRODUCTION" };
      expect(createTools(...args).tools.browser_challenge).toBeUndefined();
      args[22] = { environment: "PREVIEW", browserAgentId: "child-1" };
      expect(createTools(...args).tools.browser_challenge).toBeUndefined();
    } finally {
      evaluator.mockRestore();
      process.env = originalEnv;
    }
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockResetSandbox.mockResolvedValue(undefined);
    mockQuarantineLocalConnection.mockResolvedValue(undefined);
    mockIsE2BSandbox.mockReturnValue(false);
    mockTrackSandboxUsage = undefined;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("dispatches parent delegation and child tools without a scope lookup", async () => {
    const execute = jest.fn().mockResolvedValue({ result: "completed" });
    mockNetworkQuery.mockRejectedValue(new Error("scope storage unavailable"));
    const args: Parameters<typeof createTools> = [
      "user-1",
      "chat-1",
      {} as never,
      "agent",
      {} as never,
    ];
    args[22] = {
      additionalTools: () => ({ delegate_task: { execute } as never }),
    };
    const { tools, getToolsForModel } = createTools(...args);
    const input = { task: "bounded offline analysis" };
    await tools.delegate_task.execute!(input, {
      toolCallId: "parent",
      messages: [],
    });
    await getToolsForModel("test-model").delegate_task.execute!(input, {
      toolCallId: "child",
      messages: [],
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(mockNetworkQuery).not.toHaveBeenCalled();
  });

  it.each([
    ["agent", "e2b", true],
    ["agent", undefined, true],
    ["agent", "desktop", false],
    ["agent", "connection-1", false],
    ["ask", "e2b", false],
  ] as const)(
    "includes network context for %s/%s only when executing in E2B",
    async (mode, preference, expected) => {
      mockNetworkQuery.mockResolvedValue({
        policy: { mode: "offline", allow: [] },
        revision: 1,
        status: "ready",
      });
      const { cloudNetworkPrompt } = createTools(
        "user-1",
        "chat-1",
        {} as never,
        mode,
        {} as never,
        [],
        false,
        undefined,
        preference,
        "test-service-key",
      );
      const prompt = await cloudNetworkPrompt();
      if (expected) expect(prompt).toContain("Saved access: No internet");
      else {
        expect(prompt).toBe("");
        expect(mockNetworkQuery).not.toHaveBeenCalled();
      }
    },
  );

  it("does not let a pre-reset acquisition replace the refreshed sandbox", async () => {
    let resolveFirst!: (value: { sandbox: { id: string } }) => void;
    const firstAcquisition = new Promise<{ sandbox: { id: string } }>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    mockGetSandboxWithFallbackGuard
      .mockReturnValueOnce(firstAcquisition)
      .mockResolvedValueOnce({ sandbox: { id: "refreshed" } });
    const { ensureSandbox } = createTools(
      "user-1",
      "chat-1",
      {} as never,
      "agent",
      {} as never,
      undefined,
      true,
      undefined,
      "e2b",
      "service-key",
    );

    const original = ensureSandbox();
    await Promise.resolve();
    const refresh = ensureSandbox({ refresh: true, reason: "health_check" });
    const joinedAfterRefresh = ensureSandbox();
    resolveFirst({ sandbox: { id: "original" } });

    await expect(original).resolves.toEqual({ id: "original" });
    await expect(refresh).resolves.toEqual({ id: "refreshed" });
    await expect(joinedAfterRefresh).resolves.toEqual({ id: "refreshed" });
    expect(mockResetSandbox).toHaveBeenCalledWith("health_check");
    expect(mockGetSandboxWithFallbackGuard).toHaveBeenCalledTimes(2);
    expect(mockResetSandbox.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockGetSandboxWithFallbackGuard.mock.invocationCallOrder[0],
    );
  });

  it("accounts for E2B runtime", async () => {
    jest.useFakeTimers();
    mockIsE2BSandbox.mockImplementation(
      (sandbox: { provider?: string } | null) => sandbox?.provider === "e2b",
    );
    const { getSandboxSessionCost, getSandboxSessionUsage } = createTools(
      "user-1",
      "chat-1",
      {} as never,
      "agent",
      {} as never,
      undefined,
      true,
      undefined,
      "e2b",
      "service-key",
    );

    mockTrackSandboxUsage?.({ provider: "e2b" });
    jest.advanceTimersByTime(1_000);

    await expect(getSandboxSessionCost()).resolves.toBeCloseTo(
      E2B_COST_PER_MS * 1_000,
      12,
    );
    await expect(getSandboxSessionUsage()).resolves.toEqual({
      totalCostDollars: E2B_COST_PER_MS * 1_000,
      e2bRuntimeMs: 1_000,
      e2bCostDollars: E2B_COST_PER_MS * 1_000,
    });
  });

  it.each(["e2b"])(
    "does not charge shared %s runtime to a child agent",
    async (provider) => {
      jest.useFakeTimers();
      mockIsE2BSandbox.mockImplementation(
        (sandbox: { provider?: string } | null) => sandbox?.provider === "e2b",
      );
      const { getSandboxSessionCost, getSandboxSessionUsage } = createTools(
        "user-1",
        "chat-1",
        {} as never,
        "agent",
        {} as never,
        undefined,
        true,
        undefined,
        "e2b",
        "service-key",
        undefined,
        undefined,
        "pro",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "run-1",
        undefined,
        { chargeSandboxRuntime: false },
      );

      mockTrackSandboxUsage?.({ provider });
      jest.advanceTimersByTime(5_000);

      await expect(getSandboxSessionCost()).resolves.toBe(0);
      await expect(getSandboxSessionUsage()).resolves.toEqual({
        totalCostDollars: 0,
        e2bRuntimeMs: 0,
        e2bCostDollars: 0,
      });
    },
  );

  it("does not reset or duplicate runtime when reconnecting the same provider", async () => {
    jest.useFakeTimers();
    const { getSandboxSessionUsage } = createTools(
      "user-1",
      "chat-1",
      {} as never,
      "agent",
      {} as never,
      undefined,
      true,
      undefined,
      "e2b",
      "service-key",
    );
    mockTrackSandboxUsage?.({ provider: "e2b", sandboxId: "e2b-1" });
    jest.advanceTimersByTime(2_000);
    mockTrackSandboxUsage?.({ provider: "e2b", sandboxId: "e2b-1" });
    jest.advanceTimersByTime(3_000);
    await expect(getSandboxSessionUsage()).resolves.toMatchObject({
      e2bRuntimeMs: 5_000,
      e2bCostDollars: 5_000 * E2B_COST_PER_MS,
    });
  });

  it("stops cloud runtime billing while a non-cloud sandbox is active", async () => {
    jest.useFakeTimers();
    mockIsE2BSandbox.mockImplementation(
      (sandbox: { provider?: string } | null) => sandbox?.provider === "e2b",
    );
    const { getSandboxSessionUsage } = createTools(
      "user-1",
      "chat-1",
      {} as never,
      "agent",
      {} as never,
      undefined,
      true,
      undefined,
      "e2b",
      "service-key",
    );

    mockTrackSandboxUsage?.({ provider: "e2b" });
    jest.advanceTimersByTime(1_000);
    mockTrackSandboxUsage?.({ provider: "local" });
    jest.advanceTimersByTime(2_000);
    mockTrackSandboxUsage?.({ provider: "e2b" });
    jest.advanceTimersByTime(3_000);

    await expect(getSandboxSessionUsage()).resolves.toEqual({
      totalCostDollars: E2B_COST_PER_MS * 4_000,
      e2bRuntimeMs: 4_000,
      e2bCostDollars: E2B_COST_PER_MS * 4_000,
    });
  });
});
