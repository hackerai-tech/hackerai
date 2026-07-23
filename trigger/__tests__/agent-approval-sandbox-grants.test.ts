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

  it("reuses a persisted grant only within the same working directory", () => {
    const persistedTargetPrefix =
      serializeSandboxScopedAgentApprovalTargetPrefix({
        sandboxIdentity: desktopA,
        workingDirectory: "/targets/acme",
        targetPrefix,
      });

    expect(
      getAgentApprovalTargetPrefixForSandbox({
        persistedTargetPrefix,
        sandboxIdentity: desktopA,
        workingDirectory: "/targets/acme",
      }),
    ).toBe(targetPrefix);
    expect(
      getAgentApprovalTargetPrefixForSandbox({
        persistedTargetPrefix,
        sandboxIdentity: desktopA,
        workingDirectory: "/targets/other",
      }),
    ).toBeNull();
    expect(
      getAgentApprovalTargetPrefixForSandbox({
        persistedTargetPrefix,
        sandboxIdentity: desktopA,
      }),
    ).toBeNull();
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

  it("allows version 1 grants only without a project working directory", () => {
    const versionOneGrant = JSON.stringify([
      "agent-approval-sandbox-scope-v1",
      desktopA,
      targetPrefix,
    ]);

    expect(
      getAgentApprovalTargetPrefixForSandbox({
        persistedTargetPrefix: versionOneGrant,
        sandboxIdentity: desktopA,
      }),
    ).toBe(targetPrefix);
    expect(
      getAgentApprovalTargetPrefixForSandbox({
        persistedTargetPrefix: versionOneGrant,
        sandboxIdentity: desktopA,
        workingDirectory: "/targets/acme",
      }),
    ).toBeNull();
  });
});
