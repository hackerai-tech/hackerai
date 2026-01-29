import { Sandbox } from "@e2b/code-interpreter";
import { DefaultSandboxManager } from "./utils/sandbox-manager";
import {
  HybridSandboxManager,
  type SandboxPreference,
} from "./utils/hybrid-sandbox-manager";
import { TodoManager } from "./utils/todo-manager";
import { createRunTerminalCmd } from "./run-terminal-cmd";
import { createGetTerminalFiles } from "./get-terminal-files";
// import { createReadFile } from "./read-file";
// import { createWriteFile } from "./write-file";
import { createFile } from "./file";
// import { createMatch } from "./match";
import { createWebSearch } from "./web-search";
import { createOpenUrlTool } from "./open-url";
import { createTodoWrite } from "./todo-write";
// import { createUpdateMemory } from "./update-memory";
import {
  createCreateNote,
  createListNotes,
  createUpdateNote,
  createDeleteNote,
} from "./notes";
import type { UIMessageStreamWriter } from "ai";
import type { ChatMode, ToolContext, Todo, AnySandbox } from "@/types";
import type { Geo } from "@vercel/functions";
import { FileAccumulator } from "./utils/file-accumulator";
import { BackgroundProcessTracker } from "./utils/background-process-tracker";

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
    guardrailsConfig,
  };

  // Create all available tools
  const allTools = {
    run_terminal_cmd: createRunTerminalCmd(context),
    get_terminal_files: createGetTerminalFiles(context),
    // read_file: createReadFile(context),
    // write_file: createWriteFile(context),
    file: createFile(context),
    // search_replace: createSearchReplace(context),
    // match: createMatch(context),
    todo_write: createTodoWrite(context),
    // ...(!isTemporary &&
    //   memoryEnabled && { update_memory: createUpdateMemory(context) }),
    ...(!isTemporary &&
      memoryEnabled && {
        create_note: createCreateNote(context),
        list_notes: createListNotes(context),
        update_note: createUpdateNote(context),
        delete_note: createDeleteNote(context),
      }),
    ...(process.env.PERPLEXITY_API_KEY && {
      web_search: createWebSearch(context),
    }),
  };

  // Filter tools based on mode
  const tools =
    mode === "ask"
      ? {
          // ...(!isTemporary &&
          //   memoryEnabled && { update_memory: allTools.update_memory }),
          ...(!isTemporary &&
            memoryEnabled && {
              create_note: allTools.create_note,
              list_notes: allTools.list_notes,
              update_note: allTools.update_note,
              delete_note: allTools.delete_note,
            }),
          ...(process.env.PERPLEXITY_API_KEY && {
            web_search: createWebSearch(context),
          }),
          ...(process.env.JINA_API_KEY && {
            open_url: createOpenUrlTool(),
          }),
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
