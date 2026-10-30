import type { ChatMode, SandboxPreference } from "@/types";
import type { TriggerRunRegion } from "./trigger-region";
import {
  CloudWorkspaceUnavailableError,
  readCloudWorkspaceState,
} from "@/lib/ai/tools/utils/cloud-workspace-guard";
import { readFailures } from "@/lib/cloud-recovery/store";

/** Keep Cloud execution beside its existing disk when request geography changes. */
export async function resolveCloudExecutionRegion({
  userId,
  sandboxPreference,
  requestRegion,
  mode = "agent",
}: {
  userId: string;
  sandboxPreference?: SandboxPreference;
  requestRegion: TriggerRunRegion;
  mode?: ChatMode;
}): Promise<TriggerRunRegion> {
  if (mode === "ask") return requestRegion;
  if (sandboxPreference && sandboxPreference !== "e2b") return requestRegion;

  const workspace = await readCloudWorkspaceState(userId);
  if (workspace) {
    if (workspace.phase !== "e2b") throw new CloudWorkspaceUnavailableError();
    return workspace.region;
  }

  // Acquisition also pins ordinary retries to this failed workspace when the
  // recovery configuration is enabled. Do not schedule its retry elsewhere.
  const failed = process.env.CLOUD_DISK_RECOVERY_TARGETS
    ? await readFailures(userId)
    : null;
  return failed?.region ?? requestRegion;
}
