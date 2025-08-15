import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./types";
import { searchReplaceLocalFile } from "./utils/local-file-operations";

export const createSearchReplace = (context: ToolContext) => {
  const { sandboxManager, executionMode } = context;

  return tool({
    description: `Performs exact string replacements in files.

Usage:
- When editing text, ensure you preserve the exact indentation (tabs/spaces) as it appears before.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`,
    inputSchema: z.object({
      file_path: z
        .string()
        .describe(
          "The path to the file to modify. Always specify the target file as the first argument. You can use either a relative path in the workspace or an absolute path.",
        ),
      old_string: z.string().describe("The text to replace"),
      new_string: z
        .string()
        .describe(
          "The text to replace it with (must be different from old_string)",
        ),
      replace_all: z
        .boolean()
        .optional()
        .default(false)
        .describe("Replace all occurences of old_string (default false)"),
    }),
    execute: async ({
      file_path,
      old_string,
      new_string,
      replace_all = false,
    }: {
      file_path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    }) => {
      try {
        if (executionMode === "local") {
          // Perform search and replace locally using Node.js fs
          const result = await searchReplaceLocalFile(
            file_path,
            old_string,
            new_string,
            replace_all,
          );
          return { result };
        } else {
          // Perform search and replace in sandbox using files.read() and files.write()
          const { sandbox } = await sandboxManager.getSandbox();

          try {
            // Read the file content
            const fileContent = await sandbox.files.read(file_path);

            // Validate that old_string and new_string are different
            if (old_string === new_string) {
              return {
                result:
                  "Invalid: old_string and new_string are exactly the same",
              };
            }

            // Check if old_string exists in the file
            if (!fileContent.includes(old_string)) {
              return {
                result: `String not found in file: "${old_string}"`,
              };
            }

            let updatedContent: string;
            let replacementCount: number;

            if (replace_all) {
              // Replace all occurrences
              const regex = new RegExp(
                old_string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                "g",
              );
              updatedContent = fileContent.replace(regex, new_string);
              replacementCount = (fileContent.match(regex) || []).length;
            } else {
              // Replace only the first occurrence
              const occurrences = fileContent.split(old_string).length - 1;
              if (occurrences > 1) {
                return {
                  result: `String "${old_string}" appears ${occurrences} times in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance.`,
                };
              }
              updatedContent = fileContent.replace(old_string, new_string);
              replacementCount = 1;
            }

            // Write the updated content back to the file
            await sandbox.files.write(file_path, updatedContent);

            const action = replace_all ? "replacements" : "replacement";
            return {
              result: `Successfully made ${replacementCount} ${action} in ${file_path}`,
            };
          } catch (error) {
            return {
              result: `Error editing file: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }
      } catch (error) {
        return {
          result: `Error editing file: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
};
