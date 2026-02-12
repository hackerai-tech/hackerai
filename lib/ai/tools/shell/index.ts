import { tool } from "ai";
import { z } from "zod";
import { Sandbox } from "@e2b/code-interpreter";
import type { ToolContext } from "@/types";
import { waitForSandboxReady } from "../utils/sandbox-health";
import { isE2BSandbox } from "../utils/sandbox-types";
import {
  parseGuardrailConfig,
  getEffectiveGuardrails,
} from "../utils/guardrails";
import { LocalPtySessionManager, type TmuxSandbox } from "./session";
import { createE2BHandlers } from "./handlers/e2b";
import { createLocalHandlers } from "./handlers/local";

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 600;

export const createShell = (context: ToolContext) => {
  const {
    sandboxManager,
    writer,
    chatId,
    isE2BSandboxPreference,
    guardrailsConfig,
  } = context;

  const userGuardrailConfig = parseGuardrailConfig(guardrailsConfig);
  const effectiveGuardrails = getEffectiveGuardrails(userGuardrailConfig);

  // Both E2B and local paths use tmux-based session management for consistent
  // behavior (reliable wait/send/kill, pane_current_command idle detection).
  // Separate instances avoid session name collisions between sandbox types.
  const e2bSessionManager = new LocalPtySessionManager(chatId);
  const localSessionManager = new LocalPtySessionManager(chatId);

  const e2bHandlers = createE2BHandlers({
    sessionManager: e2bSessionManager,
    writer,
    effectiveGuardrails,
  });
  const localHandlers = createLocalHandlers({
    localSessionManager,
    writer,
    effectiveGuardrails,
  });

  // Only health-check the sandbox once per chat context
  let healthChecked = false;

  return tool({
    description: `Interact with persistent shell sessions in the sandbox environment.

<supported_actions>
- \`exec\`: Execute command in a shell session
- \`wait\`: Wait for the running process in a shell session to return
- \`send\`: Send input to the active process (stdin) in a shell session
- \`kill\`: Terminate the running process in a shell session
</supported_actions>

<instructions>
- Prioritize using \`file\` tool instead of this tool for file content operations to avoid escaping errors
- \`exec\` runs the command and returns output along with a \`session\` identifier — save this for subsequent \`wait\`, \`send\`, and \`kill\` actions
- The default working directory for newly created shell sessions is /home/user
- Working directory will be reset to /home/user in every new shell session; Use \`cd\` command to change directories as needed
- MUST avoid commands that require confirmation; use flags like \`-y\` or \`-f\` for automatic execution
- Avoid commands with excessive output; redirect to files when necessary
- Chain multiple commands with \`&&\` to reduce interruptions and handle errors cleanly
- Use pipes (\`|\`) to simplify workflows by passing outputs between commands
- NEVER run code directly via interpreter commands; MUST save code to a file using the \`file\` tool before execution
- Set a short \`timeout\` (such as 5s) for commands that don't return (like starting web servers) to avoid meaningless waiting time
- Commands are NEVER killed on timeout - they keep running in the background; timeout only controls how long to wait for output before returning
- For daemons, servers, or very long-running jobs, append \`&\` to run in background (e.g., \`python app.py > server.log 2>&1 &\`)
- Use \`wait\` action when a command needs additional time to complete and return
- Only use \`wait\` after \`exec\`, and determine whether to wait based on the result of \`exec\`
- DO NOT use \`wait\` for long-running daemon processes
- When using \`send\`, add a newline character (\\n) at the end of the \`input\` parameter to simulate pressing Enter
- For special keys, use official tmux key names: C-c (Ctrl+C), C-d (Ctrl+D), C-z (Ctrl+Z), Up, Down, Left, Right, Home, End, Escape, Tab, Enter, Space, F1-F12, PageUp, PageDown
- For modifier combinations: M-key (Alt), S-key (Shift), C-S-key (Ctrl+Shift)
- Note: Use official tmux names (BSpace not Backspace, DC not Delete, Escape not Esc)
- For non-key strings in \`input\`, DO NOT perform any escaping; send the raw string directly
</instructions>

<recommended_usage>
- Use \`exec\` to install packages or dependencies
- Use \`exec\` to copy, move, or delete files
- Use \`exec\` to run scripts and tools
- Use \`wait\` to wait for the completion of long-running commands
- Use \`send\` to interact with processes that require user input (e.g., responding to prompts)
- Use \`send\` with special keys like C-c to interrupt, C-d to send EOF
- Use \`kill\` to stop background processes that are no longer needed
- Use \`kill\` to clean up dead or unresponsive processes
- After creating files that the user needs (reports, scan results, generated documents), use the \`get_terminal_files\` tool to share them as downloadable attachments
</recommended_usage>

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
      action: z
        // TODO: re-add "view" once terminal output persistence is implemented
        .enum([/* "view", */ "exec", "wait", "send", "kill"])
        .describe("The action to perform"),
      brief: z
        .string()
        .describe(
          "A one-sentence preamble describing the purpose of this operation",
        ),
      command: z
        .string()
        .optional()
        .describe("The shell command to execute. Required for `exec` action."),
      input: z
        .string()
        .optional()
        .describe(
          "Input text to send to the interactive session. End with a newline character (\\n) to simulate pressing Enter if needed. Required for `send` action.",
        ),
      // Both E2B and local sandboxes use tmux-based string session identifiers
      session: z
        .string()
        .optional()
        .describe(
          "The session identifier returned by `exec`. Required for `wait`, `send`, and `kill` actions.",
        ),
      timeout: z
        .number()
        .int()
        .optional()
        .default(DEFAULT_TIMEOUT_SECONDS)
        .describe(
          `Timeout in seconds to wait for command execution. Only used for \`exec\` and \`wait\` actions. Defaults to ${DEFAULT_TIMEOUT_SECONDS} seconds. Max ${MAX_TIMEOUT_SECONDS} seconds.`,
        ),
    }),
    execute: async (
      {
        action,
        command,
        input,
        session,
        timeout,
      }: {
        action: /* "view" | */ "exec" | "wait" | "send" | "kill";
        command?: string;
        input?: string;
        session?: string;
        timeout?: number;
      },
      { toolCallId, abortSignal },
    ) => {
      const defaultForAction =
        action === "wait" ? MAX_TIMEOUT_SECONDS : DEFAULT_TIMEOUT_SECONDS;
      const effectiveTimeout = Math.min(
        timeout ?? defaultForAction,
        MAX_TIMEOUT_SECONDS,
      );

      try {
        const { sandbox } = await sandboxManager.getSandbox();

        const fallbackInfo = sandboxManager.consumeFallbackInfo?.();
        if (fallbackInfo?.occurred) {
          writer.write({
            type: "data-sandbox-fallback",
            id: `sandbox-fallback-${toolCallId}`,
            data: fallbackInfo,
          });
        }

        // Non-E2B sandboxes: use tmux-based local PTY sessions
        if (!isE2BSandbox(sandbox)) {
          return localHandlers.dispatch(
            sandbox as TmuxSandbox,
            action,
            command,
            input,
            session,
            effectiveTimeout,
            toolCallId,
            abortSignal,
          );
        }

        const e2b = sandbox as Sandbox;

        // Health-check the E2B sandbox before first use
        if (action === "exec" && !healthChecked) {
          healthChecked = true;
          try {
            await waitForSandboxReady(sandbox, 5, abortSignal);
          } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError")
              throw err;

            console.warn("[Shell] Sandbox health check failed, recreating");
            sandboxManager.setSandbox(null as any);
            const { sandbox: fresh } = await sandboxManager.getSandbox();

            if (!isE2BSandbox(fresh)) {
              return localHandlers.dispatch(
                fresh as TmuxSandbox,
                action,
                command,
                input,
                session,
                effectiveTimeout,
                toolCallId,
                abortSignal,
              );
            }
            await waitForSandboxReady(fresh, 5, abortSignal);
            return e2bHandlers.dispatch(
              fresh as Sandbox,
              action,
              command,
              input,
              session,
              effectiveTimeout,
              toolCallId,
              abortSignal,
            );
          }
        }

        // E2B sandboxes: also use tmux (installed automatically) for consistent
        // wait/send/kill behavior with pane_current_command idle detection.
        return e2bHandlers.dispatch(
          e2b,
          action,
          command,
          input,
          session,
          effectiveTimeout,
          toolCallId,
          abortSignal,
        );
      } catch (error) {
        console.error("[Shell] Error:", error);
        return {
          output:
            error instanceof Error ? error.message : "Unknown error occurred",
          error: true,
        };
      }
    },
  });
};
