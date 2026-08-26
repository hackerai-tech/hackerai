const mockGetSandboxWithFallbackGuard = jest.fn();
const mockResetSandbox = jest.fn();
const mockQuarantineLocalConnection = jest.fn();
const mockIsE2BSandbox = jest.fn();
const mockIsMiosaSandbox = jest.fn();
let mockTrackSandboxUsage: ((sandbox: unknown) => void) | undefined;

jest.mock("../run-terminal-cmd", () => ({ createRunTerminalCmd: jest.fn() }));
jest.mock("../interact-terminal-session", () => ({
  createInteractTerminalSession: jest.fn(),
}));
jest.mock("../get-terminal-files", () => ({
  createGetTerminalFiles: jest.fn(),
}));
jest.mock("../file", () => ({ createFile: jest.fn() }));
jest.mock("../web-search", () => ({ createWebSearch: jest.fn() }));
jest.mock("../open-url", () => ({ createOpenUrlTool: jest.fn() }));
jest.mock("../todo-write", () => ({ createTodoWrite: jest.fn() }));
jest.mock("../notes", () => ({
  createCreateNote: jest.fn(),
  createListNotes: jest.fn(),
  createUpdateNote: jest.fn(),
  createDeleteNote: jest.fn(),
}));

jest.mock("../utils/hybrid-sandbox-manager", () => ({
  HybridSandboxManager: jest
    .fn()
    .mockImplementation((_userId, trackSandboxUsage) => {
      mockTrackSandboxUsage = trackSandboxUsage;
      return {
        resetSandbox: mockResetSandbox,
        quarantineLocalConnection: mockQuarantineLocalConnection,
      };
    }),
}));

jest.mock("../utils/sandbox-manager", () => ({
  DefaultSandboxManager: jest.fn(),
}));

jest.mock("../utils/sandbox-types", () => ({
  isE2BSandbox: (...args: unknown[]) => mockIsE2BSandbox(...args),
  isMiosaSandbox: (...args: unknown[]) => mockIsMiosaSandbox(...args),
  getCloudSandboxProviderForInstance: (
    sandbox: { provider?: string } | null,
  ) =>
    sandbox?.provider === "e2b" || sandbox?.provider === "miosa"
      ? sandbox.provider
      : null,
}));

jest.mock("../utils/sandbox-fallback", () => ({
  getSandboxWithFallbackGuard: (...args: unknown[]) =>
    mockGetSandboxWithFallbackGuard(...args),
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn() },
}));

import { createTools } from "..";
import { E2B_COST_PER_MS } from "../utils/e2b-cost";

describe("sandbox acquisition serialization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResetSandbox.mockResolvedValue(undefined);
    mockQuarantineLocalConnection.mockResolvedValue(undefined);
    mockIsE2BSandbox.mockReturnValue(false);
    mockIsMiosaSandbox.mockReturnValue(false);
    mockTrackSandboxUsage = undefined;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

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
      miosaRuntimeMs: 0,
      miosaCostDollars: 0,
      e2bRuntimeMs: 1_000,
      e2bCostDollars: E2B_COST_PER_MS * 1_000,
    });
  });

  it("does not charge shared sandbox runtime to a child agent", async () => {
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

    mockTrackSandboxUsage?.({ provider: "e2b" });
    jest.advanceTimersByTime(5_000);

    await expect(getSandboxSessionCost()).resolves.toBe(0);
    await expect(getSandboxSessionUsage()).resolves.toEqual({
      totalCostDollars: 0,
      miosaRuntimeMs: 0,
      miosaCostDollars: 0,
      e2bRuntimeMs: 0,
      e2bCostDollars: 0,
    });
  });

  it("uses MIOSA provider-reported cost deltas", async () => {
    jest.useFakeTimers();
    mockIsMiosaSandbox.mockImplementation(
      (sandbox: { provider?: string } | null) => sandbox?.provider === "miosa",
    );
    const usage = jest
      .fn()
      .mockResolvedValueOnce({ estimated_cost_cents: 100 })
      .mockResolvedValue({ estimated_cost_cents: 125 });
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

    mockTrackSandboxUsage?.({ provider: "miosa", sdkSandbox: { usage } });
    jest.advanceTimersByTime(2_000);

    await expect(getSandboxSessionCost()).resolves.toBe(0.25);
    await expect(getSandboxSessionUsage()).resolves.toEqual({
      totalCostDollars: 0.25,
      miosaRuntimeMs: 2_000,
      miosaCostDollars: 0.25,
      e2bRuntimeMs: 0,
      e2bCostDollars: 0,
    });
    expect(usage).toHaveBeenCalledTimes(3);
  });

  it("does not treat a failed MIOSA baseline read as zero cost", async () => {
    mockIsMiosaSandbox.mockImplementation(
      (sandbox: { provider?: string } | null) => sandbox?.provider === "miosa",
    );
    const usage = jest
      .fn()
      .mockRejectedValueOnce(new Error("usage unavailable"))
      .mockResolvedValueOnce({ estimated_cost_cents: 125 })
      .mockResolvedValueOnce({ estimated_cost_cents: 130 });
    const { getSandboxSessionCost } = createTools(
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

    mockTrackSandboxUsage?.({ provider: "miosa", sdkSandbox: { usage } });

    await expect(getSandboxSessionCost()).resolves.toBeCloseTo(0.05, 12);
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
      miosaRuntimeMs: 0,
      miosaCostDollars: 0,
      e2bRuntimeMs: 4_000,
      e2bCostDollars: E2B_COST_PER_MS * 4_000,
    });
  });
});
