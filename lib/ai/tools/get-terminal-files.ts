import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/types";
import { uploadSandboxFileToConvex } from "./utils/sandbox-file-uploader";

export const createGetTerminalFiles = (context: ToolContext) => {
  const { sandboxManager } = context;

  return tool({
    description: `Provide terminal files as attachments to the user. Use this when you need to share files created, modified, or accessed during terminal operations.
    
Usage:
- Use this tool after running terminal commands that create output files
- Provide the full paths to files you want to share with the user
- Files will be uploaded and download URLs will be returned
- This tool only works in sandbox execution mode`,
    inputSchema: z.object({
      files: z
        .array(z.string())
        .describe(
          "Array of file paths to provide as attachments to the user. Use full paths like /home/user/output.txt",
        ),
    }),
    execute: async ({ files }: { files: string[] }) => {
      try {
        const { sandbox } = await sandboxManager.getSandbox();
        const fileUrls: Array<{ path: string; downloadUrl: string }> = [];

        for (const filePath of files) {
          try {
            const saved = await uploadSandboxFileToConvex({
              sandbox,
              userId: context.userID,
              fullPath: filePath,
            });

            context.fileAccumulator.add(saved.fileId);
            fileUrls.push({ path: filePath, downloadUrl: saved.url });
          } catch (e) {
            console.error(
              `[provide-terminal-files] Failed to upload: ${filePath}`,
              e,
            );
            // Continue with other files even if one fails
          }
        }

        return {
          result: `Successfully provided ${fileUrls.length} file(s) to the user`,
          fileUrls,
        };
      } catch (error) {
        console.error("[provide-terminal-files] Error:", error);
        return {
          result: `Error providing files: ${error instanceof Error ? error.message : String(error)}`,
          fileUrls: [],
        };
      }
    },
  });
};
