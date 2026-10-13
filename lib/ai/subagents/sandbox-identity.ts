import type { AnySandbox } from "@/types";
import { isCentrifugoSandbox } from "@/lib/ai/tools/utils/sandbox-types";
import { localEnvironmentIdentity } from "@/lib/sandbox/environment";

export const getSubagentSandboxIdentity = (sandbox: AnySandbox): string => {
  if (isCentrifugoSandbox(sandbox)) {
    const connection =
      typeof sandbox.getConnectionInfo === "function"
        ? sandbox.getConnectionInfo()
        : { connectionId: sandbox.getConnectionId() };
    return `connection:${localEnvironmentIdentity(connection)}`;
  }
  return `e2b:${sandbox.sandboxId}`;
};

export const assertSubagentSandboxIdentity = (
  sandbox: AnySandbox,
  expectedIdentity: string | undefined,
): void => {
  if (!expectedIdentity) return;
  const actualIdentity = getSubagentSandboxIdentity(sandbox);
  if (actualIdentity !== expectedIdentity) {
    throw new Error("The validation sandbox changed before the child started.");
  }
};
