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
 * Build the glob command to find files matching the pattern
 */
const buildGlobCommand = (scope: string): string => {
  const escapedScope = escapeForBashSingleQuote(scope);
  return `bash -c 'shopt -s globstar nullglob; files=(${escapedScope}); for f in "\${files[@]}"; do [[ -f "$f" ]] && echo "$f"; done | head -n ${MAX_FILES_GLOB}'`;
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

        await waitForSandboxReady(sandbox);

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
          const files = rawOutput
            .split("\n")
            .filter((line) => line.length > 0);

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
