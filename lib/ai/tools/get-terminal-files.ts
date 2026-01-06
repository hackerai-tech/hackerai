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

        for (let i = 0; i < files.length; i++) {
          const originalPath = files[i];
          const pathsToTry: string[] = [];

          // Build list of paths to try
          if (originalPath.startsWith("/")) {
            // Already absolute, try as-is
            pathsToTry.push(originalPath);
          } else {
            // Relative path: try both /home/user/ and as-is
            pathsToTry.push(`/home/user/${originalPath}`);
            pathsToTry.push(originalPath);
          }

          let fileProcessed = false;
          let lastError: string | null = null;

          for (const filePath of pathsToTry) {
            // Check if this specific file is being written to by a background process
            try {
              const { active, processes } =
                await backgroundProcessTracker.hasActiveProcessesForFiles(
                  sandbox,
                  [filePath],
                );

              if (active) {
                const processDetails = processes
                  .map((p) => `PID ${p.pid}: ${p.command}`)
                  .join(", ");

                blockedFiles.push({
                  path: originalPath,
                  reason: `Background process still running: [${processDetails}]`,
                });
                fileProcessed = true;
                break;
              }
            } catch (bgCheckError) {
              // Continue anyway - don't block on this check
            }

            try {
              const saved = await uploadSandboxFileToConvex({
                sandbox,
                userId: context.userID,
                fullPath: filePath,
                skipTokenValidation: true, // Skip token limits for assistant-generated files
              });

              context.fileAccumulator.add({
                fileId: saved.fileId,
                name: saved.name,
                mediaType: saved.mediaType,
                s3Key: saved.s3Key,
                storageId: saved.storageId,
              });
              providedFiles.push({ path: originalPath });
              fileProcessed = true;
              break; // Success! No need to try other paths
            } catch (e) {
              const errorMsg = e instanceof Error ? e.message : String(e);
              lastError = errorMsg;
              // Continue to try next path
            }
          }

          // If none of the paths worked, add to blocked files
          if (!fileProcessed) {
            blockedFiles.push({
              path: originalPath,
              reason: `File not found or upload failed: ${lastError || "Unknown error"}`,
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
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          result: `Error providing files: ${errorMsg}`,
          files: [],
        };
      }
    },
  });
};
