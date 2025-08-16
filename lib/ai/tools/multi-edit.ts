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

Before using this tool:
- Use the Read tool to understand the file's contents and context
- Verify the directory path is correct

To make multiple file edits, provide the following:
- file_path: The absolute path to the file to modify (must be absolute, not relative)
- edits: An array of edit operations to perform, where each edit contains:
  - old_string: The text to replace (must match the file contents exactly, including all whitespace and indentation)
  - new_string: The edited text to replace the old_string
  - replace_all: Replace all occurences of old_string. This parameter is optional and defaults to false.

IMPORTANT:
- All edits are applied in sequence, in the order they are provided
- Each edit operates on the result of the previous edit
- All edits must be valid for the operation to succeed - if any edit fails, none will be applied
- This tool is ideal when you need to make several changes to different parts of the same file

CRITICAL REQUIREMENTS:
- All edits follow the same requirements as the single Edit tool
- The edits are atomic - either all succeed or none are applied
- Plan your edits carefully to avoid conflicts between sequential operations

WARNING:
- The tool will fail if edits.old_string doesn't match the file contents exactly (including whitespace)
- The tool will fail if edits.old_string and edits.new_string are the same
- Since edits are applied in sequence, ensure that earlier edits don't affect the text that later edits are trying to find

When making edits:
- Ensure all edits result in idiomatic, correct code
- Do not leave the code in a broken state
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.

If you want to create a new file, use:
- A new file path, including dir name if needed
- First edit: empty old_string and the new file's contents as new_string
- Subsequent edits: normal edit operations on the created content`,
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

            // Check if file exists and handle file creation
            let currentContent: string;
            let fileExists = true;
            
            try {
              currentContent = await sandbox.files.read(file_path);
            } catch (error) {
              // File doesn't exist - check if this is a file creation case
              fileExists = false;
              const firstEdit = edits[0];
              if (firstEdit.old_string !== "") {
                return {
                  result: `File not found: ${file_path}. For new file creation, the first edit must have an empty old_string and the file contents as new_string.`,
                };
              }
              currentContent = "";
            }
            
            let totalReplacements = 0;
            const editResults: string[] = [];

            // Apply each edit sequentially
            for (let i = 0; i < edits.length; i++) {
              const edit = edits[i];
              const { old_string, new_string, replace_all = false } = edit;

              // Handle file creation case (empty old_string means insert content)
              if (old_string === "") {
                if (i === 0 && !fileExists) {
                  // First edit for new file creation
                  currentContent = new_string;
                  totalReplacements += 1;
                  editResults.push(`Edit ${i + 1}: Created file with content`);
                  continue;
                } else {
                  return {
                    result: `Edit ${i + 1}: Empty old_string is only allowed for the first edit when creating a new file`,
                  };
                }
              }

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
