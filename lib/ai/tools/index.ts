import { Sandbox } from "@e2b/code-interpreter";
import { DefaultSandboxManager } from "./utils/sandbox-manager";
import {
  HybridSandboxManager,
  type SandboxPreference,
} from "./utils/hybrid-sandbox-manager";
import { TodoManager } from "./utils/todo-manager";
import { createRunTerminalCmd } from "./run-terminal-cmd";
import { createGetTerminalFiles } from "./get-terminal-files";
import { createReadFile } from "./read-file";
import { createSearchReplace } from "./search-replace";
import { createWebTool } from "./web";
import { createTodoWrite } from "./todo-write";
import { createUpdateMemory } from "./update-memory";
import { createHttpRequest } from "./http-request";
import type { UIMessageStreamWriter } from "ai";
import type { ChatMode, ToolContext, Todo, AnySandbox } from "@/types";
import type { Geo } from "@vercel/functions";
import { FileAccumulator } from "./utils/file-accumulator";
import { BackgroundProcessTracker } from "./utils/background-process-tracker";
import { type ModelName } from "@/lib/ai/providers";

/**
 * Check if a sandbox instance is an E2B Sandbox (vs local ConvexSandbox)
 * E2B Sandbox has jupyterUrl property, ConvexSandbox does not
 */
export const isE2BSandbox = (s: AnySandbox | null): s is Sandbox => {
  return s !== null && "jupyterUrl" in s;
};

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
  sandboxPreference?: SandboxPreference,
  serviceKey?: string,
  scopeExclusions?: string,
  guardrailsConfig?: string,
) => {
  let sandbox: AnySandbox | null = null;

  // Use HybridSandboxManager if sandboxPreference and serviceKey are provided
  const sandboxManager =
    sandboxPreference && serviceKey
      ? new HybridSandboxManager(
          userID,
          (newSandbox) => {
            sandbox = newSandbox;
          },
          sandboxPreference,
          serviceKey,
          isE2BSandbox(sandbox) ? sandbox : null,
        )
      : new DefaultSandboxManager(
          userID,
          (newSandbox) => {
            sandbox = newSandbox;
          },
          isE2BSandbox(sandbox) ? sandbox : null,
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
    isE2BSandbox,
    scopeExclusions,
    guardrailsConfig,
  };

  // Create all available tools
  const allTools = {
    run_terminal_cmd: createRunTerminalCmd(context),
    get_terminal_files: createGetTerminalFiles(context),
    read_file: createReadFile(context),
    search_replace: createSearchReplace(context),
    todo_write: createTodoWrite(context),
    http_request: createHttpRequest(context),
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
    sandboxManager,
  };
};

// Re-export types for external use
export type { SandboxPreference };
