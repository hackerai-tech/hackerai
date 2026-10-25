import type { AnySandbox, ToolContext } from "@/types";
import { phLogger } from "@/lib/posthog/server";
import { getSandboxLogFields } from "./sandbox-types";
import { AGENT_BROWSER_IDLE_TIMEOUT_MS } from "./agent-browser-runtime";

import { detectAgentBrowserUsage } from "@/lib/utils/agent-browser-command";
export { detectAgentBrowserUsage } from "@/lib/utils/agent-browser-command";
export type { AgentBrowserCommandUsage } from "@/lib/utils/agent-browser-command";

export function getAgentBrowserRuntimeEnv(
  command: string,
): Record<string, string> | undefined {
  if (!detectAgentBrowserUsage(command)) return undefined;

  return {
    AGENT_BROWSER_IDLE_TIMEOUT_MS: String(AGENT_BROWSER_IDLE_TIMEOUT_MS),
  };
}

function getAgentBrowserSandboxLogFields(
  context: ToolContext,
  sandbox: AnySandbox,
): ReturnType<typeof getSandboxLogFields> {
  const sandboxInfo = context.sandboxManager.getSandboxInfo();
  if (sandboxInfo) {
    return {
      sandbox_type: sandboxInfo.type,
      ...(sandboxInfo.provider && {
        sandbox_provider: sandboxInfo.provider,
      }),
    };
  }
  return getSandboxLogFields(sandbox);
}

export function captureAgentBrowserUsage(args: {
  context: ToolContext;
  command: string;
  sandbox: AnySandbox;
  interactive: boolean;
  isBackground: boolean;
}): void {
  const usage = detectAgentBrowserUsage(args.command);
  if (!usage) return;

  phLogger.event("agent_browser_terminal_command_used", {
    userId: args.context.userID,
    chat_id: args.context.chatId,
    mode: args.context.mode,
    subscription_tier: args.context.subscription,
    ...getAgentBrowserSandboxLogFields(args.context, args.sandbox),
    primary_action: usage.primaryAction,
    actions: usage.actions,
    invocation_count: usage.invocationCount,
    used_via_npx: usage.usedViaNpx,
    interactive: args.interactive,
    is_background: args.isBackground,
    agent_browser_usage_event_version: 2,
  });
}
