import type { Sandbox } from "@e2b/code-interpreter";
import type { UIMessageStreamWriter } from "ai";
import type { Geo } from "@vercel/functions";
import type { TodoManager } from "@/lib/ai/tools/utils/todo-manager";
import { FileAccumulator } from "@/lib/ai/tools/utils/file-accumulator";
import type { BackgroundProcessTracker } from "@/lib/ai/tools/utils/background-process-tracker";
import type { PtySessionManager } from "@/lib/ai/tools/utils/pty-session-manager";
import type { ChatMode, SubscriptionTier } from "./chat";
import type { CentrifugoSandbox } from "@/lib/ai/tools/utils/centrifugo-sandbox";
import type { SandboxFallbackInfo } from "@/lib/ai/tools/utils/hybrid-sandbox-manager";

// Union type for E2B Sandbox and local CentrifugoSandbox
export type AnySandbox = Sandbox | CentrifugoSandbox;

// Type guard to check if sandbox is E2B
export type IsE2BSandboxFn = (s: AnySandbox | null) => s is Sandbox;

export type SandboxType = "e2b" | "desktop" | "remote-connection";

export interface SandboxInfo {
  type: SandboxType;
  name?: string;
}

export interface SandboxManager {
  getSandbox(): Promise<{ sandbox: AnySandbox }>;
  setSandbox(sandbox: AnySandbox): void;
  resetSandbox?(reason?: string): Promise<void>;
  getSandboxType(toolName: string): SandboxType | undefined;
  getSandboxInfo(): SandboxInfo | null;
  // Optional: only HybridSandboxManager implements this
  peekFallbackInfo?(): SandboxFallbackInfo | null;
  consumeFallbackInfo?(): SandboxFallbackInfo | null;
  clearFallbackInfo?(): void;
  /** Get the effective sandbox preference after any fallbacks (e.g. "e2b" or connectionId). */
  getEffectivePreference(): string;
  /** Track consecutive sandbox health failures across all tools. Returns true if the limit has been exceeded. */
  recordHealthFailure(): boolean;
  /** Reset the health failure counter (call on successful health check). */
  resetHealthFailures(): void;
  /** Check if the sandbox has been marked as permanently unavailable for this session. */
  isSandboxUnavailable(): boolean;
  /** Whether the effective sandbox can create interactive PTY sessions. */
  supportsInteractivePty?(): Promise<boolean>;
}

export interface SandboxBootInfo {
  path:
    | "reuse_existing"
    | "create_fresh"
    | "create_after_version_mismatch"
    | "create_after_expired"
    | "create_after_broken";
  duration_ms: number;
  create_attempts: number;
}

export interface SandboxContext {
  userID: string;
  setSandbox: (sandbox: Sandbox) => void;
  /** Called once when ensureSandboxConnection actually does work (creates or reconnects). */
  onBoot?: (info: SandboxBootInfo) => void;
}

/** Optional: when set, terminal chunks are awaited so the run yields and stream delivery can happen in real time. */
export type AppendMetadataStreamFn = (event: {
  type: "data-terminal";
  data: { terminal: string; toolCallId: string };
}) => Promise<void>;

/** Provider/tool-scoped failure data. Host runtimes attach request/user context separately. */
export type ToolFailureLogEvent = {
  event: string;
  tool_name: string;
  provider: string;
  status?: number;
  status_text?: string;
  retryable?: boolean;
  attempts?: number;
  duration_ms?: number;
  error_code?: string;
  error_name?: string;
  error_message?: string;
  url_hostname?: string;
  body_summary?: string;
};

export type ToolFailureLogger = (
  event: ToolFailureLogEvent,
) => void | Promise<void>;

export type AgentToolApprovalGrant = "full_access" | "target_prefix";
export type AgentToolApprovalGrantKind =
  "terminal_command" | "terminal_interaction" | "file_change";

export type AgentToolApprovalDecision = "approve" | "deny";

export type AgentToolApprovalOperation =
  | "terminal_execute"
  | "terminal_interact"
  | "file_write"
  | "file_append"
  | "file_edit";

export type AgentToolApprovalRequest = {
  toolCallId: string;
  toolName: string;
  operation: AgentToolApprovalOperation;
  target: string;
  brief?: string;
};

export type AgentToolApprovalResult =
  | {
      approved: true;
      approvalId: string;
    }
  | {
      approved: false;
      approvalId?: string;
      reason: string;
    };

export type AgentToolApprovalRequester = (
  request: AgentToolApprovalRequest,
) => Promise<AgentToolApprovalResult>;

export type AgentToolApprovalInputRecord = {
  type: "agent-tool-approval";
  approvalId: string;
  toolCallId: string;
  decision: AgentToolApprovalDecision;
  grant: AgentToolApprovalGrant;
  targetPrefix?: string;
  targetKind?: AgentToolApprovalGrantKind;
  message?: string;
  at?: number;
};

export interface ToolContext {
  sandboxManager: SandboxManager;
  writer: UIMessageStreamWriter;
  userLocation: Geo;
  todoManager: TodoManager;
  userID: string;
  chatId: string;
  assistantMessageId?: string;
  fileAccumulator: FileAccumulator;
  backgroundProcessTracker: BackgroundProcessTracker;
  /** Manages interactive PTY sessions for `run_terminal_cmd` interactive actions. */
  ptySessionManager: PtySessionManager;
  mode: ChatMode;
  /** Configured model key for this request, used for model-aware tool capabilities. */
  modelName?: string;
  /** Returns the currently active stream model, including provider fallback legs. */
  getCurrentModelName?: () => string | undefined;
  subscription?: SubscriptionTier;
  isE2BSandbox: IsE2BSandboxFn;
  /** When set, run_terminal_cmd awaits this for each terminal chunk so the run yields and metadata delivery can happen in real time. */
  appendMetadataStream?: AppendMetadataStreamFn;
  /** Callback to report additional tool costs (in dollars) that should be added to the request's total cost. */
  onToolCost?: (costDollars: number) => void;
  /** Callback to report handled provider/tool failures to the request's host runtime. */
  onToolFailure?: ToolFailureLogger;
  /** Optional approval gate for mutating or command-executing agent tools. */
  requestToolApproval?: AgentToolApprovalRequester;
}
