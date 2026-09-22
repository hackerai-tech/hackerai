import {
  assertSubagentSandboxIdentity,
  getSubagentSandboxIdentity,
} from "../sandbox-identity";

describe("subagent sandbox identity", () => {
  it("distinguishes E2B from user-owned Centrifugo connections", () => {
    const cloud = { sandboxId: "sandbox-1" } as never;
    const miosa = {
      sandboxKind: "miosa" as const,
      sandboxId: "sandbox-2",
    } as never;
    const local = {
      sandboxKind: "centrifugo",
      getConnectionId: () => "desktop-1",
    } as never;

    expect(getSubagentSandboxIdentity(cloud)).toBe("e2b:sandbox-1");
    expect(getSubagentSandboxIdentity(miosa)).toBe("miosa:sandbox-2");
    expect(getSubagentSandboxIdentity(local)).toBe("connection:desktop-1");
    expect(() =>
      assertSubagentSandboxIdentity(cloud, "e2b:sandbox-1"),
    ).not.toThrow();
    expect(() =>
      assertSubagentSandboxIdentity(local, "connection:desktop-1"),
    ).not.toThrow();
    expect(() => assertSubagentSandboxIdentity(local, "e2b:sandbox-1")).toThrow(
      "The validation sandbox changed before the child started.",
    );
  });

  it("survives relay replacement only for the same persistent environment", () => {
    const local = (connectionId: string, environmentId: string) =>
      ({
        sandboxKind: "centrifugo",
        getConnectionId: () => connectionId,
        getConnectionInfo: () => ({
          connectionId,
          environmentId,
          isDesktop: false,
        }),
      }) as never;

    const first = local("session-1", "machine-a");
    const replacement = local("session-2", "machine-a");
    const other = local("session-3", "machine-b");

    expect(getSubagentSandboxIdentity(first)).toBe(
      "connection:environment:machine-a",
    );
    expect(getSubagentSandboxIdentity(replacement)).toBe(
      getSubagentSandboxIdentity(first),
    );
    expect(getSubagentSandboxIdentity(other)).not.toBe(
      getSubagentSandboxIdentity(first),
    );
  });
});
