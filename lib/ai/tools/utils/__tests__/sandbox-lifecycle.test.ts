jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: class {
    static list = jest.fn();
    static connect = jest.fn();
  },
}));

import { Sandbox } from "@e2b/code-interpreter";
import {
  BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
  E2B_SANDBOX_OPERATION_TIMEOUT_BUFFER_MS,
  ensureSandboxConnection,
  getE2BSandboxLeaseTimeoutMs,
  refreshE2BSandboxLease,
} from "../sandbox";

describe("E2B sandbox lease lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keeps the normal cloud lease for short and background operations", () => {
    expect(getE2BSandboxLeaseTimeoutMs()).toBe(BASH_SANDBOX_AUTOPAUSE_TIMEOUT);
    expect(getE2BSandboxLeaseTimeoutMs(5 * 60 * 1000)).toBe(
      BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
    );
  });

  it("adds lifecycle headroom when a command can outlive the normal lease", () => {
    const operationTimeoutMs = 10 * 60 * 1000;
    expect(getE2BSandboxLeaseTimeoutMs(operationTimeoutMs)).toBe(
      operationTimeoutMs + E2B_SANDBOX_OPERATION_TIMEOUT_BUFFER_MS,
    );
  });

  it("refreshes the lease from the current moment", async () => {
    const setTimeout = jest.fn(async () => undefined);
    const sandbox = { setTimeout } as unknown as Sandbox;

    const timeoutMs = await refreshE2BSandboxLease(sandbox, 10 * 60 * 1000);

    expect(timeoutMs).toBe(11 * 60 * 1000);
    expect(setTimeout).toHaveBeenCalledWith(11 * 60 * 1000);
  });

  it("uses the renewable cloud lease when reconnecting a paused sandbox", async () => {
    const sandboxApi = Sandbox as unknown as {
      list: jest.Mock;
      connect: jest.Mock;
    };
    const connectedSandbox = { sandboxId: "sandbox-1" } as unknown as Sandbox;
    sandboxApi.list.mockReturnValue({
      nextItems: jest.fn(async () => [
        {
          sandboxId: "sandbox-1",
          metadata: { sandboxVersion: "v11" },
        },
      ]),
    });
    sandboxApi.connect.mockResolvedValue(connectedSandbox);
    const setSandbox = jest.fn();

    const result = await ensureSandboxConnection({
      userID: "user-1",
      setSandbox,
    });

    expect(result.sandbox).toBe(connectedSandbox);
    expect(sandboxApi.connect).toHaveBeenCalledWith("sandbox-1", {
      timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
    });
    expect(setSandbox).toHaveBeenCalledWith(connectedSandbox);
  });
});
