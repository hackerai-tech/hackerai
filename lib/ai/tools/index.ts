import { DefaultSandboxManager } from "./utils/sandbox-manager";
import {
  HybridSandboxManager,
  type SandboxPreference,
} from "./utils/hybrid-sandbox-manager";
import { TodoManager } from "./utils/todo-manager";
import { createRunTerminalCmd } from "./run-terminal-cmd";
import { createInteractTerminalSession } from "./interact-terminal-session";
import { createGetTerminalFiles } from "./get-terminal-files";
import { createFile } from "./file";
import { createWebSearch } from "./web-search";
import { createOpenUrlTool } from "./open-url";
import { createTodoWrite } from "./todo-write";
import { createProxyTools } from "./proxy-tool";
// import { createUpdateMemory } from "./update-memory";
import {
  createCreateNote,
  createListNotes,
  createUpdateNote,
  createDeleteNote,
} from "./notes";
// match tool removed — usage analytics showed it wasn't being used enough to justify
// the added complexity. Codex doesn't provide grep/glob tools either, and for simplicity
// and effectiveness the agent should use run_terminal_cmd with rg instead.
// import { createMatch } from "./match";
import type { UIMessageStreamWriter } from "ai";
import type {
  ChatMode,
  ToolContext,
  Todo,
  AnySandbox,
  AppendMetadataStreamFn,
  SubscriptionTier,
  SandboxBootInfo,
  CaidoReadyInfo,
} from "@/types";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import type { Geo } from "@vercel/functions";
import { FileAccumulator } from "./utils/file-accumulator";
import { BackgroundProcessTracker } from "./utils/background-process-tracker";
import { ptySessionManager } from "./utils/pty-session-manager";
import { isE2BSandbox } from "./utils/sandbox-types";

export { isE2BSandbox };

// Factory function to create tools with context
export const createTools = (
  userID: string,
  chatId: string,
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
  caidoEnabled: boolean = false,
  caidoPort?: number,
  appendMetadataStream?: AppendMetadataStreamFn,
  onToolCost?: (costDollars: number) => void,
  subscription?: SubscriptionTier,
  onSandboxBoot?: (info: SandboxBootInfo) => void,
  onCaidoReady?: (info: CaidoReadyInfo) => void,
) => {
  let sandbox: AnySandbox | null = null;
  let sandboxFirstUsedAt: number | null = null;

  // E2B sandbox cost: ~$0.05/hour for 4-core 2GB
  const E2B_COST_PER_MS = 0.05 / (60 * 60 * 1000);

  const trackSandboxUsage = (newSandbox: AnySandbox) => {
    sandbox = newSandbox;
    if (!sandboxFirstUsedAt && isE2BSandbox(newSandbox)) {
      sandboxFirstUsedAt = Date.now();
    }
  };

  // E2B protection: free agent users must never use DefaultSandboxManager (always E2B)
  if (subscription === "free" && isAgentMode(mode)) {
    if (!sandboxPreference || sandboxPreference === "e2b") {
      throw new Error(
        "Free agent mode requires a local sandbox. E2B is not available on the free plan.",
      );
    }
  }

  // Use HybridSandboxManager if sandboxPreference and serviceKey are provided
  const sandboxManager =
    sandboxPreference && serviceKey
      ? new HybridSandboxManager(
          userID,
          trackSandboxUsage,
          sandboxPreference,
          serviceKey,
          isE2BSandbox(sandbox) ? sandbox : null,
          subscription,
          onSandboxBoot,
        )
      : new DefaultSandboxManager(
          userID,
          trackSandboxUsage,
          isE2BSandbox(sandbox) ? sandbox : null,
          onSandboxBoot,
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
    chatId,
    assistantMessageId,
    fileAccumulator,
    backgroundProcessTracker,
    ptySessionManager,
    mode,
    isE2BSandbox,
    guardrailsConfig,
    caidoEnabled,
    caidoPort,
    appendMetadataStream,
    onToolCost,
    onCaidoReady,
  };

  // Create all available tools
  const allTools = {
    run_terminal_cmd: createRunTerminalCmd(context),
    interact_terminal_session: createInteractTerminalSession(context),
    get_terminal_files: createGetTerminalFiles(context),
    file: createFile(context),
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
    ...(caidoEnabled && createProxyTools(context)),
    ...(process.env.JINA_API_KEY && {
      open_url: createOpenUrlTool(),
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

  const getSandboxSessionCost = (): number => {
    if (!sandboxFirstUsedAt) return 0;
    return (Date.now() - sandboxFirstUsedAt) * E2B_COST_PER_MS;
  };

  return {
    tools,
    getSandbox,
    ensureSandbox,
    getTodoManager,
    getFileAccumulator,
    sandboxManager,
    getSandboxSessionCost,
  };
};

// Re-export types for external use
export type { SandboxPreference };
