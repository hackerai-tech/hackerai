import type { Sandbox } from "@e2b/code-interpreter";
import type { UIMessageStreamWriter } from "ai";
import type { Geo } from "@vercel/functions";
import type { TodoManager } from "@/lib/ai/tools/utils/todo-manager";
import { FileAccumulator } from "@/lib/ai/tools/utils/file-accumulator";
import type { BackgroundProcessTracker } from "@/lib/ai/tools/utils/background-process-tracker";
import type { ChatMode } from "./chat";
import type { ConvexSandbox } from "@/lib/ai/tools/utils/convex-sandbox";
import type { SandboxFallbackInfo } from "@/lib/ai/tools/utils/hybrid-sandbox-manager";

// Union type for both E2B Sandbox and local ConvexSandbox
export type AnySandbox = Sandbox | ConvexSandbox;

// Type guard to check if sandbox is E2B
export type IsE2BSandboxFn = (s: AnySandbox | null) => s is Sandbox;

export type SandboxType = "e2b" | "local" | "local-sandbox";

export interface SandboxInfo {
  type: SandboxType;
  name?: string;
}

export interface SandboxManager {
  getSandbox(): Promise<{ sandbox: AnySandbox }>;
  setSandbox(sandbox: AnySandbox): void;
  getSandboxType(toolName: string): SandboxType | undefined;
  getSandboxInfo(): SandboxInfo | null;
  // Optional: only HybridSandboxManager implements this
  consumeFallbackInfo?(): SandboxFallbackInfo | null;
  /** Track consecutive sandbox health failures across all tools. Returns true if the limit has been exceeded. */
  recordHealthFailure(): boolean;
  /** Reset the health failure counter (call on successful health check). */
  resetHealthFailures(): void;
  /** Check if the sandbox has been marked as permanently unavailable for this session. */
  isSandboxUnavailable(): boolean;
}

export interface SandboxContext {
  userID: string;
  setSandbox: (sandbox: Sandbox) => void;
}

/** Optional: when set (e.g. in Trigger agent-task), terminal chunks are awaited so the run yields and stream delivery can happen in real time. */
export type AppendMetadataStreamFn = (event: {
  type: "data-terminal";
  data: { terminal: string; toolCallId: string };
}) => Promise<void>;

export interface ToolContext {
  sandboxManager: SandboxManager;
  writer: UIMessageStreamWriter;
  userLocation: Geo;
  todoManager: TodoManager;
  userID: string;
  chatId: string;
  /** Whether the sandbox is E2B (true) or local (false). Drives tool schema differences. */
  isE2BSandboxPreference: boolean;
  assistantMessageId?: string;
  fileAccumulator: FileAccumulator;
  backgroundProcessTracker: BackgroundProcessTracker;
  mode: ChatMode;
  isE2BSandbox: IsE2BSandboxFn;
  guardrailsConfig?: string;
  /** When set, run_terminal_cmd awaits this for each terminal chunk so the run yields and Trigger can deliver metadata in real time. */
  appendMetadataStream?: AppendMetadataStreamFn;
}
