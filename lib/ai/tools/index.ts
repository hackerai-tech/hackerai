import { Sandbox } from "@e2b/code-interpreter";
import { DefaultSandboxManager } from "./utils/sandbox-manager";
import { createRunTerminalCmd } from "./run-terminal-cmd";
import { createReadFile } from "./read-file";
import { createWriteFile } from "./write-file";
import type { ToolContext } from "./types";
import type { UIMessageStreamWriter } from "ai";
import type { ExecutionMode } from "./execution-types";

// Factory function to create tools with context
export const createTools = (
  userID: string,
  writer: UIMessageStreamWriter,
  mode: "agent" | "ask" = "agent",
  executionMode: ExecutionMode = "local",
) => {
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
    writer,
    executionMode,
  };

  // Create all available tools
  const allTools = {
    runTerminalCmd: createRunTerminalCmd(context),
    readFile: createReadFile(context),
    writeFile: createWriteFile(context),
  };

  // Filter tools based on mode
  const tools = mode === "ask" ? { readFile: allTools.readFile } : allTools;

  const getSandbox = () => sandbox;

  return { tools, getSandbox };
};
