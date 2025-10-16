import { tool } from "ai";
import { z } from "zod";
import { randomUUID } from "crypto";
import { FilesystemEventType } from "@e2b/code-interpreter";
import type { ToolContext } from "@/types";
import { uploadSandboxFileToConvex } from "./utils/sandbox-file-uploader";
import { createTerminalHandler } from "@/lib/utils/terminal-executor";
import { STREAM_MAX_TOKENS } from "@/lib/token-utils";

const MAX_EXECUTION_TIME_MS = 60 * 1000; // 60 seconds for code execution

const OUTPUT_DIR = "/mnt/data";

export const createPythonTool = (context: ToolContext) =>
  tool({
    description: `When you send a message containing Python code to python, it will be executed in \
a stateful Jupyter notebook environment. python will respond with the output of the execution or \
time out after 60.0 seconds. The drive at '/mnt/data' can be used to save and persist user files. \
Internet access for this session is enabled.
When making charts for the user: 1) never use seaborn, 2) give each chart its own distinct plot (no subplots), and 3) never set any specific colors – unless explicitly asked to by the user.
I REPEAT: when making charts for the user: 1) use matplotlib over seaborn, 2) give each chart its own distinct plot (no subplots), and 3) never, ever, specify colors or matplotlib styles – unless explicitly asked to by the user`,
    inputSchema: z.object({
      code: z.string().describe("Python code to execute in the sandbox"),
    }),
    execute: async (
      { code }: { code: string },
      { toolCallId, abortSignal },
    ) => {
      // Get sandbox with version enforcement for Python execution
      const { sandbox } = await context.sandboxManager.getSandbox(true);

      const terminalSessionId = `python-${randomUUID()}`;
      let outputCounter = 0;

      const writeToTerminal = (output: string) => {
        context.writer.write({
          type: "data-python",
          id: `${terminalSessionId}-${++outputCounter}`,
          data: { terminal: output, toolCallId },
        });
      };

      // Ensure output directory exists
      try {
        await sandbox.files.makeDir(OUTPUT_DIR);
      } catch (e) {
        // Directory might already exist, that's fine
      }

      return new Promise((resolve) => {
        let resolved = false;
        const results: Array<unknown> = [];
        const files: Array<{ path: string }> = [];
        const createdFiles = new Set<string>();
        let watcher: Awaited<ReturnType<typeof sandbox.files.watchDir>> | null =
          null;

        // Use terminal handler for streaming truncation
        const handler = createTerminalHandler(writeToTerminal, {
          maxTokens: STREAM_MAX_TOKENS,
        });

        const onAbort = async () => {
          if (resolved) return;
          resolved = true;

          handler.cleanup();

          // Clean up watcher on abort
          if (watcher) {
            try {
              await watcher.stop();
            } catch (e) {
              console.error(
                "[Python Tool] Error stopping watcher on abort:",
                e,
              );
            }
          }

          const result = handler.getResult();
          resolve({
            result: {
              ...result,
              results,
              exitCode: null,
              error: "Command execution aborted by user",
            },
            files,
          });
        };

        const executeCode = async () => {
          try {
            // Create a code context with working directory set to /mnt/data
            const codeContext = await sandbox.createCodeContext({
              cwd: OUTPUT_DIR,
            });

            // Start watching directory for file changes (recursive to catch subdirectories)
            watcher = await sandbox.files.watchDir(
              OUTPUT_DIR,
              (event) => {
                if (
                  event.type === FilesystemEventType.CREATE ||
                  event.type === FilesystemEventType.WRITE
                ) {
                  createdFiles.add(event.name);
                }
              },
              { recursive: true },
            );

            await sandbox.runCode(code, {
              context: codeContext,
              timeoutMs: MAX_EXECUTION_TIME_MS,
              onError: (error: unknown) => {
                const errorMsg =
                  typeof error === "string"
                    ? error
                    : String((error as any)?.message ?? error);
                handler.stderr(errorMsg);
              },
              onStdout: (data: any) => {
                // E2B provides { line, error, timestamp } or string; normalize
                const line =
                  typeof data === "string" ? data : String(data?.line ?? "");
                handler.stdout(line);
              },
              onStderr: (data: any) => {
                const line =
                  typeof data === "string" ? data : String(data?.line ?? "");
                handler.stderr(line);
              },
              onResult: async (result: unknown) => {
                // Collect results but strip out binary data (handled separately via file watcher)
                if (result && typeof result === "object") {
                  const resultCopy: any = { ...result };
                  // Remove binary data fields - files are uploaded separately via file watcher
                  delete resultCopy.raw;
                  delete resultCopy.png;
                  delete resultCopy.jpeg;
                  delete resultCopy.pdf;
                  delete resultCopy.svg;
                  results.push(resultCopy);
                } else {
                  results.push(result);
                }
              },
            });

            if (resolved) return;
            resolved = true;

            // Wait for file events to be delivered (E2B events are async)
            await new Promise((resolve) => setTimeout(resolve, 500));

            // Stop watching the directory
            if (watcher) {
              try {
                await watcher.stop();
              } catch (e) {
                console.error("[Python Tool] Error stopping watcher:", e);
              }
            }

            // Upload files that were created or modified during execution
            // createdFiles is already a Set, so duplicates are automatically removed
            try {
              for (const fileName of createdFiles) {
                const filePath = `${OUTPUT_DIR}/${fileName}`;

                try {
                  const saved = await uploadSandboxFileToConvex({
                    sandbox,
                    userId: context.userID,
                    fullPath: filePath,
                    skipTokenValidation: true, // Skip token limits for assistant-generated files
                  });

                  context.fileAccumulator.add(saved.fileId);
                  files.push({
                    path: fileName,
                  });
                } catch (e) {
                  console.error(
                    `[Python Tool] Failed to upload ${fileName}:`,
                    e,
                  );
                  const errorLine = `[Failed to upload ${fileName}: ${e instanceof Error ? e.message : String(e)}]\n`;
                  handler.stderr(errorLine);
                }
              }
            } catch (e) {
              console.error(`[Python Tool] Error uploading files:`, e);
              const errorLine = `[Error uploading files: ${e instanceof Error ? e.message : String(e)}]\n`;
              handler.stderr(errorLine);
            }

            handler.cleanup();
            const result = handler.getResult();
            resolve({
              result: {
                ...result,
                results,
                exitCode: 0,
              },
              files,
            });
          } catch (e: any) {
            if (resolved) return;
            resolved = true;

            handler.cleanup();

            // Stop watching the directory on error
            if (watcher) {
              try {
                await watcher.stop();
              } catch (stopError) {
                console.error(
                  "[Python Tool] Error stopping watcher on error:",
                  stopError,
                );
              }
            }

            const result = handler.getResult();
            resolve({
              result: {
                ...result,
                results,
                exitCode: null,
                error: String(e?.message ?? e),
              },
              files,
            });
          } finally {
            abortSignal?.removeEventListener("abort", onAbort);
          }
        };

        if (abortSignal?.aborted) {
          onAbort();
          return;
        }

        abortSignal?.addEventListener("abort", onAbort, { once: true });
        executeCode();
      });
    },
  });
