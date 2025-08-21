import { Sandbox } from "@e2b/code-interpreter";
import { DefaultSandboxManager } from "./utils/sandbox-manager";
import { TodoManager } from "./utils/todo-manager";
import { createRunTerminalCmd } from "./run-terminal-cmd";
import { createReadFile } from "./read-file";
import { createWriteFile } from "./write-file";
import { createDeleteFile } from "./delete-file";
import { createSearchReplace } from "./search-replace";
import { createMultiEdit } from "./multi-edit";
import { createWebSearchTool } from "./web-search";
import { createTodoWrite } from "./todo-write";
import type { UIMessageStreamWriter } from "ai";
import type { ChatMode, ExecutionMode, ToolContext } from "@/types";
import type { Geo } from "@vercel/functions";

// Factory function to create tools with context
export const createTools = (
  userID: string,
  writer: UIMessageStreamWriter,
  mode: ChatMode = "agent",
  executionMode: ExecutionMode = "local",
  userLocation: Geo,
) => {
  let sandbox: Sandbox | null = null;

  const sandboxManager = new DefaultSandboxManager(
    userID,
    (newSandbox) => {
      sandbox = newSandbox;
    },
    sandbox,
  );

  const todoManager = new TodoManager();

  const context: ToolContext = {
    sandboxManager,
    writer,
    executionMode,
    userLocation,
    todoManager,
  };

  // Create all available tools
  const allTools = {
    runTerminalCmd: createRunTerminalCmd(context),
    readFile: createReadFile(context),
    writeFile: createWriteFile(context),
    deleteFile: createDeleteFile(context),
    searchReplace: createSearchReplace(context),
    multiEdit: createMultiEdit(context),
    todoWrite: createTodoWrite(context, false),
    todoManager: createTodoWrite(context, true),
    ...(process.env.EXA_API_KEY && { webSearch: createWebSearchTool(context) }),
  };

  // Filter tools based on mode
  const tools =
    mode === "ask"
      ? {
          readFile: allTools.readFile,
          todoWrite: allTools.todoWrite,
          todoManager: allTools.todoManager,
          ...(process.env.EXA_API_KEY && { webSearch: allTools.webSearch }),
        }
      : allTools;

  const getSandbox = () => sandbox;

  return { tools, getSandbox };
};
