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

/** A narrow opt-in trigger for server-side challenge detection. This is not a
 * general shell parser: ambiguous commands execute normally without paid work.
 */
export function isAgentBrowserSnapshotCommand(command: string): boolean {
  if (/[`$<>\\\n\r]/.test(command)) return false;
  const parts = splitShellCommands(command.trim());
  if (parts.length !== 1) return false;
  const words = splitShellWords(parts[0]);
  let index = 0;
  if (words[index] === "npx") {
    index++;
    if (["--yes", "-y"].includes(words[index])) index++;
  }
  if (!AGENT_BROWSER_COMMAND_RE.test(words[index++] ?? "")) return false;
  if (words[index] === "--session") {
    index++;
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(words[index++] ?? "")) return false;
  }
  if (words[index++] !== "snapshot") return false;
  while (index < words.length) {
    const option = words[index++];
    if (["-i", "--interactive", "-c", "--compact", "--json"].includes(option))
      continue;
    if (["-d", "--depth"].includes(option)) {
      if (!/^\d{1,3}$/.test(words[index++] ?? "")) return false;
      continue;
    }
    return false;
  }
  return true;
}

/** Suggest the read-only command when output formatting hid the opt-in trigger.
 * This never authorizes a solver call or executes a rewritten shell command.
 */
export function getStandaloneSnapshotHint(command: string): string | null {
  if (/[`$\\<>\n\r]/.test(command.replaceAll("2>&1", ""))) return null;
  const parts = splitShellCommands(command.trim()).map(splitShellWords);
  const snapshot = parts[0]?.join(" ");
  if (!snapshot || !isAgentBrowserSnapshotCommand(snapshot)) return null;
  if (
    parts.slice(1).some((words) => !["head", "tail", "date"].includes(words[0]))
  )
    return null;
  return snapshot;
}
