/**
 * Keep MIOSA execution and migrations paused across web and Trigger workers.
 * Resuming requires a reviewed code change; flags and stale environment
 * overrides cannot restart the rollout independently.
 */
export function isMiosaCloudSandboxPaused(): boolean {
  return true;
}
