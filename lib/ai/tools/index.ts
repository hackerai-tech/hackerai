import { Sandbox } from "@e2b/code-interpreter";
import { DefaultSandboxManager } from "./utils/sandbox-manager";
import { TodoManager } from "./utils/todo-manager";
import { createRunTerminalCmd } from "./run-terminal-cmd";
import { createGetTerminalFiles } from "./get-terminal-files";
import { createReadFile } from "./read-file";
import { createWriteFile } from "./write-file";
import { createSearchReplace } from "./search-replace";
import { createWebTool } from "./web";
import { createTodoWrite } from "./todo-write";
import { createUpdateMemory } from "./update-memory";
import { createPythonTool } from "./python";
import type { UIMessageStreamWriter } from "ai";
import type { ChatMode, ToolContext, Todo } from "@/types";
import type { Geo } from "@vercel/functions";
import { FileAccumulator } from "./utils/file-accumulator";
import { BackgroundProcessTracker } from "./utils/background-process-tracker";

// Factory function to create tools with context
export const createTools = (
  userID: string,
  writer: UIMessageStreamWriter,
  mode: ChatMode = "agent",
  userLocation: Geo,
  initialTodos?: Todo[],
  memoryEnabled: boolean = true,
  isTemporary: boolean = false,
  assistantMessageId?: string,
  subscription: "free" | "pro" | "team" | "ultra" = "free",
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
  const fileAccumulator = new FileAccumulator();
  const backgroundProcessTracker = new BackgroundProcessTracker();

  const context: ToolContext = {
    sandboxManager,
    writer,
    userLocation,
    todoManager,
    userID,
    assistantMessageId,
    fileAccumulator,
    backgroundProcessTracker,
    mode,
  };

  // Create all available tools
  const allTools = {
    run_terminal_cmd: createRunTerminalCmd(context),
    get_terminal_files: createGetTerminalFiles(context),
    read_file: createReadFile(context),
    write_file: createWriteFile(context),
    search_replace: createSearchReplace(context),
    todo_write: createTodoWrite(context),
    python: createPythonTool(context),
    ...(!isTemporary &&
      memoryEnabled && { update_memory: createUpdateMemory(context) }),
    ...(process.env.EXA_API_KEY &&
      process.env.JINA_API_KEY && {
        web: createWebTool(context),
      }),
  };

  // Filter tools based on mode
  const tools =
    mode === "ask"
      ? {
          ...(!isTemporary &&
            memoryEnabled && { update_memory: allTools.update_memory }),
          // ...(subscription !== "free" && { python: allTools.python }),
          ...(process.env.EXA_API_KEY &&
            process.env.JINA_API_KEY && { web: allTools.web }),
        }
      : allTools;

  const getSandbox = () => sandbox;
  const ensureSandbox = async () => {
    const { sandbox: ensured } = await sandboxManager.getSandbox();
    return ensured;
  };
  const getTodoManager = () => todoManager;
  const getFileAccumulator = () => fileAccumulator;

  return {
    tools,
    getSandbox,
    ensureSandbox,
    getTodoManager,
    getFileAccumulator,
  };
};
