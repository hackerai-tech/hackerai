import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/types";
import { deleteLocalFile } from "./utils/local-file-operations";

export const createDeleteFile = (context: ToolContext) => {
  const { sandboxManager, executionMode } = context;

  return tool({
    description: `Deletes a file at the specified path. The operation will fail gracefully if:
    - The file doesn't exist
    - The operation is rejected for security reasons
    - The file cannot be deleted`,
    inputSchema: z.object({
      target_file: z
        .string()
        .describe(
          "The path of the file to delete, relative to the workspace root.",
        ),
      explanation: z
        .string()
        .describe(
          "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
        ),
    }),
    execute: async ({
      target_file,
    }: {
      target_file: string;
      explanation: string;
    }) => {
      try {
        if (executionMode === "local") {
          // Delete file locally using Node.js fs
          const result = await deleteLocalFile(target_file);
          return { result };
        } else {
          // Delete file from sandbox using rm command
          const { sandbox } = await sandboxManager.getSandbox();

          try {
            // Use rm command to delete the file
            const execution = await sandbox.commands.run(
              `rm "${target_file}"`,
              {
                user: "root" as const,
                cwd: "/home/user",
              },
            );

            if (execution.exitCode === 0) {
              return {
                result: `Successfully deleted file: ${target_file}`,
              };
            } else {
              return {
                result: `Failed to delete file: ${target_file}. Error: ${execution.stderr}`,
              };
            }
          } catch (error) {
            return {
              result: `Error deleting file: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }
      } catch (error) {
        return {
          result: `Error deleting file: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
};
