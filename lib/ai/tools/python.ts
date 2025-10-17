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

export const createPythonTool = (context: ToolContext) => {
  const modeGuidance =
    context.mode !== "agent"
      ? `\n\nNever run shell commands or network scans (e.g., nmap) in Python. Tell the user to switch to Agent mode in the chat bar for terminal tasks. Use Python for data analysis, file creation, and basic logic.`
      : "";

  return tool({
    description: `When you send a message containing Python code to python, it will be executed in \
a stateful Jupyter notebook environment. python will respond with the output of the execution or \
time out after 60.0 seconds. The drive at '/mnt/data' should be used to save and persist user files. \
Internet access for this session is enabled.${modeGuidance}

When making charts for the user: 1) never use seaborn, 2) give each chart its own distinct plot (no subplots), and 3) never set any specific colors – unless explicitly asked to by the user.
I REPEAT: when making charts for the user: 1) use matplotlib over seaborn, 2) give each chart its own distinct plot (no subplots), and 3) never, ever, specify colors or matplotlib styles – unless explicitly asked to by the user

If you are generating files:
- You MUST use the instructed library for each supported file format. (Do not assume any other libraries are available):
    - pdf --> reportlab
    - docx --> python-docx
    - xlsx --> openpyxl
    - pptx --> python-pptx
    - csv --> pandas
    - rtf --> pypandoc
    - txt --> pypandoc
    - md --> pypandoc
    - ods --> odfpy
    - odt --> odfpy
    - odp --> odfpy
- If you are generating a pdf:
    - You MUST prioritize generating text content using reportlab.platypus rather than canvas
    - If you are generating text in korean, chinese, OR japanese, you MUST use the following built-in UnicodeCIDFont. To use these fonts, you must call pdfmetrics.registerFont(UnicodeCIDFont(font_name)) and apply the style to all text elements:
        - japanese --> HeiseiMin-W3 or HeiseiKakuGo-W5
        - simplified chinese --> STSong-Light
        - traditional chinese --> MSung-Light
        - korean --> HYSMyeongJo-Medium
- If you are to use pypandoc, you are only allowed to call the method pypandoc.convert_text and you MUST include the parameter extra_args=['--standalone']. Otherwise the file will be corrupt/incomplete
    - For example: pypandoc.convert_text(text, 'rtf', format='md', outputfile='output.rtf', extra_args=['--standalone'])`,
    inputSchema: z.object({
      code: z.string().describe("Python code to execute in the sandbox"),
    }),
    execute: async (
      { code }: { code: string },
      { toolCallId, abortSignal },
    ) => {
      // Get sandbox for Python execution
      const { sandbox } = await context.sandboxManager.getSandbox();

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
                  // Normalize path: remove OUTPUT_DIR prefix and leading slashes
                  const normalizedName = event.name
                    .replace(OUTPUT_DIR, "")
                    .replace(/^\/+/, "");

                  if (normalizedName) {
                    createdFiles.add(normalizedName);
                  }
                }
              },
              { recursive: true },
            );

            await sandbox.runCode(code, {
              context: codeContext,
              timeoutMs: MAX_EXECUTION_TIME_MS,
              onError: (error: unknown) => {
                let errorMsg: string;
                if (typeof error === "string") {
                  errorMsg = error;
                } else if (error && typeof error === "object") {
                  const errObj = error as any;
                  if (errObj.message) {
                    errorMsg = errObj.message;
                  } else {
                    try {
                      errorMsg = JSON.stringify(error, null, 2);
                    } catch {
                      errorMsg = String(error);
                    }
                  }
                } else {
                  errorMsg = String(error);
                }
                handler.stderr(errorMsg);
              },
              onStdout: (data: any) => {
                // E2B provides { line, error, timestamp } or string; normalize
                let line: string;
                if (typeof data === "string") {
                  line = data;
                } else if (data && typeof data === "object" && "line" in data) {
                  line = String(data.line);
                } else if (data && typeof data === "object") {
                  try {
                    line = JSON.stringify(data);
                  } catch {
                    line = String(data);
                  }
                } else {
                  line = String(data ?? "");
                }
                handler.stdout(line);
              },
              onStderr: (data: any) => {
                let line: string;
                if (typeof data === "string") {
                  line = data;
                } else if (data && typeof data === "object" && "line" in data) {
                  line = String(data.line);
                } else if (data && typeof data === "object") {
                  try {
                    line = JSON.stringify(data);
                  } catch {
                    line = String(data);
                  }
                } else {
                  line = String(data ?? "");
                }
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

            let errorMsg: string;
            if (e && typeof e === "object") {
              if (e.message) {
                errorMsg = e.message;
              } else {
                try {
                  errorMsg = JSON.stringify(e, null, 2);
                } catch {
                  errorMsg = String(e);
                }
              }
            } else {
              errorMsg = String(e);
            }

            const result = handler.getResult();
            resolve({
              result: {
                ...result,
                results,
                exitCode: null,
                error: errorMsg,
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
};
