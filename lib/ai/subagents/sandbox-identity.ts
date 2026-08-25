import type { AnySandbox } from "@/types";
import { isCentrifugoSandbox } from "@/lib/ai/tools/utils/sandbox-types";

export const getSubagentSandboxIdentity = (sandbox: AnySandbox): string => {
  if (isCentrifugoSandbox(sandbox)) {
    return `connection:${sandbox.getConnectionId()}`;
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
