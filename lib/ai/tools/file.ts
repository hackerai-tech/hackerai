import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/types";
import { truncateOutput } from "@/lib/token-utils";

const editSchema = z.object({
  find: z.string().describe("The exact text string to find in the file"),
  replace: z
    .string()
    .describe("The replacement text that will substitute the found text"),
  all: z
    .boolean()
    .optional()
    .describe(
      "Whether to replace all occurrences instead of just the first one. Defaults to false.",
    ),
});

export const createFile = (context: ToolContext) => {
  const { sandboxManager } = context;

  return tool({
    description: `Perform operations on files in the sandbox file system.

<supported_actions>
read: Read file content as text
write: Overwrite the full content of a text file
append: Append content to a text file
edit: Make targeted edits to a text file
</supported_actions>

<instructions>
- Prioritize using this tool for file content operations instead of shell tool to avoid escaping errors
- For file copying, moving, and deletion operations, use shell tool to complete them
- Under read action, the range parameter represents line number ranges (1-indexed, -1 for end of file)
- If the range parameter is not specified, the entire file will be read by default
- DO NOT use the range parameter when reading a file for the first time; if the content is too long and gets truncated, the result will include range hints
- write and append actions will automatically create files if they do not exist, no need to write first then append
- When writing and appending text, ensure necessary trailing newlines are used to comply with POSIX standards
- Code MUST be saved to a file using this tool before execution via shell tool to enable debugging and future modifications
- DO NOT read files that were just written, as their content remains in context
- DO NOT repeatedly read template files or boilerplate code that has already been reviewed once; focus on user-modified or project-specific files
- Choose appropriate file extensions based on file content and syntax, e.g., Markdown syntax MUST use .md extension
- DO NOT write partial or truncated content, always output full content
- edit can make multiple edits to a single file at once, all edits will be applied sequentially, all must succeed or none are applied
- For extensive modifications to shorter files, use write to rewrite the entire file instead of using edit for modifications
</instructions>

<recommended_usage>
Use read to read text files
Use read with range parameter to read specific parts of log files
Use write to create files and record key findings
Use write to save code to files before execution via shell tool
Use write to refactor code files or rewrite short documents
Use append to write long content in segments
Use edit to fix errors in code
Use edit to update markers in todo lists
</recommended_usage>`,
    inputSchema: z.object({
      action: z
        .enum(["read", "write", "append", "edit"])
        .describe("The action to perform"),
      path: z.string().describe("The absolute path to the target file"),
      brief: z
        .string()
        .describe(
          "A one-sentence preamble describing the purpose of this operation",
        ),
      text: z
        .string()
        .optional()
        .describe(
          "The content to be written or appended. Required for `write` and `append` actions.",
        ),
      range: z
        .array(z.number().int())
        .length(2)
        .optional()
        .describe(
          "An array of two integers specifying the start and end of the range. Numbers are 1-indexed, and -1 for the end means read to the end of the file. Optional and only used for `read` action.",
        ),
      edits: z
        .array(editSchema)
        .optional()
        .describe(
          "A list of edits to be sequentially applied to the file. Required for `edit` action.",
        ),
    }),
    execute: async ({ action, path, text, range, edits }) => {
      try {
        const { sandbox } = await sandboxManager.getSandbox();

        switch (action) {
          case "read": {
            const fileContent = await sandbox.files.read(path, {
              user: "user" as const,
            });

            if (!fileContent || fileContent.trim() === "") {
              return { error: "File is empty." };
            }

            const lines = fileContent.split("\n");
            const filename = path.split("/").pop() || path;
            const totalLines = lines.length;

            // Validate range if provided
            if (range) {
              const [start, end] = range;

              if (start < 1) {
                return {
                  error: `Invalid start_line: ${start}. Line numbers are 1-indexed, must be >= 1.`,
                };
              }

              if (end !== -1 && end < start) {
                return {
                  error: `Invalid range: start_line (${start}) cannot be greater than end_line (${end}).`,
                };
              }

              if (start > totalLines) {
                return {
                  error: `Invalid start_line: ${start}. File ${filename} has ${totalLines} lines (1-indexed).`,
                };
              }

              if (end !== -1 && end > totalLines) {
                return {
                  error: `Invalid end_line: ${end}. File ${filename} has ${totalLines} lines (1-indexed).`,
                };
              }
            }

            // Apply range if provided
            let processedLines = lines;
            let startLineNumber = 1;

            if (range) {
              const [start, end] = range;
              startLineNumber = start;
              const startIndex = start - 1; // Convert to 0-based index
              const endIndex = end === -1 ? lines.length : end;
              processedLines = lines.slice(startIndex, endIndex);
            }

            // Add line numbers (padded format with pipe separator)
            const numberedLines = processedLines.map((line, index) => {
              const lineNumber = startLineNumber + index;
              return `${lineNumber.toString().padStart(6)}|${line}`;
            });

            const numberedContent = numberedLines.join("\n");
            const result = `Text file: ${filename}\nLatest content with line numbers:\n${numberedContent}`;
            const truncatedResult = truncateOutput({
              content: result,
              mode: "read-file",
            }) as string;

            // Return object with raw content for UI and formatted content for model
            return {
              content: truncatedResult,
              originalContent: truncateOutput({
                content: processedLines.join("\n"),
                mode: "read-file",
              }),
            };
          }

          case "write": {
            if (text === undefined) {
              return { error: "text is required for write action" };
            }

            await sandbox.files.write(path, text, {
              user: "user" as const,
            });

            return `File written: ${path}`;
          }

          case "append": {
            if (text === undefined) {
              return { error: "text is required for append action" };
            }

            // Read existing content first
            let existingContent = "";
            try {
              existingContent = await sandbox.files.read(path, {
                user: "user" as const,
              });
            } catch {
              // File doesn't exist, start with empty content
            }

            // Append directly without adding extra newline - agent controls exact content
            const newContent = existingContent + text;

            await sandbox.files.write(path, newContent, {
              user: "user" as const,
            });

            // Return both original and modified content for UI diff view in computer sidebar
            // toModelOutput controls what the model sees (summary only)
            return {
              content: `File appended: ${path}`,
              originalContent: truncateOutput({
                content: existingContent,
                mode: "read-file",
              }),
              modifiedContent: truncateOutput({
                content: newContent,
                mode: "read-file",
              }),
            };
          }

          case "edit": {
            if (!edits || edits.length === 0) {
              return { error: "edits array is required for edit action" };
            }

            // Read existing content
            const originalContent = await sandbox.files.read(path, {
              user: "user" as const,
            });

            if (!originalContent) {
              return {
                error: `Cannot edit file ${path} - file is empty or does not exist`,
              };
            }

            // Validate all find strings exist before applying any edits (atomic behavior)
            const missingFinds: { index: number; find: string }[] = [];
            for (let i = 0; i < edits.length; i++) {
              if (!originalContent.includes(edits[i].find)) {
                missingFinds.push({ index: i + 1, find: edits[i].find });
              }
            }

            if (missingFinds.length > 0) {
              const details = missingFinds
                .map(
                  (m) =>
                    `Edit #${m.index}: "${m.find.length > 50 ? m.find.slice(0, 50) + "..." : m.find}"`,
                )
                .join("\n");
              return {
                error: `Atomic edit failed - the following find string(s) were not found in the file:\n${details}\nNo edits were applied.`,
              };
            }

            // Apply edits sequentially (all find strings validated above)
            let content = originalContent;
            let totalReplacements = 0;

            for (const edit of edits) {
              const { find, replace, all = false } = edit;

              if (all) {
                const count = content.split(find).length - 1;
                content = content.split(find).join(replace);
                totalReplacements += count;
              } else {
                content = content.replace(find, replace);
                totalReplacements += 1;
              }
            }

            // Write the modified content back
            await sandbox.files.write(path, content, {
              user: "user" as const,
            });

            // Format content with line numbers for model output (padded format with pipe separator)
            const lines = content.split("\n");
            const numberedLines = lines
              .map(
                (line, index) =>
                  `${(index + 1).toString().padStart(6)}|${line}`,
              )
              .join("\n");

            // Return full diff data (persisted for UI)
            // toModelOutput will control what the model sees
            return {
              content: truncateOutput({
                content: `Multi-edit completed: ${edits.length} edits applied, ${totalReplacements} total replacements made\nLatest content with line numbers:\n${numberedLines}`,
                mode: "read-file",
              }),
              originalContent: truncateOutput({
                content: originalContent,
                mode: "read-file",
              }),
              modifiedContent: truncateOutput({
                content,
                mode: "read-file",
              }),
            };
          }

          default:
            return { error: `Unknown action ${action}` };
        }
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    // Control what the model sees (exclude large diff content)
    toModelOutput({ output }) {
      // If output is a string (write action), pass through
      if (typeof output === "string") {
        return { type: "text" as const, value: output };
      }

      if (typeof output === "object" && output !== null) {
        // Handle error responses
        if ("error" in output) {
          return {
            type: "text" as const,
            value: `Error: ${(output as { error: string }).error}`,
          };
        }

        // For read, edit, and append actions, return the content message
        if ("content" in output) {
          return {
            type: "text" as const,
            value: (output as { content: string }).content,
          };
        }
      }

      // Fallback: stringify the output
      return { type: "text" as const, value: JSON.stringify(output) };
    },
  });
};
