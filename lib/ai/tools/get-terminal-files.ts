import { tool } from "ai";
import type { ToolContext } from "@/types";
import { phLogger } from "@/lib/posthog/server";
import { uploadSandboxFileToConvex } from "./utils/sandbox-file-uploader";
import { isLocalCommandRelayUnsubscribedError } from "./utils/local-sandbox-errors";
import { isCentrifugoSandbox } from "./utils/sandbox-types";
import {
  getSandboxWithFallbackGuard,
  resolveToolErrorMessage,
} from "./utils/sandbox-fallback";
import {
  createGetTerminalFilesToolSchema,
  getTerminalFilesTool,
} from "./schemas";

export const createGetTerminalFiles = (context: ToolContext) => {
  const { sandboxManager, backgroundProcessTracker } = context;

  return tool({
    ...getTerminalFilesTool,
    inputSchema: createGetTerminalFilesToolSchema({
      modelName: context.getCurrentModelName?.() ?? context.modelName,
    }).inputSchema,
    execute: async ({ files }: { files: string[] }) => {
      let relayRecoveryAttempted = false;
      let relayRecoverySucceeded = false;
      const recordOutcome = (delivered: number, failed: number) => {
        phLogger.event("agent_file_delivery_completed", {
          userId: context.userID,
          requested_file_count: files.length,
          delivered_file_count: delivered,
          failed_file_count: failed,
          relay_recovery_attempted: relayRecoveryAttempted,
          relay_recovery_succeeded: relayRecoverySucceeded,
          sandbox_type: sandboxManager.getSandboxInfo()?.type ?? "unknown",
        });
      };
      try {
        let { sandbox } = await getSandboxWithFallbackGuard({
          sandboxManager,
        });

        const uploadWithRelayRecovery = async (filePath: string) => {
          try {
            return await uploadSandboxFileToConvex({
              sandbox,
              userId: context.userID,
              fullPath: filePath,
              storageRegion: context.triggerRegion,
            });
          } catch (error) {
            if (
              !isCentrifugoSandbox(sandbox) ||
              !isLocalCommandRelayUnsubscribedError(error) ||
              !sandboxManager.recoverLocalConnection
            ) {
              throw error;
            }

            relayRecoveryAttempted = true;
            await sandboxManager.recoverLocalConnection(
              sandbox.getConnectionId(),
              "command_relay_unsubscribed",
            );
            const { sandbox: recoveredSandbox } =
              await getSandboxWithFallbackGuard({ sandboxManager });
            if (!isCentrifugoSandbox(recoveredSandbox)) {
              throw new Error(
                "The selected local sandbox changed during file recovery. Reconnect it and try again.",
              );
            }
            sandbox = recoveredSandbox;
            relayRecoverySucceeded = true;
            // Relay presence rejected the first command before publication.
            // The manager only selects a live successor on the same machine.
            return uploadSandboxFileToConvex({
              sandbox,
              userId: context.userID,
              fullPath: filePath,
              storageRegion: context.triggerRegion,
            });
          }
        };

        const providedFiles: Array<{ path: string }> = [];
        const blockedFiles: Array<{ path: string; reason: string }> = [];

        for (let i = 0; i < files.length; i++) {
          const originalPath = files[i];
          const pathsToTry: string[] = [];

          // Build list of paths to try
          if (
            originalPath.startsWith("/") ||
            /^[A-Za-z]:[\\/]/.test(originalPath) ||
            originalPath.startsWith("\\\\")
          ) {
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
              const saved = await uploadWithRelayRecovery(filePath);

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

        recordOutcome(providedFiles.length, blockedFiles.length);
        return {
          result: result || "No files were retrieved",
          files: providedFiles,
          failedFiles: blockedFiles,
        };
      } catch (error) {
        const errorMsg = resolveToolErrorMessage(error);
        recordOutcome(0, files.length);
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
