import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/types";
import { uploadSandboxFileToConvex } from "./utils/sandbox-file-uploader";

export const createGetTerminalFiles = (context: ToolContext) => {
  const { sandboxManager, backgroundProcessTracker } = context;

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

        const providedFiles: Array<{ path: string }> = [];
        const blockedFiles: Array<{ path: string; reason: string }> = [];

        for (const filePath of files) {
          // Check if this specific file is being written to by a background process
          const { active, processes } =
            await backgroundProcessTracker.hasActiveProcessesForFiles(sandbox, [
              filePath,
            ]);

          if (active) {
            const processDetails = processes
              .map((p) => `PID ${p.pid}: ${p.command}`)
              .join(", ");

            blockedFiles.push({
              path: filePath,
              reason: `Background process still running: [${processDetails}]`,
            });
            continue;
          }

          try {
            const saved = await uploadSandboxFileToConvex({
              sandbox,
              userId: context.userID,
              fullPath: filePath,
              skipTokenValidation: true, // Skip token limits for assistant-generated files
            });

            context.fileAccumulator.add(saved.fileId);
            providedFiles.push({ path: filePath });
          } catch (e) {
            blockedFiles.push({
              path: filePath,
              reason: `File not found or upload failed: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
        }

        let result = "";
        if (providedFiles.length > 0) {
          result += `Successfully provided ${providedFiles.length} file(s) to the user`;
        }
        if (blockedFiles.length > 0) {
          const blockedDetails = blockedFiles
            .map((f) => `${f.path}: ${f.reason}`)
            .join("; ");
          result +=
            (result ? ". " : "") +
            `${blockedFiles.length} file(s) could not be retrieved: ${blockedDetails}`;
        }

        return {
          result: result || "No files were retrieved",
          files: providedFiles,
        };
      } catch (error) {
        return {
          result: `Error providing files: ${error instanceof Error ? error.message : String(error)}`,
          files: [],
        };
      }
    },
  });
};
