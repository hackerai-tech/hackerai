import {
  assertSubagentSandboxIdentity,
  getSubagentSandboxIdentity,
  resolvePersistedSubagentCloudSandboxProvider,
} from "../sandbox-identity";

const relaySandbox = (
  connectionId: string,
  cloudProvider?: "aws-lambda-microvm",
) =>
  ({
    sandboxKind: "centrifugo",
    getConnectionId: () => connectionId,
    getCloudProvider: () => cloudProvider,
  }) as never;

describe("subagent sandbox identity", () => {
  it("distinguishes AWS relays from user-owned Centrifugo connections", () => {
    const aws = relaySandbox("relay-1", "aws-lambda-microvm");
    const local = relaySandbox("desktop-1");

    expect(getSubagentSandboxIdentity(aws)).toBe("aws:relay-1");
    expect(getSubagentSandboxIdentity(local)).toBe("connection:desktop-1");
    expect(() =>
      assertSubagentSandboxIdentity(aws, "aws:relay-1"),
    ).not.toThrow();
    expect(() =>
      assertSubagentSandboxIdentity(aws, "aws:replaced-relay"),
    ).not.toThrow();
    expect(() =>
      assertSubagentSandboxIdentity(aws, "connection:relay-1"),
    ).not.toThrow();
    expect(() => assertSubagentSandboxIdentity(local, "aws:relay-1")).toThrow(
      "The validation sandbox changed before the child started.",
    );
  });

  it("resolves the provider that owns a persisted parent sandbox", () => {
    expect(
      resolvePersistedSubagentCloudSandboxProvider({
        subscription: "ultra",
        sandboxPreference: "desktop",
        sandboxIdentity: "aws:relay-1",
      }),
    ).toBe("aws-lambda-microvm");
    expect(
      resolvePersistedSubagentCloudSandboxProvider({
        subscription: "pro",
        sandboxPreference: "e2b",
        sandboxIdentity: "connection:legacy-aws-relay",
      }),
    ).toBe("aws-lambda-microvm");
    expect(
      resolvePersistedSubagentCloudSandboxProvider({
        subscription: "pro",
        sandboxPreference: "e2b",
        sandboxIdentity: "e2b:sandbox-1",
      }),
    ).toBe("e2b");
    expect(
      resolvePersistedSubagentCloudSandboxProvider({
        subscription: "free",
        sandboxPreference: "e2b",
        sandboxIdentity: "connection:stale-aws-relay",
      }),
    ).toBe("e2b");
  });
});
