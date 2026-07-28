jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: class {},
}));

import type { Sandbox } from "@e2b/code-interpreter";
import {
  BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
  E2B_SANDBOX_OPERATION_TIMEOUT_BUFFER_MS,
  getE2BSandboxLeaseTimeoutMs,
  refreshE2BSandboxLease,
} from "../sandbox";

describe("E2B sandbox lease lifecycle", () => {
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
});
