import { tool } from "ai";
import type { ToolContext } from "@/types";
import {
  INTERACT_TERMINAL_SESSION_DESCRIPTION,
  INTERACT_TERMINAL_SESSION_INPUT_SCHEMA,
  INTERACT_TERMINAL_SESSION_DEFAULT_WAIT_TIMEOUT_SECONDS,
  INTERACT_TERMINAL_SESSION_MAX_WAIT_TIMEOUT_SECONDS,
} from "./schemas";
import { performInteractTerminalAction } from "./utils/interact-terminal-impl";

export const createInteractTerminalSession = (context: ToolContext) => {
  const { writer, chatId, ptySessionManager } = context;

  return tool({
    description: INTERACT_TERMINAL_SESSION_DESCRIPTION,
    inputSchema: INTERACT_TERMINAL_SESSION_INPUT_SCHEMA,
    execute: async (
      {
        session: sessionId,
        action,
        input,
        timeout,
      }: {
        session: string;
        action: "send" | "wait" | "view" | "kill";
        input?: string;
        timeout?: number;
      },
      { toolCallId, abortSignal },
    ) => {
      const timeoutMs =
        Math.min(
          timeout ?? INTERACT_TERMINAL_SESSION_DEFAULT_WAIT_TIMEOUT_SECONDS,
          INTERACT_TERMINAL_SESSION_MAX_WAIT_TIMEOUT_SECONDS,
        ) * 1000;

      // Emit raw bytes to UI terminal stream — no cleaning during streaming.
      // The sessionSnapshot in the final result is properly cleaned via xterm
      // headless and the UI prefers it once the tool completes.
      const emitTerminal = (bytes: Uint8Array): void => {
        const text = new TextDecoder().decode(bytes);
        writer.write({
          type: "data-terminal",
          id: `pty-${toolCallId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          data: {
            terminal: text,
            toolCallId,
            action,
            session: sessionId,
          } as unknown as { terminal: string; toolCallId: string },
        });
      };

      return performInteractTerminalAction({
        action,
        sessionId,
        chatId,
        input,
        timeoutMs,
        ptySessionManager,
        abortSignal,
        emitTerminal,
      });
    },
  });
};
