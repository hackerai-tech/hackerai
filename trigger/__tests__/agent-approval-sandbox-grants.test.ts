import {
  getAgentApprovalConnectionSandboxIdentity,
  getAgentApprovalTargetPrefixForSandbox,
  parseSandboxScopedAgentApprovalTargetPrefix,
  serializeSandboxScopedAgentApprovalTargetPrefix,
} from "../../types/agent";

describe("sandbox-scoped reusable Agent approval grants", () => {
  const targetPrefix = '["pnpm","test"]';
  const desktopA = getAgentApprovalConnectionSandboxIdentity("desktop-a");
  const desktopB = getAgentApprovalConnectionSandboxIdentity("desktop-b");

  it("reuses a persisted grant within the same sandbox", () => {
    const persistedTargetPrefix =
      serializeSandboxScopedAgentApprovalTargetPrefix({
        sandboxIdentity: desktopA,
        targetPrefix,
      });

    expect(
      getAgentApprovalTargetPrefixForSandbox({
        persistedTargetPrefix,
        sandboxIdentity: desktopA,
      }),
    ).toBe(targetPrefix);
  });

  it("does not reuse E2B grants on desktop or desktop grants on E2B", () => {
    const e2bGrant = serializeSandboxScopedAgentApprovalTargetPrefix({
      sandboxIdentity: "e2b",
      targetPrefix,
    });
    const desktopGrant = serializeSandboxScopedAgentApprovalTargetPrefix({
      sandboxIdentity: desktopA,
      targetPrefix,
    });

    expect(
      getAgentApprovalTargetPrefixForSandbox({
        persistedTargetPrefix: e2bGrant,
        sandboxIdentity: desktopA,
      }),
    ).toBeNull();
    expect(
      getAgentApprovalTargetPrefixForSandbox({
        persistedTargetPrefix: desktopGrant,
        sandboxIdentity: "e2b",
      }),
    ).toBeNull();
  });

  it("does not reuse a grant on another local connection", () => {
    const persistedTargetPrefix =
      serializeSandboxScopedAgentApprovalTargetPrefix({
        sandboxIdentity: desktopA,
        targetPrefix,
      });

    expect(
      getAgentApprovalTargetPrefixForSandbox({
        persistedTargetPrefix,
        sandboxIdentity: desktopB,
      }),
    ).toBeNull();
  });

  it("fails closed for legacy and malformed persisted grants", () => {
    expect(
      parseSandboxScopedAgentApprovalTargetPrefix(targetPrefix),
    ).toBeNull();
    expect(
      parseSandboxScopedAgentApprovalTargetPrefix(
        '["agent-approval-sandbox-scope-v1","connection:","prefix"]',
      ),
    ).toBeNull();
  });
});
