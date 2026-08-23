import type { AnySandbox, SandboxPreference, SubscriptionTier } from "@/types";
import type { CloudSandboxProvider } from "@/lib/ai/tools/utils/cloud-sandbox-provider";
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

/** Resolve the provider that owns the parent sandbox persisted for a child. */
export const resolvePersistedSubagentCloudSandboxProvider = ({
  subscription,
  sandboxPreference,
  sandboxIdentity,
}: {
  subscription: SubscriptionTier;
  sandboxPreference?: SandboxPreference;
  sandboxIdentity?: string;
}): CloudSandboxProvider => {
  if (subscription === "free") return "e2b";
  const hasAwsIdentity =
    sandboxIdentity?.startsWith("aws:") ||
    (sandboxPreference === "e2b" && sandboxIdentity?.startsWith("connection:"));
  return hasAwsIdentity ? "aws-lambda-microvm" : "e2b";
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
