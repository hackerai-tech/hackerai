const SHELL_COMMAND_SEPARATORS = new Set([";", "&", "|", "(", ")", "\n", "\r"]);
const SHELL_WHITESPACE_RE = /\s/;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const AGENT_BROWSER_COMMAND_RE = /^agent-browser(?:@[^\s;&|()]+)?$/;

/**
 * With `stripComments`, an unquoted, unescaped `#` that starts a word hides the
 * rest of its physical line, including apparent separators. Only the Browser
 * Preview predicate opts in; worker usage detection keeps its existing input.
 */
function splitShellCommands(
  command: string,
  { stripComments = false }: { stripComments?: boolean } = {},
): string[] {
  const commands: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let redirectionOperatorOpen = false;
  let atWordStart = true;

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      // A line continuation is removed, so it does not end the current word.
      if (character !== "\n") atWordStart = false;
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
      atWordStart = false;
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
      atWordStart = false;
      continue;
    }
    if (stripComments && character === "#" && atWordStart) {
      commands.push(command.slice(start, index));
      const newline = command.indexOf("\n", index + 1);
      if (newline === -1) {
        return commands;
      }
      index = newline;
      start = newline + 1;
      continue;
    }
    if (SHELL_COMMAND_SEPARATORS.has(character)) {
      commands.push(command.slice(start, index));
      start = index + 1;
      atWordStart = true;
      continue;
    }
    atWordStart = stripComments && SHELL_WHITESPACE_RE.test(character);
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

type AgentBrowserInvocation = {
  action?: string;
  usedViaNpx: boolean;
  // Matches the CLI wrapper's version class: exactly `--version` or `-V`.
  versionCheckOnly: boolean;
};

function parseAgentBrowserInvocation(
  command: string,
): AgentBrowserInvocation | null {
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
  const action = words[index + 1];
  return {
    action,
    usedViaNpx,
    versionCheckOnly:
      words.length === index + 2 && (action === "--version" || action === "-V"),
  };
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

/**
 * A standalone version check does not request a Browser Preview.
 * Other recognized browser invocations retain their existing behavior.
 */
export function requestsAgentBrowserPreview(command: string): boolean {
  return splitShellCommands(command, { stripComments: true }).some(
    (shellCommand) => {
      const invocation = parseAgentBrowserInvocation(shellCommand);
      return !!invocation && !invocation.versionCheckOnly;
    },
  );
}
