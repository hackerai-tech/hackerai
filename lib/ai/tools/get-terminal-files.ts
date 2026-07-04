import { tool } from "ai";
import type { ToolContext } from "@/types";
import { uploadSandboxFileToConvex } from "./utils/sandbox-file-uploader";
import {
  getSandboxWithFallbackGuard,
  resolveToolErrorMessage,
} from "./utils/sandbox-fallback";
import { getTerminalFilesTool } from "./schemas";

export const createGetTerminalFiles = (context: ToolContext) => {
  const { sandboxManager, backgroundProcessTracker } = context;

  return tool({
    ...getTerminalFilesTool,
    execute: async ({ files }: { files: string[] }) => {
      try {
        const { sandbox } = await getSandboxWithFallbackGuard({
          sandboxManager,
        });

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
              });

              context.fileAccumulator.add({
                fileId: saved.fileId,
                name: saved.name,
                mediaType: saved.mediaType,
                s3Key: saved.s3Key,
                sizeBytes: saved.sizeBytes,
              });

              // Stream file metadata immediately so the client can show the file card
              // while the rest of the response is still streaming
              if (context.assistantMessageId) {
                context.writer.write({
                  type: "data-file-metadata" as const,
                  data: {
                    messageId: context.assistantMessageId,
                    fileDetails: [
                      {
                        fileId: saved.fileId,
                        name: saved.name,
                        mediaType: saved.mediaType,
                        s3Key: saved.s3Key,
                        sizeBytes: saved.sizeBytes,
                      },
                    ],
                  },
                });
              }

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
        if (blockedFiles.length > 0) {
          const blockedDetails = blockedFiles
            .map((f) => `${f.path}: ${f.reason}`)
            .join("; ");
          result =
            providedFiles.length > 0
              ? `Partially provided ${providedFiles.length} of ${files.length} file(s) to the user. ${blockedFiles.length} file(s) could not be retrieved: ${blockedDetails}. Do not tell the user failed files were sent; retry only the failed file paths if the error is transient, otherwise explain the upload problem.`
              : `Failed to provide ${blockedFiles.length} file(s) to the user: ${blockedDetails}. Do not tell the user these files were sent; verify the paths or explain the upload problem before retrying.`;
        } else if (providedFiles.length > 0) {
          result = `Successfully provided ${providedFiles.length} file(s) to the user`;
        }

        return {
          result: result || "No files were retrieved",
          files: providedFiles,
          failedFiles: blockedFiles,
        };
      } catch (error) {
        const errorMsg = resolveToolErrorMessage(error);
        return {
          result: `Failed to provide files to the user: ${errorMsg}. Do not tell the user these files were sent; explain the upload problem before retrying.`,
          files: [],
          failedFiles: files.map((path) => ({
            path,
            reason: errorMsg,
          })),
        };
      }
    },
  });
};
