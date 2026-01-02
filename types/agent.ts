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

export interface SandboxManager {
  getSandbox(): Promise<{ sandbox: AnySandbox }>;
  setSandbox(sandbox: AnySandbox): void;
  // Optional: only HybridSandboxManager implements this
  consumeFallbackInfo?(): SandboxFallbackInfo | null;
}

export interface SandboxContext {
  userID: string;
  setSandbox: (sandbox: Sandbox) => void;
}

export interface ToolContext {
  sandboxManager: SandboxManager;
  writer: UIMessageStreamWriter;
  userLocation: Geo;
  todoManager: TodoManager;
  userID: string;
  assistantMessageId?: string;
  fileAccumulator: FileAccumulator;
  backgroundProcessTracker: BackgroundProcessTracker;
  mode: ChatMode;
  isE2BSandbox: IsE2BSandboxFn;
  scopeExclusions?: string;
  guardrailsConfig?: string;
}
