import { createHash } from "node:crypto";
import path from "node:path";

import type {
  AgentAutoReviewTerminalInspection,
  AgentAutoReviewTerminalInspectionReason,
  AnySandbox,
} from "@/types";
import {
  isCentrifugoSandbox,
  isCloudSandbox,
} from "@/lib/ai/tools/utils/sandbox-types";

const MAX_DELETE_TARGETS = 8;
const MAX_DELETE_TREE_ENTRIES = 200;
const MAX_DELETE_TREE_DEPTH = 8;

type InspectionKind = AgentAutoReviewTerminalInspection["kind"];

type ParsedCandidate =
  | { kind: "filesystem_delete"; tokens: string[] }
  | { kind: "script"; tokens: string[] }
  | { kind: "package_task"; tokens: string[] };

type InspectedPath = {
  public: NonNullable<AgentAutoReviewTerminalInspection["targets"]>[number];
  signature: unknown;
  complete: boolean;
  reason?: AgentAutoReviewTerminalInspectionReason;
};

const DELETE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "del",
  "erase",
  "rd",
  "remove-item",
]);
const RESOLVABLE_DELETE_COMMANDS = new Set(["rm", "rmdir", "unlink"]);
const COMMAND_WRAPPERS = new Set([
  "sudo",
  "doas",
  "command",
  "builtin",
  "nohup",
  "env",
  "time",
  "timeout",
  "nice",
  "setsid",
  "stdbuf",
]);
const DISPLAY_ONLY_FLAGS = new Set(["--version", "-v", "-V", "--help", "-h"]);
const isDisplayOnlyFlagAt = (tokens: string[], index: number): boolean =>
  index === tokens.length - 1 && DISPLAY_ONLY_FLAGS.has(tokens[index] ?? "");
const SCRIPT_INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "node",
  "python",
  "python2",
  "python3",
  "ruby",
  "perl",
]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_MANAGER_BUILTINS = new Set([
  "add",
  "audit",
  "config",
  "create",
  "dedupe",
  "dlx",
  "exec",
  "help",
  "import",
  "init",
  "install",
  "link",
  "list",
  "outdated",
  "pack",
  "patch",
  "prune",
  "publish",
  "remove",
  "root",
  "search",
  "uninstall",
  "unlink",
  "update",
  "upgrade",
  "version",
  "view",
  "why",
]);
const SENSITIVE_PATH_SEGMENTS = new Set([
  ".aws",
  ".codex",
  ".config",
  ".git",
  ".gnupg",
  ".kube",
  ".ssh",
  ".env",
]);

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const unresolved = ({
  kind,
  reason,
  workingDirectory,
}: {
  kind: InspectionKind;
  reason: AgentAutoReviewTerminalInspectionReason;
  workingDirectory?: string;
}): AgentAutoReviewTerminalInspection => ({
  kind,
  status: "unresolved",
  reason,
  ...(workingDirectory ? { workingDirectory } : {}),
});

/**
 * Tokenize only the shell subset that can be resolved without executing a
 * shell. Dynamic expansion, control operators, redirection, and globs are
 * intentionally rejected so they stay on the human approval path.
 */
export const tokenizeStaticTerminalCommand = (
  command: string,
): string[] | null => {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let tokenStarted = false;

  const pushToken = () => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
        tokenStarted = true;
        continue;
      }
      if (quote === '"' && (char === "$" || char === "`")) return null;
      if (char === "\\" && quote === '"') {
        index += 1;
        if (index >= command.length) return null;
        token += command[index];
      } else {
        token += char;
      }
      tokenStarted = true;
      continue;
    }

    if (/\s/u.test(char)) {
      pushToken();
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/[;&|<>\n\r]/u.test(char) || "$`*?~{}[]".includes(char)) return null;
    if (char === "\\") {
      index += 1;
      if (index >= command.length) return null;
      token += command[index];
      tokenStarted = true;
      continue;
    }
    token += char;
    tokenStarted = true;
  }

  if (quote) return null;
  pushToken();
  return tokens.length > 0 ? tokens : null;
};

const stripCommandPrefixes = (tokens: string[]): string[] => {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? "")) index += 1;
  while (COMMAND_WRAPPERS.has((tokens[index] ?? "").toLowerCase())) {
    index += 1;
    const candidateIndex = tokens.findIndex((token, candidate) => {
      if (candidate < index) return false;
      const normalized = token.toLowerCase();
      return (
        DELETE_COMMANDS.has(normalized) ||
        SCRIPT_INTERPRETERS.has(normalized) ||
        PACKAGE_MANAGERS.has(normalized) ||
        /^(?:\.\.?[\\/]|[\\/])/u.test(token)
      );
    });
    if (candidateIndex === -1) break;
    index = candidateIndex;
  }
  return tokens.slice(index);
};

export const isAgentAutoReviewFilesystemDeletionCommand = (
  command: string,
): boolean =>
  command
    .split(/&&|\|\||[;|\n]/u)
    .some((segment) =>
      /^(?:(?:sudo|doas|command|builtin|nohup)\s+)*(?:rm|rmdir|unlink|shred|del|erase|rd|remove-item)\b/i.test(
        segment.trim(),
      ),
    );

const classifyStaticTokens = (tokens: string[]): ParsedCandidate | null => {
  const stripped = stripCommandPrefixes(tokens);
  const executable = (stripped[0] ?? "").toLowerCase();
  if (DELETE_COMMANDS.has(executable)) {
    return { kind: "filesystem_delete", tokens: stripped };
  }
  if (/^(?:\.\.?[\\/]|[\\/])/u.test(stripped[0] ?? "")) {
    return { kind: "script", tokens: stripped };
  }
  if (SCRIPT_INTERPRETERS.has(executable)) {
    const firstArgument = stripped[1];
    if (firstArgument && !isDisplayOnlyFlagAt(stripped, 1)) {
      return { kind: "script", tokens: stripped };
    }
  }
  if (PACKAGE_MANAGERS.has(executable)) {
    const firstArgument = (stripped[1] ?? "").toLowerCase();
    const explicitRun = firstArgument === "run";
    const implicitLifecycle =
      executable === "npm" &&
      ["start", "stop", "restart", "test"].includes(firstArgument);
    const implicitTask =
      (executable === "pnpm" ||
        executable === "yarn" ||
        executable === "bun") &&
      !!firstArgument &&
      !firstArgument.startsWith("-") &&
      !PACKAGE_MANAGER_BUILTINS.has(firstArgument);
    if (explicitRun || implicitLifecycle || implicitTask) {
      return { kind: "package_task", tokens: stripped };
    }
  }
  return null;
};

export const getAgentAutoReviewInspectionKind = (
  command: string,
): InspectionKind | null => {
  const tokens = tokenizeStaticTerminalCommand(command);
  if (tokens) {
    const classified = classifyStaticTokens(tokens);
    if (classified) return classified.kind;
    const firstCommandToken = tokens.find(
      (token) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token),
    );
    // Wrapper options such as `env -S 'bash script.sh'` can hide an entire
    // command in one token. Its contents cannot be safely resolved here.
    if (
      firstCommandToken &&
      COMMAND_WRAPPERS.has(firstCommandToken.toLowerCase())
    ) {
      return "script";
    }
    // Options and wrappers can put the executable after argv[0]. While file
    // evidence is unavailable, conservatively require human review for these
    // indirect commands rather than treating them as ordinary shell commands.
    if (
      tokens.some(
        (token, index) =>
          SCRIPT_INTERPRETERS.has(token.toLowerCase()) &&
          !!tokens[index + 1] &&
          !isDisplayOnlyFlagAt(tokens, index + 1),
      )
    ) {
      return "script";
    }
    if (
      tokens.some(
        (token, index) =>
          PACKAGE_MANAGERS.has(token.toLowerCase()) &&
          !isDisplayOnlyFlagAt(tokens, index + 1),
      )
    ) {
      return "package_task";
    }
    return null;
  }
  if (isAgentAutoReviewFilesystemDeletionCommand(command)) {
    return "filesystem_delete";
  }
  if (
    /(?:^|[;&|\s])(?:\.\.?[\\/]|[\\/]|(?:bash|sh|zsh|fish|node|python\d*|ruby|perl)\s+\S+|(?:npm|pnpm|yarn|bun)\s+\S+)/iu.test(
      command,
    )
  ) {
    return /(?:npm|pnpm|yarn|bun)\s+/iu.test(command)
      ? "package_task"
      : "script";
  }
  return null;
};

const getWorkingDirectory = (sandbox: AnySandbox): string | undefined => {
  if (isCentrifugoSandbox(sandbox)) return sandbox.getWorkingDirectory();
  return "/home/user";
};

const isWindowsSandbox = (sandbox: AnySandbox): boolean =>
  isCentrifugoSandbox(sandbox) && sandbox.isWindows();

const isPathWithin = (candidate: string, root: string): boolean =>
  candidate === root || candidate.startsWith(`${root.replace(/\/$/u, "")}/`);

const classifyScope = (
  targetPath: string,
  workingDirectory: string,
): "workspace" | "temporary" | "outside" => {
  if (isPathWithin(targetPath, workingDirectory)) return "workspace";
  if (targetPath !== "/tmp" && isPathWithin(targetPath, "/tmp")) {
    return "temporary";
  }
  return "outside";
};

const hasSensitiveSegment = (targetPath: string): boolean =>
  targetPath
    .split("/")
    .filter(Boolean)
    .some((segment) =>
      SENSITIVE_PATH_SEGMENTS.has(
        segment === ".env" || segment.startsWith(".env.") ? ".env" : segment,
      ),
    );

const directoryEntryPath = (
  parent: string,
  entry: { name?: unknown; path?: unknown },
): string | null => {
  const raw =
    typeof entry.path === "string"
      ? entry.path
      : typeof entry.name === "string"
        ? entry.name
        : null;
  if (!raw) return null;
  return path.posix.isAbsolute(raw) ? raw : path.posix.join(parent, raw);
};

const inspectPath = async ({
  sandbox,
  targetPath,
  scope,
}: {
  sandbox: AnySandbox;
  targetPath: string;
  scope: "workspace" | "temporary" | "outside";
}): Promise<InspectedPath> => {
  const signatureEntries: unknown[] = [];
  let entryCount = 0;

  const inspectNode = async (
    nodePath: string,
    relativePath: string,
    depth: number,
  ): Promise<"missing" | "file" | "directory" | "symlink" | "other"> => {
    if (depth > MAX_DELETE_TREE_DEPTH) throw new Error("tree-depth");

    let state: "missing" | "file" | "directory" | "symlink" | "other";
    let sizeBytes: number | undefined;
    let modifiedTime: string | undefined;
    let symlinkTarget: string | undefined;

    if (isCloudSandbox(sandbox)) {
      const files = sandbox.files as typeof sandbox.files & {
        exists?: (candidate: string) => Promise<boolean>;
        getInfo?: (candidate: string) => Promise<{
          type?: string;
          size?: number;
          modifiedTime?: Date;
          symlinkTarget?: string;
        }>;
      };
      if (files.exists && !(await files.exists(nodePath))) {
        state = "missing";
      } else if (files.getInfo) {
        const info = await files.getInfo(nodePath);
        state =
          info.type === "file"
            ? "file"
            : info.type === "dir"
              ? "directory"
              : info.type === "symlink"
                ? "symlink"
                : "other";
        sizeBytes = info.size;
        modifiedTime = info.modifiedTime?.toISOString();
        symlinkTarget = info.symlinkTarget;
      } else {
        throw new Error("missing-get-info");
      }
    } else {
      if (!sandbox.supportsNativeFileRelay())
        throw new Error("no-native-files");
      const info = await sandbox.files.stat(nodePath);
      state =
        info.kind === "missing"
          ? "missing"
          : info.kind === "file"
            ? "file"
            : "directory";
      sizeBytes = info.sizeBytes;
    }

    signatureEntries.push({
      relativePath,
      state,
      sizeBytes,
      modifiedTime,
      symlinkTarget,
    });
    if (state === "symlink") throw new Error("symlink");
    if (state !== "directory") return state;

    const entries = (await sandbox.files.list(nodePath)) as Array<{
      name?: unknown;
      path?: unknown;
    }>;
    const childPaths = entries
      .map((entry) => directoryEntryPath(nodePath, entry))
      .filter((entryPath): entryPath is string => !!entryPath)
      .sort();
    for (const childPath of childPaths) {
      entryCount += 1;
      if (entryCount > MAX_DELETE_TREE_ENTRIES) throw new Error("tree-size");
      await inspectNode(
        childPath,
        path.posix.relative(targetPath, childPath),
        depth + 1,
      );
    }
    return state;
  };

  try {
    const state = await inspectNode(targetPath, ".", 0);
    const root = signatureEntries[0] as { sizeBytes?: number } | undefined;
    return {
      public: {
        path: targetPath,
        scope,
        state,
        ...(root?.sizeBytes !== undefined ? { sizeBytes: root.sizeBytes } : {}),
        ...(state === "directory" ? { entryCount } : {}),
      },
      signature: signatureEntries,
      complete: true,
    };
  } catch (error) {
    const marker = error instanceof Error ? error.message : "";
    return {
      public: {
        path: targetPath,
        scope,
        state: marker === "symlink" ? "symlink" : "other",
      },
      signature: signatureEntries,
      complete: false,
      reason:
        marker === "tree-depth" || marker === "tree-size"
          ? "too_broad"
          : "inspection_failed",
    };
  }
};

const deletionTargets = (tokens: string[]): string[] | null => {
  const executable = tokens[0].toLowerCase();
  if (!DELETE_COMMANDS.has(executable)) return null;
  const targets: string[] = [];
  let optionsEnded = false;
  for (const token of tokens.slice(1)) {
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("-")) continue;
    targets.push(token);
  }
  return targets.length > 0 ? targets : null;
};

const inspectDeletion = async ({
  candidate,
  sandbox,
  workingDirectory,
}: {
  candidate: Extract<ParsedCandidate, { kind: "filesystem_delete" }>;
  sandbox: AnySandbox;
  workingDirectory: string;
}): Promise<AgentAutoReviewTerminalInspection> => {
  const rawTargets = deletionTargets(candidate.tokens);
  if (!RESOLVABLE_DELETE_COMMANDS.has(candidate.tokens[0].toLowerCase())) {
    return unresolved({
      kind: candidate.kind,
      reason: "dynamic_command",
      workingDirectory,
    });
  }
  if (!rawTargets || rawTargets.length > MAX_DELETE_TARGETS) {
    return unresolved({
      kind: candidate.kind,
      reason: "too_broad",
      workingDirectory,
    });
  }

  const normalizedTargets = rawTargets.map((rawTarget) =>
    path.posix.resolve(workingDirectory, rawTarget),
  );
  if (
    normalizedTargets.some(
      (targetPath) =>
        targetPath === "/" ||
        targetPath === workingDirectory ||
        targetPath === "/home" ||
        targetPath === "/home/user",
    )
  ) {
    return unresolved({
      kind: candidate.kind,
      reason: "too_broad",
      workingDirectory,
    });
  }
  const scopes = normalizedTargets.map((targetPath) =>
    classifyScope(targetPath, workingDirectory),
  );
  if (scopes.some((scope) => scope === "outside")) {
    return unresolved({
      kind: candidate.kind,
      reason: "outside_scope",
      workingDirectory,
    });
  }
  if (normalizedTargets.some(hasSensitiveSegment)) {
    return unresolved({
      kind: candidate.kind,
      reason: "sensitive_target",
      workingDirectory,
    });
  }

  const inspected = await Promise.all(
    normalizedTargets.map((targetPath, index) =>
      inspectPath({
        sandbox,
        targetPath,
        scope: scopes[index],
      }),
    ),
  );
  const incomplete = inspected.find((target) => !target.complete);
  if (incomplete) {
    return {
      ...unresolved({
        kind: candidate.kind,
        reason: incomplete.reason ?? "inspection_failed",
        workingDirectory,
      }),
      targets: inspected.map((target) => target.public),
    };
  }
  const targets = inspected.map((target) => target.public);
  return {
    kind: candidate.kind,
    status: "resolved",
    workingDirectory,
    targets,
    fingerprint: digest({
      commandTokens: candidate.tokens,
      targets: inspected.map((target) => target.signature),
    }),
  };
};

const scriptPathFromTokens = (tokens: string[]): string | null => {
  const executable = tokens[0].toLowerCase();
  if (/^(?:\.\.?[\\/]|[\\/])/u.test(tokens[0])) return tokens[0];
  if (!SCRIPT_INTERPRETERS.has(executable)) return null;
  return tokens[1] && !tokens[1].startsWith("-") ? tokens[1] : null;
};

const inspectScript = ({
  candidate,
  workingDirectory,
}: {
  candidate: Extract<ParsedCandidate, { kind: "script" }>;
  workingDirectory: string;
}): AgentAutoReviewTerminalInspection => {
  const rawScriptPath = scriptPathFromTokens(candidate.tokens);
  if (!rawScriptPath) {
    return unresolved({
      kind: candidate.kind,
      reason: "dynamic_command",
      workingDirectory,
    });
  }
  const scriptPath = path.posix.resolve(workingDirectory, rawScriptPath);
  const scope = classifyScope(scriptPath, workingDirectory);
  if (scope === "outside") {
    return unresolved({
      kind: candidate.kind,
      reason: "outside_scope",
      workingDirectory,
    });
  }
  if (hasSensitiveSegment(scriptPath)) {
    return unresolved({
      kind: candidate.kind,
      reason: "sensitive_target",
      workingDirectory,
    });
  }
  // Every current sandbox file reader can follow a leaf or parent symlink.
  // Do not send file contents to the separate reviewer until the transport
  // can open a bounded regular file without following links in one operation.
  return unresolved({
    kind: candidate.kind,
    reason: "inspection_failed",
    workingDirectory,
  });
};

const packageTaskName = (tokens: string[]): string | null => {
  const first = tokens[1]?.toLowerCase();
  return first === "run" ? (tokens[2] ?? null) : (tokens[1] ?? null);
};

const inspectPackageTask = ({
  candidate,
  workingDirectory,
}: {
  candidate: Extract<ParsedCandidate, { kind: "package_task" }>;
  workingDirectory: string;
}): AgentAutoReviewTerminalInspection => {
  const taskName = packageTaskName(candidate.tokens);
  if (!taskName || taskName.startsWith("-")) {
    return unresolved({
      kind: candidate.kind,
      reason: "dynamic_command",
      workingDirectory,
    });
  }
  // package.json may itself be a link or live under a linked directory.
  return unresolved({
    kind: candidate.kind,
    reason: "inspection_failed",
    workingDirectory,
  });
};

export const collectAgentAutoReviewTerminalInspection = async ({
  command,
  sandbox,
}: {
  command: string;
  sandbox: AnySandbox;
}): Promise<AgentAutoReviewTerminalInspection | undefined> => {
  const kind = getAgentAutoReviewInspectionKind(command);
  if (!kind) return undefined;
  const workingDirectory = getWorkingDirectory(sandbox);
  if (!workingDirectory) {
    return unresolved({ kind, reason: "missing_working_directory" });
  }
  if (isWindowsSandbox(sandbox)) {
    return unresolved({
      kind,
      reason: "unsupported_platform",
      workingDirectory,
    });
  }
  const tokens = tokenizeStaticTerminalCommand(command);
  const candidate = tokens ? classifyStaticTokens(tokens) : null;
  if (!candidate || candidate.kind !== kind) {
    return unresolved({ kind, reason: "dynamic_command", workingDirectory });
  }
  if (candidate.kind === "filesystem_delete") {
    return inspectDeletion({ candidate, sandbox, workingDirectory });
  }
  if (candidate.kind === "script") {
    return inspectScript({ candidate, workingDirectory });
  }
  return inspectPackageTask({ candidate, workingDirectory });
};

export const terminalInspectionMatches = ({
  reviewed,
  current,
}: {
  reviewed: AgentAutoReviewTerminalInspection | undefined;
  current: AgentAutoReviewTerminalInspection | undefined;
}): boolean => {
  if (!reviewed) return current === undefined;
  return (
    reviewed.status === "resolved" &&
    current?.status === "resolved" &&
    reviewed.kind === current.kind &&
    !!reviewed.fingerprint &&
    reviewed.fingerprint === current.fingerprint
  );
};
