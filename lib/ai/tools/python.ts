// import { tool } from "ai";
// import { z } from "zod";
// import { randomUUID } from "crypto";
// import { FilesystemEventType } from "@e2b/code-interpreter";
// import type { ToolContext } from "@/types";
// import {
//   uploadSandboxFileToConvex,
//   uploadBase64ToConvex,
// } from "./utils/sandbox-file-uploader";
// import { createTerminalHandler } from "@/lib/utils/terminal-executor";
// import { STREAM_MAX_TOKENS } from "@/lib/token-utils";

// const MAX_EXECUTION_TIME_MS = 60 * 1000; // 60 seconds for code execution

// const OUTPUT_DIR = "/mnt/data";

// export const createPythonTool = (context: ToolContext) => {
//   const modeGuidance =
//     context.mode !== "agent"
//       ? `\n\nNever run shell commands or network scans (e.g., nmap) in Python. Tell the user to switch to Agent mode in the chat bar for terminal tasks. Use Python for data analysis, file creation, and basic logic.`
//       : "";

//   return tool({
//     description: `When you send a message containing Python code to python, it will be executed in \
// a stateful Jupyter notebook environment. python will respond with the output of the execution or \
// time out after 60.0 seconds. The drive at '/mnt/data' should be used to save and persist user files. \
// Internet access for this session is enabled.${modeGuidance}

// NEVER use python tool if user ask to generate code or write code for them, use only when user ask to run code.

// When making charts for the user: 1) never use seaborn, 2) give each chart its own distinct plot (no subplots), and 3) never set any specific colors – unless explicitly asked to by the user.
// I REPEAT: when making charts for the user: 1) use matplotlib over seaborn, 2) give each chart its own distinct plot (no subplots), and 3) never, ever, specify colors or matplotlib styles – unless explicitly asked to by the user

// If you are generating files:
// - You MUST use the instructed library for each supported file format. (Do not assume any other libraries are available):
//     - pdf --> reportlab
//     - docx --> python-docx
//     - xlsx --> openpyxl
//     - pptx --> python-pptx
//     - csv --> pandas
//     - rtf --> pypandoc
//     - txt --> pypandoc
//     - md --> pypandoc
//     - ods --> odfpy
//     - odt --> odfpy
//     - odp --> odfpy
// - If you are generating a pdf:
//     - You MUST prioritize generating text content using reportlab.platypus rather than canvas
//     - If you are generating text in korean, chinese, OR japanese, you MUST use the following built-in UnicodeCIDFont. To use these fonts, you must call pdfmetrics.registerFont(UnicodeCIDFont(font_name)) and apply the style to all text elements:
//         - japanese --> HeiseiMin-W3 or HeiseiKakuGo-W5
//         - simplified chinese --> STSong-Light
//         - traditional chinese --> MSung-Light
//         - korean --> HYSMyeongJo-Medium
// - If you are to use pypandoc, you are only allowed to call the method pypandoc.convert_text and you MUST include the parameter extra_args=['--standalone']. Otherwise the file will be corrupt/incomplete
//     - For example: pypandoc.convert_text(text, 'rtf', format='md', outputfile='output.rtf', extra_args=['--standalone'])`,
//     inputSchema: z.object({
//       code: z.string().describe("Python code to execute in the sandbox"),
//     }),
//     execute: async (
//       { code }: { code: string },
//       { toolCallId, abortSignal },
//     ) => {
//       // Get sandbox for Python execution
//       const { sandbox } = await context.sandboxManager.getSandbox();

//       const terminalSessionId = `python-${randomUUID()}`;
//       let outputCounter = 0;

//       const writeToTerminal = (output: string) => {
//         context.writer.write({
//           type: "data-python",
//           id: `${terminalSessionId}-${++outputCounter}`,
//           data: { terminal: output, toolCallId },
//         });
//       };

//       // Ensure output directory exists
//       try {
//         await sandbox.files.makeDir(OUTPUT_DIR);
//       } catch (e) {
//         // Directory might already exist, that's fine
//       }

//       return new Promise((resolve) => {
//         let resolved = false;
//         const results: Array<unknown> = [];
//         const createdFiles = new Set<string>();
//         let watcher: Awaited<ReturnType<typeof sandbox.files.watchDir>> | null =
//           null;

//         // Use terminal handler for streaming truncation
//         const handler = createTerminalHandler(writeToTerminal, {
//           maxTokens: STREAM_MAX_TOKENS,
//         });

//         const onAbort = async () => {
//           if (resolved) return;
//           resolved = true;

//           handler.cleanup();

//           // Clean up watcher on abort
//           if (watcher) {
//             try {
//               await watcher.stop();
//             } catch (e) {
//               console.error(
//                 "[Python Tool] Error stopping watcher on abort:",
//                 e,
//               );
//             }
//           }

//           const result = handler.getResult();

//           resolve({
//             result: {
//               output: result.output || "",
//               results,
//               exitCode: null,
//               error: "Command execution aborted by user",
//             },
//           });
//         };

//         const executeCode = async () => {
//           try {
//             // Create a code context with working directory set to /mnt/data
//             const codeContext = await sandbox.createCodeContext({
//               cwd: OUTPUT_DIR,
//             });

//             // Start watching directory for file changes (recursive to catch subdirectories)
//             watcher = await sandbox.files.watchDir(
//               OUTPUT_DIR,
//               (event) => {
//                 if (
//                   event.type === FilesystemEventType.CREATE ||
//                   event.type === FilesystemEventType.WRITE
//                 ) {
//                   // Normalize path: remove OUTPUT_DIR prefix and leading slashes
//                   const normalizedName = event.name
//                     .replace(OUTPUT_DIR, "")
//                     .replace(/^\/+/, "");

//                   if (normalizedName) {
//                     createdFiles.add(normalizedName);
//                   }
//                 }
//               },
//               { recursive: true },
//             );

//             await sandbox.runCode(code, {
//               context: codeContext,
//               timeoutMs: MAX_EXECUTION_TIME_MS,
//               onError: (error: unknown) => {
//                 let errorMsg: string;
//                 if (typeof error === "string") {
//                   errorMsg = error;
//                 } else if (error && typeof error === "object") {
//                   const errObj = error as any;
//                   if (errObj.message) {
//                     errorMsg = errObj.message;
//                   } else {
//                     try {
//                       errorMsg = JSON.stringify(error, null, 2);
//                     } catch {
//                       errorMsg = String(error);
//                     }
//                   }
//                 } else {
//                   errorMsg = String(error);
//                 }
//                 handler.stderr(errorMsg);
//               },
//               onStdout: (data: any) => {
//                 // E2B provides { line, error, timestamp } or string; normalize
//                 let line: string;
//                 if (typeof data === "string") {
//                   line = data;
//                 } else if (data && typeof data === "object" && "line" in data) {
//                   line = String(data.line);
//                 } else if (data && typeof data === "object") {
//                   try {
//                     line = JSON.stringify(data);
//                   } catch {
//                     line = String(data);
//                   }
//                 } else {
//                   line = String(data ?? "");
//                 }
//                 handler.stdout(line);
//               },
//               onStderr: (data: any) => {
//                 let line: string;
//                 if (typeof data === "string") {
//                   line = data;
//                 } else if (data && typeof data === "object" && "line" in data) {
//                   line = String(data.line);
//                 } else if (data && typeof data === "object") {
//                   try {
//                     line = JSON.stringify(data);
//                   } catch {
//                     line = String(data);
//                   }
//                 } else {
//                   line = String(data ?? "");
//                 }
//                 handler.stderr(line);
//               },
//               onResult: async (result: unknown) => {
//                 if (result && typeof result === "object") {
//                   const resultObj: any = result;

//                   // Check if Python code already saved files explicitly
//                   const hasExplicitFiles = createdFiles.size > 0;

//                   // Define supported formats with their metadata
//                   const formats: Array<{
//                     key: string;
//                     extension: string;
//                     mediaType: string;
//                     isBinary: boolean;
//                   }> = [
//                     // Binary formats (base64-encoded)
//                     {
//                       key: "png",
//                       extension: "png",
//                       mediaType: "image/png",
//                       isBinary: true,
//                     },
//                     {
//                       key: "jpeg",
//                       extension: "jpeg",
//                       mediaType: "image/jpeg",
//                       isBinary: true,
//                     },
//                     {
//                       key: "pdf",
//                       extension: "pdf",
//                       mediaType: "application/pdf",
//                       isBinary: true,
//                     },

//                     // Text/SVG formats
//                     {
//                       key: "svg",
//                       extension: "svg",
//                       mediaType: "image/svg+xml",
//                       isBinary: false,
//                     },
//                     {
//                       key: "html",
//                       extension: "html",
//                       mediaType: "text/html",
//                       isBinary: false,
//                     },
//                     {
//                       key: "markdown",
//                       extension: "md",
//                       mediaType: "text/markdown",
//                       isBinary: false,
//                     },
//                     {
//                       key: "latex",
//                       extension: "tex",
//                       mediaType: "text/x-latex",
//                       isBinary: false,
//                     },
//                     {
//                       key: "json",
//                       extension: "json",
//                       mediaType: "application/json",
//                       isBinary: false,
//                     },
//                     {
//                       key: "javascript",
//                       extension: "js",
//                       mediaType: "text/javascript",
//                       isBinary: false,
//                     },
//                   ];

//                   let uploadedFromResult = false;

//                   // Only save data from results if no explicit files were saved
//                   if (!hasExplicitFiles) {
//                     for (const {
//                       key,
//                       extension,
//                       mediaType,
//                       isBinary,
//                     } of formats) {
//                       if (resultObj[key] && resultObj[key] !== undefined) {
//                         try {
//                           const data = resultObj[key];
//                           const timestamp = Date.now();
//                           const fileName = `output_${timestamp}.${extension}`;

//                           if (isBinary) {
//                             const saved = await uploadBase64ToConvex({
//                               base64Data: data,
//                               userId: context.userID,
//                               fileName,
//                               mediaType,
//                               skipTokenValidation: true,
//                             });

//                             context.fileAccumulator.add(saved.fileId);
//                             uploadedFromResult = true;
//                           } else {
//                             const base64Data = Buffer.from(
//                               data,
//                               "utf-8",
//                             ).toString("base64");
//                             const saved = await uploadBase64ToConvex({
//                               base64Data,
//                               userId: context.userID,
//                               fileName,
//                               mediaType,
//                               skipTokenValidation: true,
//                             });

//                             context.fileAccumulator.add(saved.fileId);
//                             uploadedFromResult = true;
//                           }
//                         } catch (e) {
//                           console.error(
//                             `[Python Tool] Failed to upload ${key} data:`,
//                             e,
//                           );
//                           const errorLine = `[Failed to upload ${key}: ${e instanceof Error ? e.message : String(e)}]\n`;
//                           handler.stderr(errorLine);
//                         }
//                       }
//                     }
//                   }

//                   // Only store result metadata if we didn't upload files from it
//                   // (chart metadata is redundant if we already uploaded the image)
//                   if (!uploadedFromResult) {
//                     const resultCopy: any = { ...resultObj };
//                     delete resultCopy.raw;
//                     delete resultCopy.png;
//                     delete resultCopy.jpeg;
//                     delete resultCopy.pdf;
//                     delete resultCopy.svg;
//                     delete resultCopy.html;
//                     delete resultCopy.markdown;
//                     delete resultCopy.latex;
//                     delete resultCopy.json;
//                     delete resultCopy.javascript;

//                     if (Object.keys(resultCopy).length > 0) {
//                       results.push(resultCopy);
//                     }
//                   }
//                 } else {
//                   results.push(result);
//                 }
//               },
//             });

//             if (resolved) return;
//             resolved = true;

//             // Wait for file events to be delivered (E2B events are async)
//             await new Promise((resolve) => setTimeout(resolve, 500));

//             // Stop watching the directory
//             if (watcher) {
//               try {
//                 await watcher.stop();
//               } catch (e) {
//                 console.error("[Python Tool] Error stopping watcher:", e);
//               }
//             }

//             // Upload files that were created or modified during execution
//             try {
//               for (const fileName of createdFiles) {
//                 const filePath = `${OUTPUT_DIR}/${fileName}`;

//                 try {
//                   const saved = await uploadSandboxFileToConvex({
//                     sandbox,
//                     userId: context.userID,
//                     fullPath: filePath,
//                     skipTokenValidation: true, // Skip token limits for assistant-generated files
//                   });

//                   context.fileAccumulator.add(saved.fileId);
//                 } catch (e) {
//                   console.error(
//                     `[Python Tool] Failed to upload ${fileName}:`,
//                     e,
//                   );
//                   const errorLine = `[Failed to upload ${fileName}: ${e instanceof Error ? e.message : String(e)}]\n`;
//                   handler.stderr(errorLine);
//                 }
//               }
//             } catch (e) {
//               console.error(`[Python Tool] Error uploading files:`, e);
//               const errorLine = `[Error uploading files: ${e instanceof Error ? e.message : String(e)}]\n`;
//               handler.stderr(errorLine);
//             }

//             handler.cleanup();
//             const result = handler.getResult();

//             resolve({
//               result: {
//                 output: result.output || "",
//                 results,
//                 exitCode: 0,
//               },
//             });
//           } catch (e: any) {
//             if (resolved) return;
//             resolved = true;

//             handler.cleanup();

//             // Stop watching the directory on error
//             if (watcher) {
//               try {
//                 await watcher.stop();
//               } catch (stopError) {
//                 console.error(
//                   "[Python Tool] Error stopping watcher on error:",
//                   stopError,
//                 );
//               }
//             }

//             let errorMsg: string;
//             if (e && typeof e === "object") {
//               if (e.message) {
//                 errorMsg = e.message;
//               } else {
//                 try {
//                   errorMsg = JSON.stringify(e, null, 2);
//                 } catch {
//                   errorMsg = String(e);
//                 }
//               }
//             } else {
//               errorMsg = String(e);
//             }

//             const result = handler.getResult();

//             resolve({
//               result: {
//                 output: result.output || "",
//                 results,
//                 exitCode: null,
//                 error: errorMsg,
//               },
//             });
//           } finally {
//             abortSignal?.removeEventListener("abort", onAbort);
//           }
//         };

//         if (abortSignal?.aborted) {
//           onAbort();
//           return;
//         }

//         abortSignal?.addEventListener("abort", onAbort, { once: true });
//         executeCode();
//       });
//     },
//   });
// };
