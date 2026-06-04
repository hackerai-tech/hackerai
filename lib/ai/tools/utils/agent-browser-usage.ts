import type { AnySandbox, SandboxType, ToolContext } from "@/types";
import { phLogger } from "@/lib/posthog/server";
import { isCentrifugoSandbox, isE2BSandbox } from "./sandbox-types";

const AGENT_BROWSER_INVOCATION_RE =
  /(?:^|[;&|()]\s*)(?:(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|()]+)\s+)*)?(?:npx\s+(?:--yes\s+|-y\s+)?)?agent-browser(?=$|\s|[;&|()])(?:\s+([^\s;&|()]+))?/g;

const KNOWN_AGENT_BROWSER_ACTIONS = new Set([
  "open",
  "snapshot",
  "click",
  "dblclick",
  "hover",
  "focus",
  "fill",
  "type",
  "press",
  "check",
  "uncheck",
  "select",
  "upload",
  "scroll",
  "scrollintoview",
  "drag",
  "find",
  "wait",
  "get",
  "eval",
  "screenshot",
  "close",
  "viewport",
  "tab",
  "network",
  "record",
  "frame",
  "dialog",
  "keyboard",
  "state",
  "set",
  "auth",
  "doctor",
  "react",
  "vitals",
  "pushstate",
  "skills",
  "batch",
  "diff",
  "key",
]);

export type AgentBrowserCommandUsage = {
  invocationCount: number;
  primaryAction: string;
  actions: string[];
  usedViaNpx: boolean;
};

function normalizeAgentBrowserAction(rawAction: string | undefined): string {
  if (!rawAction) return "unknown";
  const action = rawAction.replace(/^["']|["']$/g, "").toLowerCase();
  if (!action || action.startsWith("-")) return "option";
  if (KNOWN_AGENT_BROWSER_ACTIONS.has(action)) return action;
  if (/^[a-z][a-z0-9_-]{0,40}$/.test(action)) return "other";
  return "unknown";
}

export function detectAgentBrowserUsage(
  command: string,
): AgentBrowserCommandUsage | null {
  const actions: string[] = [];
  let invocationCount = 0;
  let usedViaNpx = false;

  AGENT_BROWSER_INVOCATION_RE.lastIndex = 0;
  for (
    let match = AGENT_BROWSER_INVOCATION_RE.exec(command);
    match !== null;
    match = AGENT_BROWSER_INVOCATION_RE.exec(command)
  ) {
    invocationCount++;
    const matchedCommand = match[0] ?? "";
    if (/\bnpx\s+(?:--yes\s+|-y\s+)?agent-browser\b/.test(matchedCommand)) {
      usedViaNpx = true;
    }
    const action = normalizeAgentBrowserAction(match[1]);
    if (!actions.includes(action)) actions.push(action);
  }

  if (invocationCount === 0) return null;
  return {
    invocationCount,
    primaryAction: actions[0] ?? "unknown",
    actions,
    usedViaNpx,
  };
}

function getAgentBrowserSandboxType(
  context: ToolContext,
  sandbox: AnySandbox,
): SandboxType | "unknown" {
  const sandboxType = context.sandboxManager.getSandboxType("run_terminal_cmd");
  if (sandboxType) return sandboxType;
  if (isCentrifugoSandbox(sandbox)) return "remote-connection";
  if (isE2BSandbox(sandbox)) return "e2b";
  return "unknown";
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

  const activeModel = args.context.getCurrentModelName?.();

  phLogger.event("agent_browser_terminal_command_used", {
    userId: args.context.userID,
    user_id: args.context.userID,
    chat_id: args.context.chatId,
    mode: args.context.mode,
    subscription: args.context.subscription,
    subscription_tier: args.context.subscription,
    configured_model: args.context.modelName,
    active_model: activeModel ?? args.context.modelName,
    sandbox_type: getAgentBrowserSandboxType(args.context, args.sandbox),
    primary_action: usage.primaryAction,
    actions: usage.actions,
    invocation_count: usage.invocationCount,
    used_via_npx: usage.usedViaNpx,
    interactive: args.interactive,
    is_background: args.isBackground,
  });
}
