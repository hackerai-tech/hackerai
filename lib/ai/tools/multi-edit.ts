import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/types";
import {
  multiEditLocalFile,
  type EditOperation,
} from "./utils/local-file-operations";

export const createMultiEdit = (context: ToolContext) => {
  const { sandboxManager, executionMode } = context;

  return tool({
    description: `This is a tool for making multiple edits to a single file in one operation. It is built on top of the search_replace tool and allows you to perform multiple find-and-replace operations efficiently. Prefer this tool over the search_replace tool when you need to make multiple edits to the same file.

IMPORTANT:
- All edits are applied in sequence, in the order they are provided
- Each edit operates on the result of the previous edit
- All edits must be valid for the operation to succeed - if any edit fails, none will be applied
- This tool is ideal when you need to make several changes to different parts of the same file`,
    inputSchema: z.object({
      file_path: z
        .string()
        .describe(
          "The path to the file to modify. Always specify the target file as the first argument. You can use either a relative path in the workspace or an absolute path.",
        ),
      edits: z
        .array(
          z.object({
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
        )
        .describe(
          "Array of edit operations to perform sequentially on the file",
        ),
    }),
    execute: async ({
      file_path,
      edits,
    }: {
      file_path: string;
      edits: EditOperation[];
    }) => {
      try {
        if (executionMode === "local") {
          // Perform multi-edit locally using Node.js fs
          const result = await multiEditLocalFile(file_path, edits);
          return { result };
        } else {
          // Perform multi-edit in sandbox using files.read() and files.write()
          const { sandbox } = await sandboxManager.getSandbox();

          try {
            // Validate edits array
            if (!edits || edits.length === 0) {
              return {
                result: "No edits provided",
              };
            }

            // Read the file content
            let currentContent = await sandbox.files.read(file_path);
            let totalReplacements = 0;
            const editResults: string[] = [];

            // Apply each edit sequentially
            for (let i = 0; i < edits.length; i++) {
              const edit = edits[i];
              const { old_string, new_string, replace_all = false } = edit;

              // Validate that old_string and new_string are different
              if (old_string === new_string) {
                return {
                  result: `Edit ${i + 1}: Invalid - old_string and new_string are exactly the same`,
                };
              }

              // Check if old_string exists in the current content
              if (!currentContent.includes(old_string)) {
                return {
                  result: `Edit ${i + 1}: String not found in file: "${old_string}"`,
                };
              }

              let replacementCount: number;

              if (replace_all) {
                // Replace all occurrences
                const regex = new RegExp(
                  old_string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                  "g",
                );
                const matches = currentContent.match(regex);
                replacementCount = matches ? matches.length : 0;
                currentContent = currentContent.replace(regex, new_string);
              } else {
                // Replace only the first occurrence
                const occurrences = currentContent.split(old_string).length - 1;
                if (occurrences > 1) {
                  return {
                    result: `Edit ${i + 1}: String "${old_string}" appears ${occurrences} times in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance.`,
                  };
                }
                currentContent = currentContent.replace(old_string, new_string);
                replacementCount = 1;
              }

              totalReplacements += replacementCount;
              const action = replace_all ? "replacements" : "replacement";
              editResults.push(`Edit ${i + 1}: ${replacementCount} ${action}`);
            }

            // Write the updated content back to the file
            await sandbox.files.write(file_path, currentContent);

            return {
              result: `Successfully applied ${edits.length} edits with ${totalReplacements} total replacements in ${file_path}:\n${editResults.join("\n")}`,
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
