import { DurableAgent } from "@workflow/ai/agent";
import { getWritable, sleep, FatalError } from "workflow";
import type { UIMessageChunk } from "ai";
import { z } from "zod";
import {
  startSandbox,
  runCommandStep,
  startCommandAsync,
  pollCommandAsync,
  readFileStep,
  writeFileStep,
  killSandbox,
  emitWorkflowError,
  saveAssistantMessageStep,
  clearActiveWorkflowRunStep,
} from "./steps/sandbox-steps";
import { openrouterModel } from "./steps/openrouter-model";

export interface WorkflowAgentInput {
  userId: string;
  chatId: string;
  prompt: string;
  model?: string;
  systemPrompt?: string;
  maxSteps?: number;
  hardWallSeconds?: number;
}

const DEFAULT_SYSTEM = `You are a long-running pentesting agent. You operate inside a Linux sandbox and have these tools:
- run_command: short blocking shell command (<=60s).
- start_command_async: launch long-running command in background, returns a handle.
- wait_command: poll a backgrounded command until it completes (handles minute-to-hour scans).
- read_file (args: target_file, maxBytes?) / write_file (args: file_path, contents): text I/O inside the sandbox.

Rules:
- Use start_command_async + wait_command for any scan that may exceed 60 seconds (nmap -A, sqlmap, ffuf, gobuster, nikto, hydra, etc.).
- Always redirect verbose output to a file inside the sandbox and grep the relevant findings.
- Be deliberate. Plan, run, summarize.`;

export async function agentRunWorkflow(input: WorkflowAgentInput) {
  "use workflow";

  const writable = getWritable<UIMessageChunk>();
  let sandboxId: string | null = null;

  try {
    const sandbox = await startSandbox({
      userId: input.userId,
      chatId: input.chatId,
    });
    sandboxId = sandbox.sandboxId;
    const sid: string = sandbox.sandboxId;

    const modelId = input.model ?? "agent-model";
    const agent = new DurableAgent({
      model: openrouterModel(modelId),
      system: input.systemPrompt ?? DEFAULT_SYSTEM,
      tools: {
        run_command: {
          description:
            "Run a short shell command inside the sandbox (<=60s). REQUIRED args: command (string), timeoutSeconds (int, optional, default 60). Always pass the literal shell text in `command`.",
          inputSchema: z
            .object({
              command: z
                .string()
                .optional()
                .describe(
                  "Shell command to execute, e.g. 'ls -la /tmp'. REQUIRED.",
                ),
              cmd: z.string().optional(),
              script: z.string().optional(),
              timeoutSeconds: z.number().int().min(1).max(60).default(60),
            })
            .transform((raw) => ({
              command: raw.command ?? raw.cmd ?? raw.script ?? "",
              timeoutSeconds: raw.timeoutSeconds ?? 60,
            }))
            .refine((v) => v.command.trim().length > 0, {
              message:
                "Missing `command` argument. Pass the literal shell text in `command`.",
              path: ["command"],
            }),
          execute: async ({ command, timeoutSeconds }) => {
            return runCommandStep({ sandboxId: sid, command, timeoutSeconds });
          },
        },
        start_command_async: {
          description:
            "Start a long-running shell command in the background. REQUIRED args: command (string), outputFile (absolute path string). Returns { result: { handle, outputFile } } — pass the handle to wait_command.",
          inputSchema: z
            .object({
              command: z.string().optional(),
              cmd: z.string().optional(),
              script: z.string().optional(),
              outputFile: z.string().optional(),
              output_file: z.string().optional(),
            })
            .transform((raw) => ({
              command: raw.command ?? raw.cmd ?? raw.script ?? "",
              outputFile: raw.outputFile ?? raw.output_file ?? "",
            }))
            .refine(
              (v) => v.command.trim().length > 0 && v.outputFile.length > 0,
              {
                message:
                  "Missing required args. Provide both `command` (string) and `outputFile` (absolute path).",
              },
            ),
          execute: async ({ command, outputFile }) => {
            return startCommandAsync({ sandboxId: sid, command, outputFile });
          },
        },
        wait_command: {
          description:
            "Wait for a backgrounded command to finish. Polls every interval seconds, up to maxMinutes.",
          inputSchema: z.object({
            handle: z.string(),
            outputFile: z.string(),
            intervalSeconds: z.number().int().min(5).max(120).default(30),
            maxMinutes: z.number().int().min(1).max(120).default(30),
            tailLines: z.number().int().min(10).max(2000).default(200),
          }),
          execute: async ({
            handle,
            outputFile,
            intervalSeconds,
            maxMinutes,
            tailLines,
          }) => {
            const deadline = maxMinutes * 60;
            let waited = 0;
            while (waited < deadline) {
              const status = await pollCommandAsync({
                sandboxId: sid,
                handle,
                outputFile,
                tailLines,
              });
              if (status.done) {
                // Wrap in `{result: ...}` to match the shape sidebar-utils
                // expects from terminal-style tools.
                return {
                  ...status,
                  result: {
                    tail: status.tail,
                    output: status.tail,
                    exitCode: status.exitCode,
                    done: status.done,
                    bytes: status.bytes,
                  },
                };
              }
              await sleep(`${intervalSeconds}s`);
              waited += intervalSeconds;
            }
            throw new FatalError(
              `wait_command exceeded ${maxMinutes} minutes for handle ${handle}`,
            );
          },
        },
        // Field names mirror the existing /api/agent file tools so the UI
        // (FileToolsHandler) renders the file name correctly: read_file
        // expects `target_file`, write_file expects `file_path` + `contents`.
        read_file: {
          description: "Read a text file from the sandbox.",
          inputSchema: z.object({
            target_file: z
              .string()
              .describe("Absolute path of the file inside the sandbox."),
            maxBytes: z.number().int().min(1).max(2_000_000).default(200_000),
          }),
          execute: async ({ target_file, maxBytes }) => {
            return readFileStep({
              sandboxId: sid,
              path: target_file,
              maxBytes,
            });
          },
        },
        write_file: {
          description: "Write a text file inside the sandbox.",
          inputSchema: z.object({
            file_path: z
              .string()
              .describe("Absolute path of the file inside the sandbox."),
            contents: z.string().describe("Full file contents to write."),
          }),
          execute: async ({ file_path, contents }) => {
            return writeFileStep({
              sandboxId: sid,
              path: file_path,
              content: contents,
            });
          },
        },
      },
    });

    const result = await agent.stream({
      messages: [{ role: "user", content: input.prompt }],
      writable,
      maxSteps: input.maxSteps ?? 60,
      collectUIMessages: true,
    });

    // Persist the final assistant UI message so the chat shows the response
    // on reload. uiMessages is populated when collectUIMessages is true.
    const uiTail = result.uiMessages?.[result.uiMessages.length - 1];
    if (uiTail && uiTail.role === "assistant" && Array.isArray(uiTail.parts)) {
      await saveAssistantMessageStep({
        chatId: input.chatId,
        userId: input.userId,
        message: {
          id: uiTail.id,
          role: "assistant",
          parts: uiTail.parts,
        },
        model: modelId,
        finishReason: "stop",
      });
    }

    return {
      sandboxId: sid,
      messages: result.messages,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    await emitWorkflowError({ errorText: `Workflow failed: ${message}` });
    throw error;
  } finally {
    if (sandboxId) {
      await killSandbox({ sandboxId });
    }
    // Always clear the active run id so the UI doesn't try to reattach to
    // a dead stream after a failed/cancelled run.
    await clearActiveWorkflowRunStep({ chatId: input.chatId });
  }
}
