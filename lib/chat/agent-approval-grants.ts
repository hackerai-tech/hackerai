import type {
  AgentToolApprovalInputRecord,
  AgentToolApprovalOperation,
  AgentToolApprovalPromptKind,
} from "@/types";

type AgentApprovalGrantSource = {
  operation?: AgentToolApprovalOperation;
  target?: string;
  kind?: AgentToolApprovalPromptKind;
  prefixRule?: string[];
};

export type AgentApprovalTargetGrant =
  | {
      kind: "terminal_command";
      targetPrefix: string;
      executable: string;
      argv: string[];
    }
  | {
      kind: "terminal_interaction";
      targetPrefix: string;
      action: "send" | "kill";
      sessionId: string;
    }
  | {
      kind: "file_change";
      targetPrefix: string;
      path: string;
      pathFlavor: "posix" | "windows";
    };

export type PersistedAgentApprovalTargetGrant = Exclude<
  AgentApprovalTargetGrant,
  { kind: "terminal_interaction" }
>;

type AgentApprovalGrantSelection = Pick<
  AgentToolApprovalInputRecord,
  "grant" | "targetKind" | "targetPrefix"
>;

const SHELL_CONTROL_CHARACTERS = new Set([
  ";",
  "|",
  "&",
  "<",
  ">",
  "(",
  ")",
  "{",
  "}",
  "\n",
  "\r",
  "\0",
]);

const SHELL_DYNAMIC_CHARACTERS = new Set([
  "$",
  "%",
  "^",
  "*",
  "?",
  "[",
  "]",
  "~",
  "#",
  "!",
]);

const CMD_SINGLE_QUOTE_CONTROL_CHARACTERS = new Set([
  "&",
  "|",
  "<",
  ">",
  "(",
  ")",
  "\n",
  "\r",
  "\0",
]);

const NON_EXECUTABLE_SHELL_TOKENS = new Set([
  ".",
  "case",
  "coproc",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "source",
  "then",
  "time",
  "until",
  "while",
]);

const NON_REUSABLE_COMMAND_WRAPPERS = new Set([
  "ash",
  "ash.exe",
  "bash",
  "bash.exe",
  "busybox",
  "busybox.exe",
  "cmd",
  "cmd.exe",
  "command.com",
  "call",
  "command",
  "csh",
  "csh.exe",
  "dash",
  "dash.exe",
  "doas",
  "env",
  "env.exe",
  "eval",
  "exec",
  "fish",
  "fish.exe",
  "ksh",
  "ksh.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "sh.exe",
  "sudo",
  "start",
  "tcsh",
  "tcsh.exe",
  "xargs",
  "wsl",
  "wsl.exe",
  "zsh",
  "zsh.exe",
]);

const isShellWhitespace = (character: string): boolean =>
  character === " " || character === "\t";

const getRawExecutableBasename = (command: string): string | null => {
  const match = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  const rawExecutable = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!rawExecutable) return null;
  return (
    rawExecutable.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? null
  );
};

/**
 * Parses a static shell command into argv. Any syntax that could introduce
 * another command or dynamically alter parsing makes the command ineligible
 * for automatic approval reuse.
 */
export const parseStaticCommandArgv = (command: string): string[] | null => {
  let quote: "single" | "double" | null = null;
  let token = "";
  let tokenStarted = false;
  const argv: string[] = [];

  const finishToken = () => {
    if (!tokenStarted) return;
    argv.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    // Backticks are too easy to misread and can execute commands in both
    // unquoted and double-quoted shell text. Reject them everywhere.
    if (character === "`") return null;

    if (quote === "single") {
      if (character === "'") {
        quote = null;
      } else if (
        character === "%" ||
        character === "!" ||
        character === "^" ||
        CMD_SINGLE_QUOTE_CONTROL_CHARACTERS.has(character)
      ) {
        // Single quotes are not quoting characters for cmd.exe. Reject
        // syntax that can still expand, escape, chain, or redirect on the
        // Windows fallback. The command remains executable after a fresh
        // approval; only automatic approval reuse is disabled.
        return null;
      } else {
        token += character;
      }
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        quote = null;
        continue;
      }
      if (
        character === "$" ||
        character === "%" ||
        character === "!" ||
        character === "^"
      ) {
        return null;
      }
      if (character === "\\") {
        const nextCharacter = command[index + 1];
        if (
          !nextCharacter ||
          nextCharacter === "\n" ||
          nextCharacter === "\r"
        ) {
          return null;
        }
        if (["$", "`", '"', "\\"].includes(nextCharacter)) {
          token += nextCharacter;
          index += 1;
        } else {
          token += character;
        }
        continue;
      }
      token += character;
      continue;
    }

    if (character === "'") {
      quote = "single";
      tokenStarted = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      const nextCharacter = command[index + 1];
      if (!nextCharacter || nextCharacter === "\n" || nextCharacter === "\r") {
        return null;
      }
      tokenStarted = true;
      token += nextCharacter;
      index += 1;
      continue;
    }
    if (isShellWhitespace(character)) {
      finishToken();
      continue;
    }
    if (
      SHELL_CONTROL_CHARACTERS.has(character) ||
      SHELL_DYNAMIC_CHARACTERS.has(character)
    ) {
      return null;
    }
    if (character.charCodeAt(0) < 32) return null;

    tokenStarted = true;
    token += character;
  }

  if (quote) return null;
  finishToken();
  const executable = argv[0];
  if (!executable) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(executable)) return null;
  if (NON_EXECUTABLE_SHELL_TOKENS.has(executable.toLowerCase())) return null;
  const executableBasename = executable
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.toLowerCase();
  const rawExecutableBasename = getRawExecutableBasename(command);
  if (
    (executableBasename &&
      NON_REUSABLE_COMMAND_WRAPPERS.has(executableBasename)) ||
    (rawExecutableBasename &&
      NON_REUSABLE_COMMAND_WRAPPERS.has(rawExecutableBasename))
  ) {
    return null;
  }

  return argv;
};

const parseTerminalInteraction = (
  target: string,
): Pick<
  Extract<AgentApprovalTargetGrant, { kind: "terminal_interaction" }>,
  "action" | "sessionId" | "targetPrefix"
> | null => {
  const sendMatch = /^send to ([A-Za-z0-9_-]+): [\s\S]*$/.exec(target);
  if (sendMatch) {
    const sessionId = sendMatch[1];
    return {
      action: "send",
      sessionId,
      targetPrefix: `send:${sessionId}`,
    };
  }

  const killMatch = /^kill ([A-Za-z0-9_-]+)$/.exec(target.trim());
  if (!killMatch) return null;
  const sessionId = killMatch[1];
  return {
    action: "kill",
    sessionId,
    targetPrefix: `kill:${sessionId}`,
  };
};

const deriveTerminalCommandGrant = (
  target: string,
  prefixRule?: string[],
): AgentApprovalTargetGrant | null => {
  const argv = parseStaticCommandArgv(target);
  const executable = argv?.[0];
  const approvedArgv = prefixRule ?? argv;
  const prefixMatchesCommand =
    argv &&
    approvedArgv &&
    approvedArgv.length > 0 &&
    approvedArgv.length <= argv.length &&
    approvedArgv.every((argument, index) => argument === argv[index]);

  return executable && argv && prefixMatchesCommand
    ? {
        kind: "terminal_command",
        targetPrefix: JSON.stringify(approvedArgv),
        executable,
        argv: approvedArgv,
      }
    : null;
};

export const deriveAgentApprovalTargetGrant = (
  request: AgentApprovalGrantSource,
): AgentApprovalTargetGrant | null => {
  if (typeof request.target !== "string") return null;

  if (request.operation === "terminal_execute") {
    return deriveTerminalCommandGrant(request.target, request.prefixRule);
  }

  if (request.operation === "terminal_interact") {
    const interaction = parseTerminalInteraction(request.target);
    return interaction
      ? { kind: "terminal_interaction", ...interaction }
      : null;
  }

  if (
    request.operation === "file_write" ||
    request.operation === "file_append" ||
    request.operation === "file_edit"
  ) {
    // Reusable file grants cannot be bound to a canonical filesystem object
    // across E2B, Local, and Desktop backends. Require a fresh approval for
    // every mutation instead of treating lexical path equality as authority.
    return null;
  }

  // Older persisted prompts may not include operation. This inference is only
  // for presenting a compatible scope; Trigger requests always carry it.
  if (request.kind === "terminal") {
    const interaction = parseTerminalInteraction(request.target);
    if (interaction) return { kind: "terminal_interaction", ...interaction };
    return deriveTerminalCommandGrant(request.target, request.prefixRule);
  }
  if (request.kind === "file") {
    return null;
  }

  return null;
};

export const deriveApprovedAgentTargetGrant = (
  request: AgentApprovalGrantSource,
  selection: AgentApprovalGrantSelection,
): AgentApprovalTargetGrant | null => {
  if (selection.grant !== "target_prefix") return null;

  // targetPrefix and targetKind are retained on the wire for compatibility,
  // but authorization is derived exclusively from the pending request.
  return deriveAgentApprovalTargetGrant(request);
};

export const matchesAgentApprovalTargetGrant = (
  request: AgentApprovalGrantSource,
  grant: AgentApprovalTargetGrant,
): boolean => {
  // Invalidate file grants persisted by older workers. Lexical paths are not
  // stable identities across symlinks, junctions, or backend operations.
  if (grant.kind === "file_change") return false;

  if (
    request.operation === "terminal_execute" &&
    grant.kind === "terminal_command"
  ) {
    if (typeof request.target !== "string") return false;
    const argv = parseStaticCommandArgv(request.target);
    return (
      !!argv &&
      grant.argv.length <= argv.length &&
      grant.argv.every((argument, index) => argument === argv[index])
    );
  }

  const candidate = deriveAgentApprovalTargetGrant(request);
  if (!candidate || candidate.kind !== grant.kind) return false;

  if (
    candidate.kind === "terminal_command" &&
    grant.kind === "terminal_command"
  ) {
    return (
      grant.argv.length <= candidate.argv.length &&
      grant.argv.every((argument, index) => argument === candidate.argv[index])
    );
  }
  if (
    candidate.kind === "terminal_interaction" &&
    grant.kind === "terminal_interaction"
  ) {
    return (
      candidate.action === grant.action &&
      candidate.sessionId === grant.sessionId
    );
  }
  return false;
};
