import { tool } from "ai";
import { z } from "zod";
import { CommandExitError } from "@e2b/code-interpreter";
import { randomUUID } from "crypto";
import type { ToolContext } from "@/types";
import {
  executeLocalCommand,
  createLocalTerminalHandlers,
} from "./utils/local-terminal";
import {
  createSharedTokenAwareHandlers,
  truncateCombinedOutput,
} from "@/lib/token-utils";

// 6 minutes
const MAX_COMMAND_EXECUTION_TIME = 6 * 60 * 1000;

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
7. Dont include any newlines in the command.`,
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
          // Execute locally using Node.js child_process
          const { onStdout, onStderr } = createLocalTerminalHandlers(
            writer,
            toolCallId,
          );

          const { stdoutHandler, stderrHandler } =
            createSharedTokenAwareHandlers(onStdout, onStderr);

          const result = await executeLocalCommand(command, {
            cwd: process.cwd(),
            onStdout: stdoutHandler,
            onStderr: stderrHandler,
            background: is_background,
          });

          const { stdout, stderr } = truncateCombinedOutput(
            result.stdout || "",
            result.stderr || "",
            "run-terminal-cmd",
          );
          return { result: { ...result, stdout, stderr } };
        } else {
          // Execute in sandbox (existing behavior)
          const { sandbox } = await sandboxManager.getSandbox();

          // Generate cryptographically strong unique ID for this terminal session
          const terminalSessionId = `terminal-${randomUUID()}`;
          let outputCounter = 0;

          const createTerminalWriter = (output: string) => {
            writer.write({
              type: "data-terminal",
              id: `${terminalSessionId}-${++outputCounter}`,
              data: { terminal: output, toolCallId },
            });
          };

          const { stdoutHandler, stderrHandler } =
            createSharedTokenAwareHandlers(
              createTerminalWriter,
              createTerminalWriter,
            );

          // Create common handlers
          const commonOptions = {
            timeoutMs: MAX_COMMAND_EXECUTION_TIME,
            user: "root" as const,
            cwd: "/home/user",
            onStdout: stdoutHandler,
            onStderr: stderrHandler,
          };

          const execution = is_background
            ? await sandbox.commands.run(command, {
                ...commonOptions,
                background: true,
              })
            : await sandbox.commands.run(command, commonOptions);

          const { stdout, stderr } = truncateCombinedOutput(
            execution.stdout,
            execution.stderr,
            "run-terminal-cmd",
          );
          return { result: { ...execution, stdout, stderr } };
        }
      } catch (error) {
        return error as CommandExitError;
      }
    },
  });
};
