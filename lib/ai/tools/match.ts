import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/types";
import { truncateOutput } from "@/lib/token-utils";

/** Max files returned by glob — matches opencode's limit of 100. */
const GLOB_MAX_RESULTS = 100;
/** Max match results returned by grep — matches opencode's limit of 100. */
const GREP_MAX_MATCHES = 100;
/** Max characters per line before truncation — matches opencode's 2000 char limit. */
const MAX_LINE_LENGTH = 2000;
/**
 * Shell-level line buffer for grep — generous headroom above GREP_MAX_MATCHES to
 * account for context lines (-B/-A) and separator lines ("--") that don't count
 * as matches. Post-processing in TypeScript enforces the actual match cap.
 */
const GREP_LINE_BUFFER = 2000;
const COMMAND_TIMEOUT_MS = 30000;
const PREFLIGHT_TIMEOUT_MS = 5000;

/**
 * Escape single quotes in a string for embedding inside bash -c '...' scripts.
 * Replaces ' with '\'' (end quote, escaped quote, start quote).
 */
export function escapeSingleQuotes(str: string): string {
  return str.replace(/'/g, "'\\''");
}

/**
 * Shell pipeline that reads null-separated file paths from stdin and outputs
 * them sorted by modification time (newest first).
 * Detects GNU stat (Linux) vs BSD stat (macOS) at runtime.
 */
function mtimeSortPipeline(): string {
  return (
    `sh -c 'if stat -c "%Y" /dev/null >/dev/null 2>&1; then` +
    ` xargs -0 stat -c "%Y %n" 2>/dev/null;` +
    ` else xargs -0 stat -f "%m %N" 2>/dev/null; fi'` +
    ` | sort -rn | cut -d" " -f2-`
  );
}

/**
 * Shell expression that decodes a base64 string, compatible with both
 * GNU coreutils (base64 -d) and BSD/macOS (base64 -D).
 */
function base64DecodeExpr(b64Value: string): string {
  return `(echo "${b64Value}" | base64 -d 2>/dev/null || echo "${b64Value}" | base64 -D 2>/dev/null)`;
}

/**
 * Parse a scope glob pattern into a base directory and optional glob filter
 * for use with ripgrep arguments.
 *
 * Examples:
 *   `/home/user/**\/*.py` → `{ baseDir: "/home/user", globPattern: "**\/*.py" }`
 *   `/home/user/src/**`   → `{ baseDir: "/home/user/src", globPattern: null }`
 *   `**\/*.ts`            → `{ baseDir: ".", globPattern: "**\/*.ts" }`
 */
export function parseScope(scope: string): {
  baseDir: string;
  globPattern: string | null;
} {
  const globChars = ["*", "?", "[", "{"];
  const parts = scope.split("/");

  const baseParts: string[] = [];
  const globParts: string[] = [];
  let foundGlob = false;

  for (const part of parts) {
    if (!foundGlob && !globChars.some((c) => part.includes(c))) {
      baseParts.push(part);
    } else {
      foundGlob = true;
      globParts.push(part);
    }
  }

  const baseDir = baseParts.join("/") || ".";
  const globPattern = globParts.length > 0 ? globParts.join("/") : null;

  return { baseDir, globPattern };
}

/**
 * Run a pre-flight check to verify ripgrep is available and the base path exists.
 * Returns null if everything is fine, or a descriptive error string for the agent.
 */
async function preflightCheck(
  sandbox: any,
  safeBaseDir: string,
): Promise<string | null> {
  try {
    const result = await sandbox.commands.run(
      `command -v rg >/dev/null 2>&1 || echo "ERR_NO_RG"; test -e '${safeBaseDir}' || echo "ERR_NO_PATH"`,
      { timeoutMs: PREFLIGHT_TIMEOUT_MS },
    );
    const out = String(result?.stdout ?? "").trim();

    if (out.includes("ERR_NO_RG")) {
      return "Error: ripgrep (rg) is not installed in the sandbox. Install it with: apt-get install -y ripgrep";
    }
    if (out.includes("ERR_NO_PATH")) {
      const displayPath = safeBaseDir.replace(/^'|'$/g, "");
      return `Error: Path '${displayPath}' does not exist. Verify the scope path is correct and use an absolute path (e.g. /home/user/project/**/*.ts).`;
    }
    return null;
  } catch {
    // If preflight itself fails, let the main command attempt and report its own error
    return null;
  }
}

/**
 * Classify ripgrep stderr into a meaningful, actionable error message for the agent.
 */
export function formatRgError(
  stderr: string,
  action: string,
  scope: string,
): string {
  const lower = stderr.toLowerCase();

  if (
    lower.includes("regex parse error") ||
    lower.includes("error parsing regex")
  ) {
    const detail = stderr.split("\n").filter(Boolean).slice(0, 2).join(" ");
    return `Error: Invalid regex pattern — ${detail}. Fix the regex syntax and retry.`;
  }
  if (lower.includes("invalid glob") || lower.includes("unmatched")) {
    return `Error: Invalid glob pattern in scope '${scope}'. Check bracket/brace matching and pattern syntax.`;
  }
  if (lower.includes("permission denied")) {
    return `Error: Permission denied accessing paths in '${scope}'. Some files or directories are not readable.`;
  }
  if (lower.includes("no such file or directory")) {
    return `Error: A path referenced in scope '${scope}' does not exist. Verify the directory structure.`;
  }

  const firstLine = stderr.split("\n")[0]?.trim();
  return `Error: ${action} failed — ${firstLine || "unknown error"}. Scope: '${scope}'.`;
}

/**
 * Read captured rg stderr from temp file and clean up.
 * Returns raw stderr content, or null if empty/unreadable.
 */
async function readErrFile(
  sandbox: any,
  errFile: string,
): Promise<string | null> {
  try {
    const errResult = await sandbox.commands.run(
      `cat '${errFile}' 2>/dev/null; rm -f '${errFile}'`,
      { timeoutMs: PREFLIGHT_TIMEOUT_MS },
    );
    const stderr = String(errResult?.stdout ?? "").trim();
    return stderr || null;
  } catch {
    return null;
  }
}

/**
 * Classify top-level execution errors (sandbox issues, timeouts, network)
 * into actionable messages for the agent.
 */
export function classifyExecutionError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "Error: Search timed out. Try a more specific scope pattern to narrow the search area, or increase specificity of the glob/regex.";
  }
  if (
    lower.includes("sandbox") &&
    (lower.includes("not ready") ||
      lower.includes("not found") ||
      lower.includes("failed"))
  ) {
    return "Error: Sandbox environment is not available. It may still be starting — retry in a moment.";
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("econnreset") ||
    lower.includes("network")
  ) {
    return "Error: Network error communicating with the sandbox. Check sandbox status and retry.";
  }
  if (lower.includes("enospc") || lower.includes("no space")) {
    return "Error: Sandbox disk is full. Free up space and retry.";
  }

  return `Error: Search failed unexpectedly — ${msg}`;
}

export const createMatch = (context: ToolContext) => {
  const { sandboxManager } = context;

  return tool({
    description: `Find files or text in the sandbox file system using pattern matching.

<supported_actions>
- \`glob\`: Match file paths and names using glob-style patterns
- \`grep\`: Search file contents using regex-based full-text matching
</supported_actions>

<instructions>
- \`glob\` action matches only file names and paths, returning a list of matching files
- \`grep\` action searches for a \`regex\` pattern inside all files matching \`scope\`, returning matched text snippets
- \`scope\` defines the glob pattern that restricts the search range for both \`glob\` and \`grep\` actions
- \`scope\` must be a glob pattern using absolute paths, e.g., \`/home/user/**/*.py\`
- \`regex\` applies only to \`grep\` action and is case sensitive by default
- Results are returned in descending order of file modification time for both actions
</instructions>

<recommended_usage>
- Use \`glob\` to locate files by name, extension, or directory pattern
- Use \`grep\` to find occurrences of specific text across files
- Use \`grep\` with \`leading\` and \`trailing\` to view surrounding context in code or logs
</recommended_usage>`,
    inputSchema: z.object({
      action: z.enum(["glob", "grep"]).describe("The search action to perform"),
      brief: z
        .string()
        .describe(
          "A one-sentence preamble describing the purpose of this operation",
        ),
      scope: z
        .string()
        .describe(
          "The glob pattern that defines the absolute file path and name scope, e.g., /home/user/**/*.py",
        ),
      regex: z
        .string()
        .optional()
        .describe(
          "The regex pattern to match file content; required for grep action",
        ),
      leading: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Number of lines to include before each match as context; optional, defaults to 0",
        ),
      trailing: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Number of lines to include after each match as context; optional, defaults to 0",
        ),
    }),
    execute: async ({ action, scope, regex, leading, trailing }) => {
      try {
        const { sandbox } = await sandboxManager.getSandbox();

        if (action === "glob") {
          return await executeGlob(sandbox, scope);
        } else {
          if (!regex) {
            return {
              output:
                "Error: regex parameter is required for grep action. Provide a regex pattern to search for.",
            };
          }
          return await executeGrep(
            sandbox,
            scope,
            regex,
            leading || 0,
            trailing || 0,
          );
        }
      } catch (error) {
        return { output: classifyExecutionError(error) };
      }
    },
  });
};

/**
 * Use ripgrep in file-listing mode (`rg --files`) to find files matching
 * the scope pattern, then sort by modification time (newest first).
 */
async function executeGlob(
  sandbox: any,
  scope: string,
): Promise<{ output: string }> {
  const { baseDir, globPattern } = parseScope(scope);
  const safeBaseDir = escapeSingleQuotes(baseDir);

  // Pre-flight: verify rg is available and path exists
  const preError = await preflightCheck(sandbox, safeBaseDir);
  if (preError) return { output: preError };

  // Unique temp file to capture rg stderr without race conditions
  const errFile = `/tmp/_match_err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Build rg --files command (matches opencode's approach)
  const rgArgs = ["rg", "--files", "--hidden", "--glob='!.git/*'"];
  if (globPattern) {
    rgArgs.push(`--glob='${escapeSingleQuotes(globPattern)}'`);
  }
  rgArgs.push(`'${safeBaseDir}'`);

  // Fetch more than the limit so we can detect truncation, then sort by mtime
  const fetchLimit = GLOB_MAX_RESULTS + 1;
  // Redirect rg stderr to temp file for diagnostics instead of discarding it
  const cmd = `${rgArgs.join(" ")} 2>'${errFile}' | head -${fetchLimit} | tr '\\n' '\\0' | ${mtimeSortPipeline()}`;

  const result = await sandbox.commands.run(cmd, {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });

  const output = String(result?.stdout ?? "").trim();
  const stderrContent = await readErrFile(sandbox, errFile);

  if (!output) {
    if (stderrContent)
      return { output: formatRgError(stderrContent, "glob", scope) };
    return { output: `No files found matching: ${scope}` };
  }

  const allFiles = output.split("\n").filter(Boolean);
  const truncated = allFiles.length > GLOB_MAX_RESULTS;
  const files = truncated ? allFiles.slice(0, GLOB_MAX_RESULTS) : allFiles;

  let resultText = `Found ${files.length} file${files.length === 1 ? "" : "s"}\n${files.join("\n")}`;
  if (truncated) {
    resultText +=
      "\n(Results truncated: showing first " +
      GLOB_MAX_RESULTS +
      " results. Use a more specific path or pattern to narrow results.)";
  }
  return { output: truncateOutput({ content: resultText }) };
}

/**
 * A single parsed entry from rg --json output.
 */
interface GrepEntry {
  file: string;
  lineNo: number;
  content: string;
  isMatch: boolean;
}

/**
 * Use ripgrep with --json output for structured parsing, group results by file,
 * and sort file groups by modification time (newest first).
 * Handles rg exit code 2 gracefully — returns partial matches with a note.
 */
async function executeGrep(
  sandbox: any,
  scope: string,
  regex: string,
  leading: number,
  trailing: number,
): Promise<{ output: string }> {
  const { baseDir, globPattern } = parseScope(scope);
  const safeBaseDir = escapeSingleQuotes(baseDir);

  // Pre-flight: verify rg is available and path exists
  const preError = await preflightCheck(sandbox, safeBaseDir);
  if (preError) return { output: preError };

  // Unique temp file to capture rg stderr without race conditions
  const errFile = `/tmp/_match_err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Build rg command — use --json for structured output (matches opencode's approach)
  const rgArgs = [
    "rg",
    "--json",
    "--hidden",
    "--no-messages",
    "--glob='!.git/*'",
  ];
  if (leading > 0) rgArgs.push(`-B ${leading}`);
  if (trailing > 0) rgArgs.push(`-A ${trailing}`);
  if (globPattern) {
    rgArgs.push(`--glob='${escapeSingleQuotes(globPattern)}'`);
  }

  // Encode regex as base64 to safely pass it without shell escaping issues
  const regexB64 = Buffer.from(regex).toString("base64");

  // Use a generous line buffer — post-processing enforces the actual match cap
  const cmd = `PATTERN=$(${base64DecodeExpr(regexB64)}) && ${rgArgs.join(" ")} -e "$PATTERN" '${safeBaseDir}' 2>'${errFile}' | head -${GREP_LINE_BUFFER}`;

  const result = await sandbox.commands.run(cmd, {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });

  const rawOutput = String(result?.stdout ?? "").trim();
  // Always read stderr — needed for exit code 2 handling even when output exists
  const stderrContent = await readErrFile(sandbox, errFile);

  if (!rawOutput) {
    if (stderrContent)
      return { output: formatRgError(stderrContent, "grep", scope) };
    return { output: `No matches found for "${regex}" in ${scope}` };
  }

  // --- Parse JSON lines into structured entries ---
  const entries: GrepEntry[] = [];
  const uniqueFiles = new Set<string>();

  for (const line of rawOutput.split("\n")) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "match" || obj.type === "context") {
        const file: string = obj.data.path.text;
        const lineNo: number = obj.data.line_number;
        const content: string = (obj.data.lines.text || "").replace(/\n$/, "");
        entries.push({ file, lineNo, content, isMatch: obj.type === "match" });
        uniqueFiles.add(file);
      }
    } catch {
      // Skip unparseable lines (truncated JSON from head, summary lines, etc.)
    }
  }

  if (entries.length === 0) {
    if (stderrContent)
      return { output: formatRgError(stderrContent, "grep", scope) };
    return { output: `No matches found for "${regex}" in ${scope}` };
  }

  // --- Sort files by modification time (newest first) ---
  const filePaths = [...uniqueFiles];
  const fileListB64 = Buffer.from(filePaths.join("\n")).toString("base64");
  const statCmd = `${base64DecodeExpr(fileListB64)} | tr '\\n' '\\0' | ${mtimeSortPipeline()}`;

  const statResult = await sandbox.commands.run(statCmd, {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });

  // mtimeSortPipeline() already strips timestamps via `cut -d" " -f2-`,
  // so each line is just a filepath — push directly.
  const fileOrder: string[] = [];
  for (const line of String(statResult?.stdout ?? "")
    .trim()
    .split("\n")) {
    if (!line) continue;
    fileOrder.push(line);
  }
  // Append any files that stat couldn't resolve (defensive)
  for (const f of filePaths) {
    if (!fileOrder.includes(f)) fileOrder.push(f);
  }

  // --- Group entries by file ---
  const fileGroups = new Map<string, GrepEntry[]>();
  for (const entry of entries) {
    let group = fileGroups.get(entry.file);
    if (!group) {
      group = [];
      fileGroups.set(entry.file, group);
    }
    group.push(entry);
  }

  // --- Build grouped output, respecting match cap ---
  const totalMatches = entries.filter((e) => e.isMatch).length;
  const outputParts: string[] = [];
  let matchCount = 0;

  for (const file of fileOrder) {
    if (matchCount >= GREP_MAX_MATCHES) break;

    const group = fileGroups.get(file);
    if (!group) continue;

    const lines: string[] = [];
    for (const entry of group) {
      if (entry.isMatch && matchCount >= GREP_MAX_MATCHES) break;

      let formatted = `${entry.lineNo}|${entry.content}`;
      if (formatted.length > MAX_LINE_LENGTH) {
        formatted = formatted.slice(0, MAX_LINE_LENGTH) + "...";
      }
      lines.push(formatted);
      if (entry.isMatch) matchCount++;
    }

    if (lines.length > 0) {
      outputParts.push(file + "\n" + lines.join("\n"));
    }
  }

  // --- Format final result ---
  const truncated = totalMatches > GREP_MAX_MATCHES;

  let resultText = `Found ${totalMatches} match${totalMatches === 1 ? "" : "es"}${truncated ? ` (showing first ${GREP_MAX_MATCHES})` : ""}\n\n${outputParts.join("\n\n")}`;

  if (truncated) {
    const hidden = totalMatches - matchCount;
    resultText +=
      "\n\n(Results truncated: showing " +
      GREP_MAX_MATCHES +
      " of " +
      totalMatches +
      " matches (" +
      hidden +
      " hidden). Use a more specific path or pattern to narrow results.)";
  }
  // Exit code 2 handling: rg had errors but still produced matches
  if (stderrContent) {
    resultText += "\n(Some paths were inaccessible and skipped.)";
  }

  return { output: truncateOutput({ content: resultText }) };
}
