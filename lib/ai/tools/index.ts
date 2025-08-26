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
  };

  // Create all available tools
  const allTools = {
    run_terminal_cmd: createRunTerminalCmd(context),
    read_file: createReadFile(context),
    write_file: createWriteFile(context),
    delete_file: createDeleteFile(context),
    search_replace: createSearchReplace(context),
    multi_edit: createMultiEdit(context),
    todo_write: createTodoWrite(context),
    ...(process.env.EXA_API_KEY && {
      web_search: createWebSearchTool(context),
    }),
  };

  // Filter tools based on mode
  const tools =
    mode === "ask"
      ? {
          // read_file: allTools.read_file,
          // todo_write: createTodoWrite(context),
          ...(process.env.EXA_API_KEY && { web_search: allTools.web_search }),
        }
      : allTools;

  const getSandbox = () => sandbox;
  const getTodoManager = () => todoManager;

  return { tools, getSandbox, getTodoManager };
};
