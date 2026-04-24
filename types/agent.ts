import type { Sandbox } from "@e2b/code-interpreter";
import type { UIMessageStreamWriter } from "ai";
import type { Geo } from "@vercel/functions";
import type { TodoManager } from "@/lib/ai/tools/utils/todo-manager";
import { FileAccumulator } from "@/lib/ai/tools/utils/file-accumulator";
import type { BackgroundProcessTracker } from "@/lib/ai/tools/utils/background-process-tracker";
import type { ChatMode } from "./chat";
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
  getSandboxType(toolName: string): SandboxType | undefined;
  getSandboxInfo(): SandboxInfo | null;
  // Optional: only HybridSandboxManager implements this
  consumeFallbackInfo?(): SandboxFallbackInfo | null;
  /** Get the effective sandbox preference after any fallbacks (e.g. "e2b" or connectionId). */
  getEffectivePreference(): string;
  /** Track consecutive sandbox health failures across all tools. Returns true if the limit has been exceeded. */
  recordHealthFailure(): boolean;
  /** Reset the health failure counter (call on successful health check). */
  resetHealthFailures(): void;
  /** Check if the sandbox has been marked as permanently unavailable for this session. */
  isSandboxUnavailable(): boolean;
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

export type CaidoErrorKind =
  | "install_failed"
  | "start_timeout"
  | "auth_failed"
  | "external_unreachable"
  | "setup_failed"
  | "unknown";

export interface CaidoReadyInfo {
  path:
    | "fast"
    | "needs_start"
    | "external"
    | "locked_wait"
    | "locked_wait_error"
    | "cached_ready"
    | "windows_unsupported"
    | "setup_error";
  duration_ms: number;
  initial_script_ms?: number;
  background_start_ms?: number;
  health_poll_ms?: number;
  reauth_script_ms?: number;
  /**
   * Bounded error classification for telemetry. Raw error messages are never
   * written to the wide event — they may contain local hostnames, ports, or
   * stderr content from caido-cli. Full messages are available in console.warn
   * for debugging only.
   */
  error_kind?: CaidoErrorKind;
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
  mode: ChatMode;
  isE2BSandbox: IsE2BSandboxFn;
  guardrailsConfig?: string;
  /** Whether the Caido proxy is enabled (default true). When false, proxy tools are hidden and HTTP_PROXY env vars are not injected. */
  caidoEnabled: boolean;
  /** Custom Caido port for local sandbox users with an existing instance (default: 48080). */
  caidoPort?: number;
  /** When set, run_terminal_cmd awaits this for each terminal chunk so the run yields and metadata delivery can happen in real time. */
  appendMetadataStream?: AppendMetadataStreamFn;
  /** Callback to report additional tool costs (in dollars) that should be added to the request's total cost. */
  onToolCost?: (costDollars: number) => void;
  /** Called when Caido proxy setup completes (or fails). First call in a request captures the real cost; later calls measure lock-wait time. */
  onCaidoReady?: (info: CaidoReadyInfo) => void;
}
