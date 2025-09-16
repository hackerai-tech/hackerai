import { Sandbox } from "@e2b/code-interpreter";
import { DefaultSandboxManager } from "./utils/sandbox-manager";
import { TodoManager } from "./utils/todo-manager";
import { createRunTerminalCmd } from "./run-terminal-cmd";
import { createReadFile } from "./read-file";
import { createWriteFile } from "./write-file";
import { createSearchReplace } from "./search-replace";
import { createWebTool } from "./web";
import { createTodoWrite } from "./todo-write";
import { createUpdateMemory } from "./update-memory";
import type { UIMessageStreamWriter } from "ai";
import type { ChatMode, ExecutionMode, ToolContext, Todo } from "@/types";
import type { Geo } from "@vercel/functions";

// Factory function to create tools with context
export const createTools = (
  userID: string,
  writer: UIMessageStreamWriter,
  mode: ChatMode = "agent",
  executionMode: ExecutionMode = "local",
  userLocation: Geo,
  initialTodos?: Todo[],
  memoryEnabled: boolean = true,
  isTemporary: boolean = false,
) => {
  let sandbox: Sandbox | null = null;

  const sandboxManager = new DefaultSandboxManager(
    userID,
    (newSandbox) => {
      sandbox = newSandbox;
    },
    sandbox,
  );

  const todoManager = new TodoManager(initialTodos);

  const context: ToolContext = {
    sandboxManager,
    writer,
    executionMode,
    userLocation,
    todoManager,
    userID,
  };

  // Create all available tools
  const allTools = {
    run_terminal_cmd: createRunTerminalCmd(context),
    read_file: createReadFile(context),
    write_file: createWriteFile(context),
    search_replace: createSearchReplace(context),
    todo_write: createTodoWrite(context),
    ...(!isTemporary &&
      memoryEnabled && { update_memory: createUpdateMemory(context) }),
    ...(process.env.EXA_API_KEY && {
      web: createWebTool(context),
    }),
  };

  // Filter tools based on mode
  const tools =
    mode === "ask"
      ? {
          // read_file: allTools.read_file,
          // todo_write: createTodoWrite(context),
          ...(!isTemporary &&
            memoryEnabled && { update_memory: allTools.update_memory }),
          ...(process.env.EXA_API_KEY && { web: allTools.web }),
        }
      : allTools;

  const getSandbox = () => sandbox;
  const getTodoManager = () => todoManager;

  return { tools, getSandbox, getTodoManager };
};
