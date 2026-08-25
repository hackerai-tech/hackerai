import {
  assertSubagentSandboxIdentity,
  getSubagentSandboxIdentity,
} from "../sandbox-identity";

describe("subagent sandbox identity", () => {
  it("distinguishes E2B from user-owned Centrifugo connections", () => {
    const cloud = { sandboxId: "sandbox-1" } as never;
    const local = {
      sandboxKind: "centrifugo",
      getConnectionId: () => "desktop-1",
    } as never;

    expect(getSubagentSandboxIdentity(cloud)).toBe("e2b:sandbox-1");
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
});
