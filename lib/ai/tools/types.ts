import type { Sandbox } from "@e2b/code-interpreter";
import type { UIMessageStreamWriter } from "ai";
import type { ExecutionMode } from "./execution-types";

export interface SandboxManager {
  getSandbox(): Promise<{ sandbox: Sandbox }>;
  setSandbox(sandbox: Sandbox): void;
}

export interface SandboxContext {
  userID: string;
  setSandbox: (sandbox: Sandbox) => void;
}

export interface ToolContext {
  sandboxManager: SandboxManager;
  writer: UIMessageStreamWriter;
  executionMode: ExecutionMode;
}
