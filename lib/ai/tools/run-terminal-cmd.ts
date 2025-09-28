import { tool } from "ai";
import { z } from "zod";
import { CommandExitError, FilesystemEventType } from "@e2b/code-interpreter";
import { randomUUID } from "crypto";
import type { ToolContext } from "@/types";
import {
  executeLocalCommand,
  createLocalTerminalHandlers,
} from "./utils/local-terminal";
import { createTerminalHandler } from "@/lib/utils/terminal-executor";
import { TIMEOUT_MESSAGE } from "@/lib/token-utils";
import { uploadSandboxFileToConvex } from "./utils/sandbox-file-uploader";

const MAX_COMMAND_EXECUTION_TIME = 6 * 60 * 1000; // 6 minutes
const STREAM_TIMEOUT_SECONDS = 60;

export const createRunTerminalCmd = (context: ToolContext) => {
  const { sandboxManager, writer, executionMode } = context;

  return tool({
    description: `PROPOSE a command to run on behalf of the user.
If you have this tool, note that you DO have the ability to run commands directly on the USER's system.
Note that the user may have to approve the command before it is executed.
The user may reject it if it is not to their liking, or may modify the command before approving it.  If they do change it, take those changes into account.
In using these tools, adhere to the following guidelines:
1. Based on the contents of the conversation, you will be told if you are in the same shell as a previous step or a different shell.
2. If in a new shell, you should \`cd\` to the appropriate directory and do necessary setup in addition to running the command. By default, the shell will initialize in the project root.
3. If in the same shell, LOOK IN CHAT HISTORY for your current working directory.
4. For ANY commands that would require user interaction, ASSUME THE USER IS NOT AVAILABLE TO INTERACT and PASS THE NON-INTERACTIVE FLAGS (e.g. --yes for npx).
5. If the command would use a pager, append \` | cat\` to the command.
6. For commands that are long running/expected to run indefinitely until interruption, please run them in the background. To run jobs in the background, set \`is_background\` to true rather than changing the details of the command.
7. Dont include any newlines in the command.
8. For complex and long-running scans (e.g., nmap, dirb, gobuster), save results to files using appropriate output flags (e.g., -oN for nmap) if the tool supports it, otherwise use redirect with > operator for future reference and documentation
9. Avoid commands with excessive output; redirect to files when necessary`,
    inputSchema: z.object({
      command: z.string().describe("The terminal command to execute"),
      explanation: z
        .string()
        .describe(
          "One sentence explanation as to why this command needs to be run and how it contributes to the goal.",
        ),
      is_background: z
        .boolean()
        .describe("Whether the command should be run in the background."),
    }),
    execute: async (
      {
        command,
        is_background,
      }: {
        command: string;
        is_background: boolean;
      },
      { toolCallId }: { toolCallId: string },
    ) => {
      try {
        if (executionMode === "local") {
          const { onStdout, onStderr } = createLocalTerminalHandlers(
            writer,
            toolCallId,
          );

          return new Promise(async (resolve) => {
            let resolved = false;

            const handler = createTerminalHandler(
              (output, isStderr) =>
                isStderr ? onStderr(output) : onStdout(output),
              {
                timeoutSeconds: STREAM_TIMEOUT_SECONDS,
                onTimeout: () => {
                  if (!resolved) {
                    resolved = true;
                    const result = handler.getResult();
                    resolve({ result: { ...result, exitCode: null } });
                  }
                },
              },
            );

            try {
              const result = await executeLocalCommand(command, {
                cwd: process.cwd(),
                onStdout: handler.stdout,
                onStderr: handler.stderr,
                background: is_background,
              });

              handler.cleanup();

              if (!resolved) {
                const finalResult = handler.getResult();
                resolve({
                  result: {
                    ...result,
                    stdout: finalResult.stdout,
                    stderr: finalResult.stderr,
                  },
                });
              }
            } catch (error) {
              handler.cleanup();
              if (!resolved) {
                throw error;
              }
            }
          });
        } else {
          const { sandbox } = await sandboxManager.getSandbox();

          const terminalSessionId = `terminal-${randomUUID()}`;
          let outputCounter = 0;

          const createTerminalWriter = (output: string) => {
            writer.write({
              type: "data-terminal",
              id: `${terminalSessionId}-${++outputCounter}`,
              data: { terminal: output, toolCallId },
            });
          };

          const watchDirname = "/home/user";
          const collectedFileUrls: Array<{ path: string; downloadUrl: string }> = [];
          const seenPaths = new Set<string>();

          const flushUploads = async () => {
            const paths = Array.from(seenPaths);
            for (const fullPath of paths) {
              try {
                const saved = await uploadSandboxFileToConvex({
                  sandbox,
                  userId: context.userID,
                  fullPath,
                });
                context.fileAccumulator.add(saved.fileId);
                collectedFileUrls.push({ path: fullPath, downloadUrl: saved.url });
              } catch (e) {
                // ignore individual upload errors to avoid failing the whole run
              }
            }
          };

          const watchHandle = await sandbox.files.watchDir(
            watchDirname,
            async (event) => {
              try {
                if (
                  event.type === FilesystemEventType.WRITE ||
                  event.type === FilesystemEventType.CREATE
                ) {
                  const fullPath = `${watchDirname}/${event.name}`;
                  if (seenPaths.has(fullPath)) {
                    return;
                  }
                  seenPaths.add(fullPath);
                }
              } catch (e) {
                // ignore watcher errors
              }
            },
            { recursive: true },
          );

          const closeWatcher = () => {
            setTimeout(() => {
              try {
                // @ts-expect-error optional close depending on SDK version
                watchHandle?.close?.();
              } catch {}
            }, 500);
          };

          return new Promise((resolve, reject) => {
            let resolved = false;

            const handler = createTerminalHandler(
              (output) => createTerminalWriter(output),
              {
                timeoutSeconds: STREAM_TIMEOUT_SECONDS,
                onTimeout: () => {
                  if (!resolved) {
                    resolved = true;
                    createTerminalWriter(
                      TIMEOUT_MESSAGE(STREAM_TIMEOUT_SECONDS),
                    );
                    handler.cleanup();
                    closeWatcher();
                    // Defer uploads until after execution completes to avoid empty files
                    (async () => {
                      try {
                        await flushUploads();
                      } catch {}
                      const result = handler.getResult();
                      resolve({
                        result: { ...result, exitCode: null },
                        fileUrls: collectedFileUrls,
                      });
                    })();
                  }
                },
              },
            );

            const commonOptions = {
              timeoutMs: MAX_COMMAND_EXECUTION_TIME,
              user: "root" as const,
              cwd: "/home/user",
              onStdout: handler.stdout,
              onStderr: handler.stderr,
            };

            const runPromise = is_background
              ? sandbox.commands.run(command, {
                  ...commonOptions,
                  background: true,
                })
              : sandbox.commands.run(command, commonOptions);

            runPromise
              .then(async (execution) => {
                handler.cleanup();
                closeWatcher();

                // Upload files only after execution completes
                try {
                  await flushUploads();
                } catch {}

                if (!resolved) {
                  resolved = true;
                  const finalResult = handler.getResult();
                  resolve({
                    result: {
                      ...execution,
                      stdout: finalResult.stdout,
                      stderr: finalResult.stderr,
                    },
                    fileUrls: collectedFileUrls,
                  });
                }
              })
              .catch((error) => {
                handler.cleanup();
                closeWatcher();
                // Best-effort upload before rejecting
                (async () => {
                  try {
                    await flushUploads();
                  } catch {}
                  if (!resolved) {
                    resolved = true;
                    reject(error);
                  }
                })();
              });
          });
        }
      } catch (error) {
        return error as CommandExitError;
      }
    },
  });
};
