import type { AnySandbox } from "@/types";
import {
  isAwsLambdaMicrovmSandbox,
  isCentrifugoSandbox,
} from "@/lib/ai/tools/utils/sandbox-types";

export const getSubagentSandboxIdentity = (sandbox: AnySandbox): string => {
  if (isAwsLambdaMicrovmSandbox(sandbox)) {
    return `aws:${sandbox.getConnectionId()}`;
  }
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
  const legacyAwsIdentity = actualIdentity.startsWith("aws:")
    ? `connection:${actualIdentity.slice("aws:".length)}`
    : undefined;
  if (expectedIdentity === legacyAwsIdentity) return;
  if (actualIdentity !== expectedIdentity) {
    throw new Error("The validation sandbox changed before the child started.");
  }
};
