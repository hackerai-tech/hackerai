import { tool } from "ai";
import { z } from "zod";
import { CommandExitError } from "@e2b/code-interpreter";
import { randomUUID } from "crypto";
import type { ToolContext } from "@/types";
import { createTerminalHandler } from "@/lib/utils/terminal-executor";
import { TIMEOUT_MESSAGE } from "@/lib/token-utils";

const MAX_COMMAND_EXECUTION_TIME = 6 * 60 * 1000; // 6 minutes
const STREAM_TIMEOUT_SECONDS = 60;

export const createRunTerminalCmd = (context: ToolContext) => {
  const { sandboxManager, writer } = context;

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
8. For complex and long-running scans (e.g., nmap, dirb, gobuster), save results to files using appropriate output flags (e.g., -oN for nmap) if the tool supports it, otherwise use redirect with > operator for future reference and documentation.
9. Avoid commands with excessive output; redirect to files when necessary.
10. When users want to download or access files created/modified in the terminal sandbox, use the get_terminal_files tool to provide them as attachments.

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
- If you are generating a pdf
    - You MUST prioritize generating text content using reportlab.platypus rather than canvas
    - If you are generating text in korean, chinese, OR japanese, you MUST use the following built-in UnicodeCIDFont. To use these fonts, you must call pdfmetrics.registerFont(UnicodeCIDFont(font_name)) and apply the style to all text elements
        - japanese --> HeiseiMin-W3 or HeiseiKakuGo-W5
        - simplified chinese --> STSong-Light
        - traditional chinese --> MSung-Light
        - korean --> HYSMyeongJo-Medium
- If you are to use pypandoc, you are only allowed to call the method pypandoc.convert_text and you MUST include the parameter extra_args=['--standalone']. Otherwise the file will be corrupt/incomplete
    - For example: pypandoc.convert_text(text, 'rtf', format='md', outputfile='output.rtf', extra_args=['--standalone'])`,
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

        return new Promise((resolve, reject) => {
          let resolved = false;

          const handler = createTerminalHandler(
            (output) => createTerminalWriter(output),
            {
              timeoutSeconds: STREAM_TIMEOUT_SECONDS,
              onTimeout: () => {
                if (!resolved) {
                  resolved = true;
                  createTerminalWriter(TIMEOUT_MESSAGE(STREAM_TIMEOUT_SECONDS));
                  handler.cleanup();
                  const result = handler.getResult();
                  resolve({
                    result: { ...result, exitCode: null },
                  });
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

              if (!resolved) {
                resolved = true;
                const finalResult = handler.getResult();
                resolve({
                  result: {
                    ...execution,
                    stdout: finalResult.stdout,
                    stderr: finalResult.stderr,
                  },
                });
              }
            })
            .catch((error) => {
              handler.cleanup();
              if (!resolved) {
                resolved = true;
                // Handle CommandExitError as a valid result (non-zero exit code)
                if (error instanceof CommandExitError) {
                  const finalResult = handler.getResult();
                  resolve({
                    result: {
                      exitCode: error.exitCode,
                      stdout: finalResult.stdout,
                      stderr: finalResult.stderr,
                      error: error.message,
                    },
                  });
                } else {
                  reject(error);
                }
              }
            });
        });
      } catch (error) {
        return error as CommandExitError;
      }
    },
  });
};
