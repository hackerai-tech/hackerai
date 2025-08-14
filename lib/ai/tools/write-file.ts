import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./types";
import { writeLocalFile } from "./utils/local-file-operations";

export const createWriteFile = (context: ToolContext) => {
  const { sandboxManager, executionMode } = context;

  return tool({
    description: `Writes a file to the filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the read_file tool first to read the file's contents.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.`,
    inputSchema: z.object({
      file_path: z
        .string()
        .describe(
          "The path to the file to modify. Always specify the target file as the first argument. You can use either a relative path in the workspace or an absolute path.",
        ),
      contents: z.string().describe("The contents of the file to write"),
    }),
    execute: async ({
      file_path,
      contents,
    }: {
      file_path: string;
      contents: string;
    }) => {
      try {
        if (executionMode === "local") {
          // Write file locally using Node.js fs
          const result = await writeLocalFile(file_path, contents);
          return { result };
        } else {
          // Write file to sandbox (existing behavior)
          const { sandbox } = await sandboxManager.getSandbox();

          await sandbox.files.write(file_path, contents);

          return {
            result: `Successfully wrote ${contents.split("\n").length} lines to ${file_path}`,
          };
        }
      } catch (error) {
        return {
          result: `Error writing file: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
};
