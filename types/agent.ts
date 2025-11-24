import type { Sandbox } from "@e2b/code-interpreter";
import type { UIMessageStreamWriter } from "ai";
import type { Geo } from "@vercel/functions";
import type { TodoManager } from "@/lib/ai/tools/utils/todo-manager";
import { FileAccumulator } from "@/lib/ai/tools/utils/file-accumulator";
import type { BackgroundProcessTracker } from "@/lib/ai/tools/utils/background-process-tracker";
import type { ChatMode } from "./chat";
import type { ConvexSandbox } from "@/lib/ai/tools/utils/convex-sandbox";

// Union type for both E2B Sandbox and local ConvexSandbox
export type AnySandbox = Sandbox | ConvexSandbox;

export interface SandboxManager {
  getSandbox(): Promise<{ sandbox: AnySandbox }>;
  setSandbox(sandbox: AnySandbox): void;
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
}
