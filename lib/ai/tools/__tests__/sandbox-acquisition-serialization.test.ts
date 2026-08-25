const mockGetSandboxWithFallbackGuard = jest.fn();
const mockResetSandbox = jest.fn();
const mockQuarantineLocalConnection = jest.fn();
const mockIsE2BSandbox = jest.fn();
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

  it("accounts for E2B runtime", () => {
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

    expect(getSandboxSessionCost()).toBeCloseTo(E2B_COST_PER_MS * 1_000, 12);
    expect(getSandboxSessionUsage()).toEqual({
      totalCostDollars: E2B_COST_PER_MS * 1_000,
      e2bRuntimeMs: 1_000,
      e2bCostDollars: E2B_COST_PER_MS * 1_000,
    });
  });

  it("does not charge shared sandbox runtime to a child agent", () => {
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

    expect(getSandboxSessionCost()).toBe(0);
    expect(getSandboxSessionUsage()).toEqual({
      totalCostDollars: 0,
      e2bRuntimeMs: 0,
      e2bCostDollars: 0,
    });
  });

  it("stops cloud runtime billing while a non-cloud sandbox is active", () => {
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

    expect(getSandboxSessionUsage()).toEqual({
      totalCostDollars: E2B_COST_PER_MS * 4_000,
      e2bRuntimeMs: 4_000,
      e2bCostDollars: E2B_COST_PER_MS * 4_000,
    });
  });
});
