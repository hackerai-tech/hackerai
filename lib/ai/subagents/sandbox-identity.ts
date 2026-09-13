import type { AnySandbox } from "@/types";
import {
  isCentrifugoSandbox,
  isMiosaSandbox,
} from "@/lib/ai/tools/utils/sandbox-types";

export const getSubagentSandboxIdentity = (sandbox: AnySandbox): string => {
  if (isCentrifugoSandbox(sandbox)) {
    return `connection:${sandbox.getConnectionId()}`;
  }
  if (isMiosaSandbox(sandbox)) return `miosa:${sandbox.sandboxId}`;
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
