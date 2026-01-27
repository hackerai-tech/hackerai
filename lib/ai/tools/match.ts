import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/types";
import { truncateOutput } from "@/lib/token-utils";
import { waitForSandboxReady } from "./utils/sandbox-health";

const MAX_FILES_GLOB = 1000;
const MAX_GREP_LINES = 5000;
const TIMEOUT_MS = 60 * 1000; // 60 seconds

/**
 * Escape a string for safe use in bash single quotes
 */
const escapeForBashSingleQuote = (str: string): string => {
  return str.replace(/'/g, "'\\''");
};

/**
 * Convert a glob pattern to a find -path pattern
 * Handles ** (any path), * (any name segment), ? (single char)
 */
const globToFindPattern = (glob: string): string => {
  // ** matches any path segment(s), convert to *
  // For find -path, * already matches across path separators
  return glob.replace(/\*\*/g, "*");
};

/**
 * Expand brace patterns like {a,b,c} into multiple patterns
 * Example: "*.{ts,tsx}" -> ["*.ts", "*.tsx"]
 * Example: "*{foo,bar}*" -> ["*foo*", "*bar*"]
 * Handles nested braces recursively
 */
const expandBraces = (pattern: string): string[] => {
  // Find the first brace group (non-greedy, innermost first for nested)
  const braceMatch = pattern.match(/\{([^{}]+)\}/);
  if (!braceMatch) {
    return [pattern];
  }

  const [fullMatch, alternatives] = braceMatch;
  const parts = alternatives.split(",");
  const beforeBrace = pattern.slice(0, braceMatch.index);
  const afterBrace = pattern.slice(braceMatch.index! + fullMatch.length);

  // Expand each alternative and recursively handle remaining braces
  const expanded: string[] = [];
  for (const part of parts) {
    const combined = beforeBrace + part + afterBrace;
    expanded.push(...expandBraces(combined));
  }

  return expanded;
};

/**
 * Parse a glob pattern to extract the base directory for efficient searching
 * Returns the longest path prefix that doesn't contain glob characters
 */
const extractBaseDir = (pattern: string): string => {
  // Find the first glob character (*, ?, [)
  const firstGlobIndex = pattern.search(/[*?[]/);
  if (firstGlobIndex === -1) {
    // No glob chars, use the directory part
    const lastSlash = pattern.lastIndexOf("/");
    return lastSlash > 0 ? pattern.substring(0, lastSlash) : "/";
  }

  // Get everything before the first glob char, then find the last slash
  const beforeGlob = pattern.substring(0, firstGlobIndex);
  const lastSlash = beforeGlob.lastIndexOf("/");
  return lastSlash > 0 ? beforeGlob.substring(0, lastSlash) : "/";
};

/**
 * Build the glob command to find files matching the pattern
 * Uses `fd` if available (fast, proper glob support), falls back to `find`
 * (bash globstar requires bash 4+ which macOS doesn't have by default)
 */
const buildGlobCommand = (scope: string): string => {
  const baseDir = extractBaseDir(scope);
  const escapedDir = escapeForBashSingleQuote(baseDir);

  // Check if pattern requires recursive traversal:
  // - Contains ** (matches any depth)
  // - Has path separators after glob characters (e.g., src/*/index.js)
  const firstGlobIndex = scope.search(/[*?[]/);
  const hasPathAfterGlob =
    firstGlobIndex !== -1 && scope.slice(firstGlobIndex).includes("/");
  const isRecursive = scope.includes("**") || hasPathAfterGlob;

  // fd -g matches against RELATIVE paths from search dir, so extract relative pattern
  // e.g., "/Users/foo/Downloads/**/*.csv" with baseDir "/Users/foo/Downloads" -> "**/*.csv"
  const relativePattern = scope.startsWith(baseDir + "/")
    ? scope.slice(baseDir.length + 1)
    : scope.startsWith(baseDir)
      ? scope.slice(baseDir.length) || "*"
      : scope;
  const escapedRelativePattern = escapeForBashSingleQuote(relativePattern);

  // fd command with relative pattern (supports ** and brace expansion natively)
  const fdCommand = `fd -H -I -t f -g '${escapedRelativePattern}' '${escapedDir}' 2>/dev/null`;

  // For find fallback, expand braces since find -path doesn't support them
  const expandedPatterns = expandBraces(scope);
  const findPatterns = expandedPatterns.map((p) =>
    escapeForBashSingleQuote(globToFindPattern(p)),
  );

  // Build find command with multiple -path conditions joined by -o
  const depthFlag = isRecursive ? "" : "-maxdepth 1 ";
  const pathConditions =
    findPatterns.length === 1
      ? `-path '${findPatterns[0]}'`
      : `\\( ${findPatterns.map((p) => `-path '${p}'`).join(" -o ")} \\)`;
  const findCommand = `find '${escapedDir}' ${depthFlag}-type f ${pathConditions} 2>/dev/null`;

  // Try fd first, fall back to find if fd not available OR if fd returns no results
  // (fd returns exit 0 even with no matches, so we check for output)
  return `{ command -v fd >/dev/null && out=$(${fdCommand}) && [ -n "$out" ] && printf '%s\\n' "$out"; } || ${findCommand} | head -n ${MAX_FILES_GLOB}`;
};

/**
 * Build the grep command to search file contents
 * Uses grep -r, skips binary files with -I
 */
const buildGrepCommand = (
  scope: string,
  regex: string,
  leading: number,
  trailing: number,
): string => {
  const escapedRegex = escapeForBashSingleQuote(regex);

  // Build context flags
  const contextFlags = [
    leading > 0 ? `-B ${leading}` : "",
    trailing > 0 ? `-A ${trailing}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  // grep: -r recursive, -I skip binary, -H filename, -n line numbers, -E extended regex
  return `grep -r -I -H -n -E ${contextFlags} '${escapedRegex}' ${scope} 2>/dev/null | head -n ${MAX_GREP_LINES}`;
};

export const createMatch = (context: ToolContext) => {
  const { sandboxManager, writer } = context;

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
</instructions>

<recommended_usage>
- Use \`glob\` to locate files by name, extension, or directory pattern
- Use \`grep\` to find occurrences of specific text across files
- Use \`grep\` with \`leading\` and \`trailing\` to view surrounding context in code or logs
</recommended_usage>`,
    inputSchema: z.object({
      action: z.enum(["glob", "grep"]).describe("The action to perform"),
      brief: z
        .string()
        .describe(
          "A one-sentence preamble describing the purpose of this operation",
        ),
      scope: z
        .string()
        .describe(
          "The glob pattern that defines the absolute file path and name scope",
        ),
      regex: z
        .string()
        .optional()
        .describe(
          "The regex pattern to match file content. Required for `grep` action.",
        ),
      leading: z
        .number()
        .int()
        .default(0)
        .describe(
          "Number of lines to include before each match as context. Optional and only used for `grep` action. Defaults to 0.",
        ),
      trailing: z
        .number()
        .int()
        .default(0)
        .describe(
          "Number of lines to include after each match as context. Optional and only used for `grep` action. Defaults to 0.",
        ),
    }),
    execute: async (
      {
        action,
        scope,
        regex,
        leading = 0,
        trailing = 0,
      }: {
        action: "glob" | "grep";
        brief: string;
        scope: string;
        regex?: string;
        leading?: number;
        trailing?: number;
      },
      { toolCallId, abortSignal },
    ) => {
      // Validate regex is provided for grep action
      if (action === "grep" && !regex) {
        return {
          output: `Error: The "regex" parameter is required for grep action.`,
        };
      }

      // Validate scope is an absolute path
      if (!scope.startsWith("/")) {
        return {
          output: `Error: The "scope" parameter must be an absolute path (starting with "/").`,
        };
      }

      try {
        // Get sandbox and ensure it's ready
        const { sandbox } = await sandboxManager.getSandbox();

        // Check for sandbox fallback and notify frontend
        const fallbackInfo = sandboxManager.consumeFallbackInfo?.();
        if (fallbackInfo?.occurred) {
          writer.write({
            type: "data-sandbox-fallback",
            id: `sandbox-fallback-${toolCallId}`,
            data: fallbackInfo,
          });
        }

        await waitForSandboxReady(sandbox, 5, abortSignal);

        // Build the appropriate command
        const command =
          action === "glob"
            ? buildGlobCommand(scope)
            : buildGrepCommand(scope, regex!, leading, trailing);

        // Execute the command with timeout
        const result = await sandbox.commands.run(command, {
          timeoutMs: TIMEOUT_MS,
        });

        // Handle abort signal
        if (abortSignal?.aborted) {
          return {
            output: `Search aborted by user.`,
          };
        }

        const rawOutput = (result.stdout + result.stderr).trim();

        // Format output based on action
        if (action === "glob") {
          const files = rawOutput.split("\n").filter((line) => line.length > 0);

          if (files.length === 0) {
            return {
              output: `No files found matching pattern "${scope}"`,
            };
          }

          const truncatedOutput = truncateOutput({
            content: files.join("\n"),
          });
          return {
            output: `Found ${files.length} file${files.length === 1 ? "" : "s"} matching pattern "${scope}":\n\n${truncatedOutput}`,
          };
        } else {
          // For grep, count matches (lines that contain the filename:linenum: pattern)
          const matchLines = rawOutput
            .split("\n")
            .filter((line) => /^[^:]+:\d+:/.test(line));

          if (matchLines.length === 0) {
            return {
              output: `No matches found for "${regex}" in ${scope}`,
            };
          }

          const truncatedOutput = truncateOutput({ content: rawOutput });
          return {
            output: `Found ${matchLines.length} match${matchLines.length === 1 ? "" : "es"} for "${regex}" in ${scope}:\n\n${truncatedOutput}`,
          };
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        // Check for timeout
        if (
          errorMessage.includes("timed out") ||
          errorMessage.includes("timeout")
        ) {
          return {
            output: `Search timed out after 60 seconds. Try narrowing your search scope or using a more specific pattern.`,
          };
        }

        return {
          output: `Search failed: ${errorMessage}`,
        };
      }
    },
  });
};
