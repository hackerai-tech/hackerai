import { tool } from "ai";
import type { AnySandbox, SandboxType, ToolContext } from "@/types";
import { phLogger } from "@/lib/posthog/server";
import { logger } from "@/lib/logger";
import {
  uploadSandboxFileToConvex,
  type GeneratedFileUploadPhase,
  type NativeStatFailureReason,
} from "./utils/sandbox-file-uploader";
import {
  getLocalFileRequestFailure,
  isLocalCommandRelayUnsubscribedError,
} from "./utils/local-sandbox-errors";
import {
  getSandboxLogFields,
  isCentrifugoSandbox,
} from "./utils/sandbox-types";
import { waitForForegroundCommands } from "./utils/foreground-commands";
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
    execute: async ({ files }: { files: string[] }, { abortSignal }) => {
      let relayRecoveryAttempted = false;
      let relayRecoverySucceeded = false;
      let streamNotificationFailures = 0;
      let foregroundCommandsWaited = 0;
      const observedSandboxTypes = new Set<
        "cloud" | "desktop" | "remote-connection"
      >();
      const observeSandboxType = (sandbox: AnySandbox) => {
        try {
          const type = getSandboxLogFields(sandbox).sandbox_type;
          switch (type) {
            case "cloud":
            case "desktop":
            case "remote-connection":
              observedSandboxTypes.add(type);
          }
        } catch {
          // Optional identity observation must not fail a delivery.
        }
      };
      type FailurePhase =
        | GeneratedFileUploadPhase
        | "sandbox_setup"
        | "background_process"
        | "relay_recovery"
        | "finalization"
        | "unknown";
      let currentPhase: FailurePhase = "sandbox_setup";
      let setupStage:
        | "initial_acquisition"
        | "foreground_wait"
        | "reacquisition"
        | "path_preparation"
        | null = "initial_acquisition";
      let completedDeliveryCount = 0;
      const failurePhaseCounts: Partial<Record<FailurePhase, number>> = {};
      type MetadataFailureReason =
        `native_${NativeStatFailureReason}` | "unclassified";
      let currentMetadataFailureReason: MetadataFailureReason = "unclassified";
      const nativeMetadataFailureCounts: Partial<
        Record<Exclude<MetadataFailureReason, "unclassified">, number>
      > = {};
      const observeNativeStatFailure = (reason: NativeStatFailureReason) => {
        // Keep even malformed adapter/test values out of analytics.
        switch (reason) {
          case "stat_failed":
          case "file_missing":
          case "not_regular_file":
          case "invalid_file_size":
            currentMetadataFailureReason = `native_${reason}`;
            break;
          default:
            currentMetadataFailureReason = "unclassified";
        }
      };
      const countFailure = (phase: FailurePhase, count = 1) => {
        if (count > 0) {
          failurePhaseCounts[phase] = (failurePhaseCounts[phase] ?? 0) + count;
        }
      };
      const countMetadataFailure = (
        phase: FailurePhase,
        reason: MetadataFailureReason,
      ) => {
        if (phase === "file_metadata" && reason !== "unclassified") {
          nativeMetadataFailureCounts[reason] =
            (nativeMetadataFailureCounts[reason] ?? 0) + 1;
        }
      };
      const recordOutcome = (delivered: number, failed: number) => {
        try {
          const knownMetadataFailures = Object.values(
            nativeMetadataFailureCounts,
          ).reduce((total, count) => total + count, 0);
          const unclassifiedMetadataFailures =
            (failurePhaseCounts.file_metadata ?? 0) - knownMetadataFailures;
          phLogger.event("agent_file_delivery_completed", {
            userId: context.userID,
            chat_id: context.chatId,
            trigger_run_id: context.triggerRunId ?? null,
            foreground_commands_waited: foregroundCommandsWaited,
            stream_notification_failed_count: streamNotificationFailures,
            requested_file_count: files.length,
            delivered_file_count: delivered,
            failed_file_count: failed,
            file_delivery_diagnostic_version: 1,
            failure_phase_counts: failurePhaseCounts,
            metadata_failure_diagnostic_version: 1,
            metadata_failure_reason_counts: {
              ...nativeMetadataFailureCounts,
              ...(unclassifiedMetadataFailures > 0 && {
                unclassified: unclassifiedMetadataFailures,
              }),
            },
            relay_recovery_attempted: relayRecoveryAttempted,
            relay_recovery_succeeded: relayRecoverySucceeded,
            sandbox_type: sandboxManager.getSandboxInfo()?.type ?? "unknown",
            // Manager state can change while an earlier adapter is still used.
            // These are acquired candidates, not per-file execution attribution.
            observed_sandbox_type_version: 1,
            observed_sandbox_types: [...observedSandboxTypes],
          });
        } catch {
          // Analytics cannot turn a stored artifact into a failed delivery.
        }
      };
      try {
        abortSignal?.throwIfAborted();
        let { sandbox } = await getSandboxWithFallbackGuard({
          sandboxManager,
        });
        observeSandboxType(sandbox);

        // SDK tool calls in one model step execute concurrently. A file may
        // still be being created by another foreground call in this context.
        // Acquire first so immediately scheduled sibling calls can register.
        setupStage = "foreground_wait";
        foregroundCommandsWaited = await waitForForegroundCommands(
          context,
          abortSignal,
        );
        // A pending command can recover/reconnect the selected sandbox.
        if (foregroundCommandsWaited > 0) {
          setupStage = "reacquisition";
          ({ sandbox } = await getSandboxWithFallbackGuard({ sandboxManager }));
          observeSandboxType(sandbox);
        }
        setupStage = null;
        currentPhase = "unknown";

        const uploadWithRelayRecovery = async (filePath: string) => {
          currentMetadataFailureReason = "unclassified";
          try {
            return await uploadSandboxFileToConvex({
              sandbox,
              userId: context.userID,
              fullPath: filePath,
              storageRegion: context.triggerRegion,
              onPhase: (phase) => {
                currentPhase = phase;
              },
              onNativeStatFailure: observeNativeStatFailure,
            });
          } catch (error) {
            const nativeMetadataRelayRejected =
              currentPhase === "file_metadata" &&
              getLocalFileRequestFailure(error) === "relay_unsubscribed";
            if (
              abortSignal?.aborted ||
              relayRecoveryAttempted ||
              !isCentrifugoSandbox(sandbox) ||
              (!isLocalCommandRelayUnsubscribedError(error) &&
                !nativeMetadataRelayRejected) ||
              !sandboxManager.recoverLocalConnection
            ) {
              throw error;
            }

            // One recovery budget covers every file and candidate path in
            // this call, including a failed reconnect.
            relayRecoveryAttempted = true;
            currentPhase = "relay_recovery";
            await sandboxManager.recoverLocalConnection(
              sandbox.getConnectionId(),
              "command_relay_unsubscribed",
            );
            abortSignal?.throwIfAborted();
            const { sandbox: recoveredSandbox } =
              await getSandboxWithFallbackGuard({ sandboxManager });
            observeSandboxType(recoveredSandbox);
            if (!isCentrifugoSandbox(recoveredSandbox)) {
              throw new Error(
                "The selected local sandbox changed during file recovery. Reconnect it and try again.",
              );
            }
            abortSignal?.throwIfAborted();
            sandbox = recoveredSandbox;
            relayRecoverySucceeded = true;
            // Relay presence rejected the first command before publication.
            // The manager only selects a live successor on the same machine.
            currentMetadataFailureReason = "unclassified";
            return uploadSandboxFileToConvex({
              sandbox,
              userId: context.userID,
              fullPath: filePath,
              storageRegion: context.triggerRegion,
              onPhase: (phase) => {
                currentPhase = phase;
              },
              onNativeStatFailure: observeNativeStatFailure,
            });
          }
        };

        const providedFiles: Array<{ path: string }> = [];
        const deliveryReceipts: Array<{
          fileId: string;
          sourcePath: string;
          name: string;
          sizeBytes: number;
          sourceEnvironment: SandboxType | "unknown";
          storageStatus: "stored";
          validation: "not_performed_by_delivery_tool";
        }> = [];
        const blockedFiles: Array<{ path: string; reason: string }> = [];

        for (let i = 0; i < files.length; i++) {
          if (abortSignal?.aborted) {
            const remainingFiles = files.slice(i);
            countFailure("unknown", remainingFiles.length);
            blockedFiles.push(
              ...remainingFiles.map((path) => ({
                path,
                reason: "File delivery canceled before this file was retrieved",
              })),
            );
            break;
          }
          currentPhase = "sandbox_setup";
          setupStage = "path_preparation";
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
            // Only Cloud has the conventional /home/user fallback. A connected
            // computer resolves relative paths using its own execution context.
            if (sandboxManager.getSandboxInfo()?.type === "cloud") {
              pathsToTry.push(`/home/user/${originalPath}`);
            }
            pathsToTry.push(originalPath);
          }

          setupStage = null;
          let fileProcessed = false;
          let lastError: string | null = null;
          let lastFailurePhase: FailurePhase = "unknown";
          let lastMetadataFailureReason: MetadataFailureReason = "unclassified";

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
                countFailure("background_process");
                fileProcessed = true;
                break;
              }
            } catch (bgCheckError) {
              // Continue anyway - don't block on this check
            }

            try {
              abortSignal?.throwIfAborted();
              currentPhase = "unknown";
              const saved = await uploadWithRelayRecovery(filePath);
              currentPhase = "finalization";

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
                try {
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
                } catch {
                  // The verified file is already in the accumulator. Final message
                  // persistence owns it even when the live stream has disconnected.
                  // Do not retry an upload or select another path for a UI failure.
                  streamNotificationFailures += 1;
                }
              }

              providedFiles.push({ path: originalPath });
              deliveryReceipts.push({
                fileId: saved.fileId,
                sourcePath: filePath,
                name: saved.name,
                sizeBytes: saved.sizeBytes,
                sourceEnvironment:
                  sandboxManager.getSandboxInfo()?.type ?? "unknown",
                storageStatus: "stored",
                validation: "not_performed_by_delivery_tool",
              });
              completedDeliveryCount += 1;
              fileProcessed = true;
              break; // Success! No need to try other paths
            } catch (e) {
              const errorMsg = e instanceof Error ? e.message : String(e);
              lastError = errorMsg;
              lastFailurePhase = abortSignal?.aborted
                ? "unknown"
                : currentPhase;
              lastMetadataFailureReason = currentMetadataFailureReason;
              if (abortSignal?.aborted) break;
              // Continue to try next path
            }
          }

          // If none of the paths worked, add to blocked files
          if (!fileProcessed) {
            // Count the terminal outcome once per requested file, after all
            // candidate paths/recovery. Successful alternate paths add no failure.
            countFailure(lastFailurePhase);
            countMetadataFailure(lastFailurePhase, lastMetadataFailureReason);
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
          deliveryReceipts,
          failedFiles: blockedFiles,
        };
      } catch (error) {
        if (setupStage !== null) {
          try {
            // Record the interrupted step, not a guessed cause. Errors and file
            // paths can contain private content; cancellation is presence only.
            logger.warn("agent_file_delivery_setup_failed", {
              setup_stage: setupStage,
              abort_signal_aborted: abortSignal?.aborted ?? false,
              chat_id: context.chatId.slice(0, 128),
              trigger_run_id: context.triggerRunId?.slice(0, 128) ?? null,
              requested_file_count: files.length,
            });
          } catch {
            // Diagnostics must preserve the original failed-batch result.
          }
        }
        const errorMsg = resolveToolErrorMessage(error);
        // The existing outer error returns the whole batch as failed. Retain
        // observed failures; stored files whose results were discarded have no
        // known upload failure phase. Only the remaining files inherit this phase.
        const countedFailures = Object.values(failurePhaseCounts).reduce(
          (total, count) => total + count,
          0,
        );
        countFailure("unknown", completedDeliveryCount);
        countFailure(
          currentPhase,
          files.length - countedFailures - completedDeliveryCount,
        );
        recordOutcome(0, files.length);
        return {
          result: `Failed to provide files to the user: ${errorMsg}. Do not tell the user these files were sent; explain the upload problem before retrying.`,
          files: [],
          deliveryReceipts: [],
          failedFiles: files.map((path) => ({
            path,
            reason: errorMsg,
          })),
        };
      }
    },
  });
};
