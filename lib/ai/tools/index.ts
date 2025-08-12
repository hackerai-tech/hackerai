import { Sandbox } from "@e2b/code-interpreter";
import { DefaultSandboxManager } from "./utils/sandbox-manager";
import { createRunTerminalCmd } from "./run-terminal-cmd";
import type { ToolContext } from "./types";

// Factory function to create tools with context
export const createTools = (userID: string) => {
  let sandbox: Sandbox | null = null;

  const sandboxManager = new DefaultSandboxManager(
    userID,
    (newSandbox) => {
      sandbox = newSandbox;
    },
    sandbox,
  );

  const context: ToolContext = {
    sandboxManager,
  };

  const tools = {
    runTerminalCmd: createRunTerminalCmd(context),
  };

  const getSandbox = () => sandbox;

  return { tools, getSandbox };
};
