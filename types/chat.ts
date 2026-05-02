import { UIMessage } from "ai";
import { z } from "zod";
import { Id } from "@/convex/_generated/dataModel";
import type { FileDetails } from "./file";

export type ChatMode = "agent" | "ask";

export const CHAT_MODES: readonly ChatMode[] = ["agent", "ask"];

export function isChatMode(value: string | null): value is ChatMode {
  return value !== null && (CHAT_MODES as readonly string[]).includes(value);
}

export type SelectedModel =
  | "auto"
  | "sonnet-4.6"
  | "grok-4.1"
  | "grok-4.3"
  | "gemini-3-flash"
  | "opus-4.6"
  | "kimi-k2.6";
// | "codex-local"
// | `codex-local:${string}`;

export const SELECTABLE_MODELS: readonly SelectedModel[] = [
  "auto",
  "sonnet-4.6",
  "grok-4.1",
  "grok-4.3",
  "gemini-3-flash",
  "opus-4.6",
  "kimi-k2.6",
  // "codex-local",
];

/** Check if a model is a local Codex model (with or without sub-model) */
export function isCodexLocal(model: string | null): boolean {
  return (
    model === "codex-local" || (!!model && model.startsWith("codex-local:"))
  );
}

/** Extract the Codex sub-model (e.g., "gpt-5.3" from "codex-local:gpt-5.3") */
export function getCodexSubModel(model: string): string | undefined {
  if (model.startsWith("codex-local:")) {
    return model.slice("codex-local:".length);
  }
  return undefined;
}

export function isSelectedModel(value: string | null): value is SelectedModel {
  return (
    value !== null && (SELECTABLE_MODELS as readonly string[]).includes(value)
    // || isCodexLocal(value)
  );
}

export type SubscriptionTier = "free" | "pro" | "pro-plus" | "ultra" | "team";

export const SUBSCRIPTION_TIERS: readonly SubscriptionTier[] = [
  "free",
  "pro",
  "pro-plus",
  "ultra",
  "team",
];

export function isSubscriptionTier(value: unknown): value is SubscriptionTier {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_TIERS as readonly string[]).includes(value)
  );
}

export interface SidebarFile {
  path: string;
  content: string;
  language?: string;
  range?: {
    start: number;
    end?: number;
  };
  action?:
    | "reading"
    | "creating"
    | "editing"
    | "writing"
    | "searching"
    | "appending";
  toolCallId?: string;
  /** Whether the file operation is currently executing */
  isExecuting?: boolean;
  /** Original content before edit (for diff view) */
  originalContent?: string;
  /** Modified content after edit (for diff view) */
  modifiedContent?: string;
  /** Error message if the operation failed */
  error?: string;
}

export interface SidebarTerminal {
  command: string;
  output: string;
  isExecuting: boolean;
  isBackground?: boolean;
  /** Legacy run_terminal_cmd: input.interactive — true if PTY-backed session. */
  isInteractive?: boolean;
  /** E2B process ID (only for E2B sandboxes). */
  pid?: number | null;
  /** Local session identifier (only for local sandboxes). */
  session?: string | null;
  toolCallId: string;
  shellAction?: string;
  /** The raw input sent via the `send` action — string or array of tokens. */
  input?: string | string[];
  /** Raw PTY bytes for xterm.js rendering (preserves colors and cursor sequences). */
  rawBytes?: string;
}

export interface SidebarProxy {
  /** The proxy tool name, e.g. "list_requests", "send_request" */
  proxyAction: string;
  command: string;
  output: string;
  isExecuting: boolean;
  toolCallId: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
  date: string | null;
  lastUpdated: string | null;
}

export interface SidebarWebSearch {
  query: string;
  results: WebSearchResult[];
  isSearching: boolean;
  toolCallId: string;
}

export const VALID_NOTE_CATEGORIES = [
  "general",
  "findings",
  "methodology",
  "questions",
  "plan",
] as const;

export type NoteCategory = (typeof VALID_NOTE_CATEGORIES)[number];

export interface SidebarNote {
  note_id: string;
  title: string;
  content: string;
  category: NoteCategory;
  tags: string[];
  updated_at: number;
}

export interface SidebarNotes {
  action: "create" | "list" | "update" | "delete";
  notes: SidebarNote[];
  totalCount: number;
  isExecuting: boolean;
  toolCallId: string;
  /** For create/update/delete - the affected note title */
  affectedTitle?: string;
  /** For create - the new note ID */
  newNoteId?: string;
  /** For update - original note data before update (for before/after comparison) */
  original?: {
    title: string;
    content: string;
    category: string;
    tags: string[];
  };
  /** For update - modified note data after update (for before/after comparison) */
  modified?: {
    title: string;
    content: string;
    category: string;
    tags: string[];
  };
}

export interface SidebarSharedFiles {
  files: Array<{
    name: string;
    mediaType?: string;
    fileId?: string;
    s3Key?: string;
    storageId?: string;
  }>;
  requestedPaths: string[];
  isExecuting: boolean;
  toolCallId: string;
}

export type SidebarContent =
  | SidebarFile
  | SidebarTerminal
  | SidebarProxy
  | SidebarWebSearch
  | SidebarNotes
  | SidebarSharedFiles;

export const isSidebarFile = (
  content: SidebarContent,
): content is SidebarFile => {
  return "path" in content && !("requestedPaths" in content);
};

export const isSidebarTerminal = (
  content: SidebarContent,
): content is SidebarTerminal => {
  return "command" in content && !("proxyAction" in content);
};

export const isSidebarProxy = (
  content: SidebarContent,
): content is SidebarProxy => {
  return "proxyAction" in content;
};

export const isSidebarWebSearch = (
  content: SidebarContent,
): content is SidebarWebSearch => {
  return "results" in content && "query" in content;
};

export const isSidebarNotes = (
  content: SidebarContent,
): content is SidebarNotes => {
  return "notes" in content && "action" in content;
};

export const isSidebarSharedFiles = (
  content: SidebarContent,
): content is SidebarSharedFiles => {
  return "requestedPaths" in content;
};

export interface Todo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  sourceMessageId?: string;
}

export interface TodoBlockProps {
  todos: Todo[];
  inputTodos?: Todo[];
  blockId: string;
  messageId: string;
}

export interface TodoWriteInput {
  merge?: boolean;
  todos?: Todo[];
}

export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

export const messageMetadataSchema = z.object({
  feedbackType: z.enum(["positive", "negative"]).optional(),
  isAutoContinue: z.boolean().optional(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

export type ChatMessage = UIMessage<MessageMetadata> & {
  fileDetails?: FileDetails[];
  sourceMessageId?: string;
};

export type RateLimitInfo = {
  remaining: number;
  resetTime: Date;
  limit: number;
  // Monthly token bucket details for paid users
  monthly?: { remaining: number; limit: number; resetTime: Date };
  // Points deducted for potential refund on error (always = estimatedCost)
  pointsDeducted?: number;
  // Extra usage points deducted (only set when extra usage balance was used)
  extraUsagePointsDeducted?: number;
  // True when rate limiting was skipped (Redis not configured)
  rateLimitSkipped?: boolean;
};

export interface ExtraUsageConfig {
  enabled: boolean;
  /** Whether user has prepaid balance available */
  hasBalance?: boolean;
  /** Current balance in dollars (for UI display) */
  balanceDollars?: number;
  /** Whether auto-reload is enabled (can use extra usage even with $0 balance) */
  autoReloadEnabled?: boolean;
}

export interface QueuedMessage {
  id: string;
  text: string;
  files?: Array<{
    file: File;
    fileId: Id<"files">;
    url: string;
  }>;
  timestamp: number;
}

export type QueueBehavior = "queue" | "stop-and-send";

// "e2b" for cloud sandbox, "desktop" for Tauri desktop app, or a connectionId UUID for a specific local connection.
// Uses `string & {}` to preserve autocomplete for well-known values while allowing arbitrary strings.
export type SandboxPreference = "e2b" | "desktop" | (string & {});

/**
 * Memory entry returned by Convex memories queries
 */
export interface Memory {
  memory_id: string;
  content: string;
  update_time: number;
}

/**
 * Preview message for share dialog (full message structure with parts)
 */
export interface PreviewMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content?: string;
  parts: any[];
  fileDetails?: FileDetails[];
}

/**
 * Shared chat entry returned by getUserSharedChats query
 */
export interface SharedChat {
  _id: Id<"chats">;
  id: string;
  title: string;
  share_id: string;
  share_date: number;
  update_time: number;
}
