import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/types";
import { uploadSandboxFileToConvex } from "./utils/sandbox-file-uploader";

export const createGetTerminalFiles = (context: ToolContext) => {
  const { sandboxManager } = context;

  return tool({
    description: `Share files from the terminal sandbox with the user as downloadable attachments.
    
Usage:
- Use this tool when the user requests files or needs to download results from the sandbox
- Provide full file paths (e.g., /home/user/output.txt, /home/user/scan-results.xml)
- Files are automatically uploaded and made available for download
- Use this after generating reports, saving scan results, or creating any files the user needs to access
- Multiple files can be shared in a single call`,
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
