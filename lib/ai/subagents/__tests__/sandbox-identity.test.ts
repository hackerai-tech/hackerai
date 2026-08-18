import {
  assertSubagentSandboxIdentity,
  getSubagentSandboxIdentity,
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
      assertSubagentSandboxIdentity(aws, "connection:relay-1"),
    ).not.toThrow();
    expect(() => assertSubagentSandboxIdentity(local, "aws:relay-1")).toThrow(
      "The validation sandbox changed before the child started.",
    );
  });
});
