import type { AgentApprovalSandboxIdentity } from "@/types";

/** Describe the executing environment without exposing its connection identity. */
export function terminalExecutionProvenance(
  identity: AgentApprovalSandboxIdentity,
  workingDirectory?: string,
) {
  return {
    executionEnvironment:
      identity === "e2b" || identity === "miosa" ? "cloud" : "connected-host",
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(identity === "e2b"
      ? {
          networkEvidenceLimitation:
            "Low-level connection success in this cloud sandbox does not prove an open target port. Require expected protocol behavior; native port discovery requires a connected host.",
        }
      : {}),
  };
}
