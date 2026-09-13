import { MAX_COMMAND_EXECUTION_TIME } from "./sandbox-command-options";

const AGENT_BROWSER_IDLE_GRACE_MS = 5 * 60 * 1000;

// Allow one maximum-length foreground command plus a short handoff window
// before reclaiming a browser daemon that receives no further commands.
export const AGENT_BROWSER_IDLE_TIMEOUT_MS =
  MAX_COMMAND_EXECUTION_TIME + AGENT_BROWSER_IDLE_GRACE_MS;
