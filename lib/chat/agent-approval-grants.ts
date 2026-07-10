import type {
  AgentToolApprovalInputRecord,
  AgentToolApprovalOperation,
  AgentToolApprovalPromptKind,
} from "@/types";

type AgentApprovalGrantSource = {
  operation?: AgentToolApprovalOperation;
  target?: string;
  kind?: AgentToolApprovalPromptKind;
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
  "*",
  "?",
  "[",
  "]",
  "~",
  "#",
  "!",
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
  "tcsh",
  "tcsh.exe",
  "xargs",
  "zsh",
  "zsh.exe",
]);

const isShellWhitespace = (character: string): boolean =>
  character === " " || character === "\t";

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
      if (character === "$") return null;
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
  if (NON_EXECUTABLE_SHELL_TOKENS.has(executable)) return null;
  const executableBasename = executable
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.toLowerCase();
  if (
    executableBasename &&
    NON_REUSABLE_COMMAND_WRAPPERS.has(executableBasename)
  ) {
    return null;
  }

  return argv;
};

const normalizePathSegments = (
  segments: string[],
  absolute: boolean,
): string[] => {
  const normalized: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      const previous = normalized[normalized.length - 1];
      if (previous && previous !== "..") {
        normalized.pop();
      } else if (!absolute) {
        normalized.push(segment);
      }
      continue;
    }
    normalized.push(segment);
  }

  return normalized;
};

const normalizeWindowsPath = (
  rawPath: string,
): { path: string; pathFlavor: "windows" } | null => {
  const slashPath = rawPath.replace(/\\/g, "/");
  if (/^\/\/[?.]\//.test(slashPath)) return null;

  if (/^\/\//.test(slashPath)) {
    const segments = slashPath.slice(2).split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const [server, share, ...rest] = segments;
    const normalized = normalizePathSegments(rest, true);
    return {
      path: `//${server}/${share}${normalized.length ? `/${normalized.join("/")}` : ""}`,
      pathFlavor: "windows",
    };
  }

  const driveMatch = /^([A-Za-z]):(.*)$/.exec(slashPath);
  if (driveMatch) {
    const drive = driveMatch[1].toUpperCase();
    const suffix = driveMatch[2];
    const absolute = suffix.charAt(0) === "/";
    const normalized = normalizePathSegments(suffix.split("/"), absolute);
    const tail = normalized.join("/");
    return {
      path: absolute
        ? `${drive}:/${tail}`.replace(/\/$/, tail ? "" : "/")
        : `${drive}:${tail || "."}`,
      pathFlavor: "windows",
    };
  }

  const absolute = slashPath.charAt(0) === "/";
  const normalized = normalizePathSegments(slashPath.split("/"), absolute);
  return {
    path: absolute
      ? `/${normalized.join("/")}` || "/"
      : normalized.join("/") || ".",
    pathFlavor: "windows",
  };
};

export const normalizeAgentApprovalFilePath = (
  path: string,
): { path: string; pathFlavor: "posix" | "windows" } | null => {
  if (!path || path !== path.trim() || path.includes("\0")) return null;

  const isWindowsPath = /^[A-Za-z]:/.test(path) || path.includes("\\");
  if (isWindowsPath) return normalizeWindowsPath(path);

  const absolute = path.charAt(0) === "/";
  const normalized = normalizePathSegments(path.split("/"), absolute);
  return {
    path: absolute
      ? `/${normalized.join("/")}` || "/"
      : normalized.join("/") || ".",
    pathFlavor: "posix",
  };
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

export const deriveAgentApprovalTargetGrant = (
  request: AgentApprovalGrantSource,
): AgentApprovalTargetGrant | null => {
  if (typeof request.target !== "string") return null;

  if (request.operation === "terminal_execute") {
    const argv = parseStaticCommandArgv(request.target);
    const executable = argv?.[0];
    return executable && argv
      ? {
          kind: "terminal_command",
          targetPrefix: JSON.stringify(argv),
          executable,
          argv,
        }
      : null;
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
    const normalized = normalizeAgentApprovalFilePath(request.target);
    return normalized
      ? {
          kind: "file_change",
          targetPrefix: normalized.path,
          ...normalized,
        }
      : null;
  }

  // Older persisted prompts may not include operation. This inference is only
  // for presenting a compatible scope; Trigger requests always carry it.
  if (request.kind === "terminal") {
    const interaction = parseTerminalInteraction(request.target);
    if (interaction) return { kind: "terminal_interaction", ...interaction };
    const argv = parseStaticCommandArgv(request.target);
    const executable = argv?.[0];
    return executable && argv
      ? {
          kind: "terminal_command",
          targetPrefix: JSON.stringify(argv),
          executable,
          argv,
        }
      : null;
  }
  if (request.kind === "file") {
    const normalized = normalizeAgentApprovalFilePath(request.target);
    return normalized
      ? {
          kind: "file_change",
          targetPrefix: normalized.path,
          ...normalized,
        }
      : null;
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
  const candidate = deriveAgentApprovalTargetGrant(request);
  if (!candidate || candidate.kind !== grant.kind) return false;

  if (
    candidate.kind === "terminal_command" &&
    grant.kind === "terminal_command"
  ) {
    return (
      candidate.argv.length === grant.argv.length &&
      candidate.argv.every((argument, index) => argument === grant.argv[index])
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
  if (candidate.kind === "file_change" && grant.kind === "file_change") {
    return (
      candidate.pathFlavor === grant.pathFlavor && candidate.path === grant.path
    );
  }

  return false;
};

const formatGrantValue = (value: string): string =>
  /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : JSON.stringify(value);

export const getAgentApprovalTargetGrantLabel = (
  grant: AgentApprovalTargetGrant | null,
): string => {
  if (!grant) return "Yes, and don't ask again for similar actions";
  if (grant.kind === "terminal_command") {
    return `Yes, and don't ask again for ${formatGrantValue(grant.argv.join(" "))} in this chat`;
  }
  if (grant.kind === "terminal_interaction") {
    return `Yes, and don't ask again for ${grant.action} actions in terminal session ${formatGrantValue(grant.sessionId)} during this run`;
  }
  return `Yes, and don't ask again for changes to ${formatGrantValue(grant.path)} in this chat`;
};
