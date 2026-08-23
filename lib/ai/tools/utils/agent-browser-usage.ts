import type { AnySandbox, SandboxType, ToolContext } from "@/types";
import { phLogger } from "@/lib/posthog/server";
import { isCentrifugoSandbox, isE2BSandbox } from "./sandbox-types";
import { AGENT_BROWSER_IDLE_TIMEOUT_MS } from "./agent-browser-runtime";

const SHELL_COMMAND_SEPARATORS = new Set([";", "&", "|", "(", ")", "\n", "\r"]);
const SHELL_WHITESPACE_RE = /\s/;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const AGENT_BROWSER_COMMAND_RE = /^agent-browser(?:@[^\s;&|()]+)?$/;

function splitShellCommands(command: string): string[] {
  const commands: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let redirectionOperatorOpen = false;

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (redirectionOperatorOpen) {
      if (
        character === ">" ||
        character === "<" ||
        character === "&" ||
        character === "|"
      ) {
        continue;
      }
      redirectionOperatorOpen = false;
    }
    if (character === ">" || character === "<") {
      redirectionOperatorOpen = true;
      continue;
    }
    if (SHELL_COMMAND_SEPARATORS.has(character)) {
      commands.push(command.slice(start, index));
      start = index + 1;
    }
  }

  commands.push(command.slice(start));
  return commands;
}

function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let hasContent = false;
  let skippingRedirectionTarget = false;
  let redirectionTargetStarted = false;
  let redirectionOperatorOpen = false;

  const pushCurrent = () => {
    if (!hasContent) return;
    words.push(current);
    current = "";
    hasContent = false;
  };

  for (const character of command) {
    if (escaped) {
      escaped = false;
      if (character === "\n") continue;
      if (skippingRedirectionTarget) redirectionTargetStarted = true;
      else {
        current += character;
        hasContent = true;
      }
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else if (!skippingRedirectionTarget) current += character;
      if (skippingRedirectionTarget) redirectionTargetStarted = true;
      else hasContent = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      if (skippingRedirectionTarget) redirectionTargetStarted = true;
      else hasContent = true;
      continue;
    }
    if (skippingRedirectionTarget) {
      if (redirectionOperatorOpen) {
        if (
          character === ">" ||
          character === "<" ||
          character === "&" ||
          character === "|"
        ) {
          continue;
        }
        redirectionOperatorOpen = false;
      }
      if (SHELL_WHITESPACE_RE.test(character)) {
        if (redirectionTargetStarted) {
          skippingRedirectionTarget = false;
          redirectionTargetStarted = false;
        }
      } else {
        redirectionTargetStarted = true;
      }
      continue;
    }
    if (character === ">" || character === "<") {
      if (/^\d+$/.test(current)) {
        current = "";
        hasContent = false;
      } else {
        pushCurrent();
      }
      skippingRedirectionTarget = true;
      redirectionTargetStarted = false;
      redirectionOperatorOpen = true;
      continue;
    }
    if (SHELL_WHITESPACE_RE.test(character)) {
      pushCurrent();
      continue;
    }
    current += character;
    hasContent = true;
  }

  if (escaped) {
    current += "\\";
    hasContent = true;
  }
  pushCurrent();
  return words;
}

function parseAgentBrowserInvocation(command: string): {
  action?: string;
  usedViaNpx: boolean;
} | null {
  const words = splitShellWords(command);
  let index = 0;

  if (words[index] === "env") index++;
  while (ENV_ASSIGNMENT_RE.test(words[index] ?? "")) index++;

  let usedViaNpx = false;
  if (words[index] === "npx") {
    usedViaNpx = true;
    index++;
    if (words[index] === "--yes" || words[index] === "-y") index++;
  }

  if (!AGENT_BROWSER_COMMAND_RE.test(words[index] ?? "")) return null;
  return { action: words[index + 1], usedViaNpx };
}

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

  for (const shellCommand of splitShellCommands(command)) {
    const invocation = parseAgentBrowserInvocation(shellCommand);
    if (!invocation) continue;
    invocationCount++;
    usedViaNpx ||= invocation.usedViaNpx;
    const action = normalizeAgentBrowserAction(invocation.action);
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

export function getAgentBrowserRuntimeEnv(
  command: string,
): Record<string, string> | undefined {
  if (!detectAgentBrowserUsage(command)) return undefined;

  return {
    AGENT_BROWSER_IDLE_TIMEOUT_MS: String(AGENT_BROWSER_IDLE_TIMEOUT_MS),
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

  phLogger.event("agent_browser_terminal_command_used", {
    userId: args.context.userID,
    chat_id: args.context.chatId,
    mode: args.context.mode,
    subscription_tier: args.context.subscription,
    sandbox_type: getAgentBrowserSandboxType(args.context, args.sandbox),
    primary_action: usage.primaryAction,
    actions: usage.actions,
    invocation_count: usage.invocationCount,
    used_via_npx: usage.usedViaNpx,
    interactive: args.interactive,
    is_background: args.isBackground,
    agent_browser_usage_event_version: 1,
  });
}
