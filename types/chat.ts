import { UIMessage } from "ai";
import { z } from "zod";
import { Id } from "@/convex/_generated/dataModel";
import type { FileDetails, FilePart } from "./file";

export type ChatMode = "agent" | "ask";

export const CHAT_MODES: readonly ChatMode[] = ["agent", "ask"];

export function isChatMode(value: string | null): value is ChatMode {
  return value !== null && (CHAT_MODES as readonly string[]).includes(value);
}

export type AgentPermissionMode = "full_access" | "ask_approval";

export const AGENT_PERMISSION_MODES: readonly AgentPermissionMode[] = [
  "full_access",
  "ask_approval",
];

export const DEFAULT_AGENT_PERMISSION_MODE: AgentPermissionMode = "full_access";

export function isAgentPermissionMode(
  value: unknown,
): value is AgentPermissionMode {
  return (
    typeof value === "string" &&
    (AGENT_PERMISSION_MODES as readonly string[]).includes(value)
  );
}

export function coerceAgentPermissionMode(value: unknown): AgentPermissionMode {
  return isAgentPermissionMode(value) ? value : DEFAULT_AGENT_PERMISSION_MODE;
}

export type SelectedModel =
  | "auto"
  | "hackerai-standard"
  | "hackerai-pro"
  | "hackerai-max";

export const SELECTABLE_MODELS: readonly SelectedModel[] = [
  "auto",
  "hackerai-standard",
  "hackerai-pro",
  "hackerai-max",
];

/**
 * Map of legacy ids to the current `SelectedModel` union. Covers two prior
 * shapes:
 *   1. Underlying-model ids from before the HackerAI tier rebrand.
 *   2. `hackerai-lite` from the short-lived first naming of the entry tier
 *      (renamed to `hackerai-standard` because Lite mis-described the entry tier).
 * Used by `coerceSelectedModel` to migrate values on read.
 */
export const LEGACY_MODEL_ID_MAP: Record<string, SelectedModel> = {
  "sonnet-4.6": "hackerai-pro",
  "opus-4.6": "hackerai-max",
  "gemini-3-flash": "hackerai-standard",
  "kimi-k2.6": "hackerai-standard",
  // Grok was removed from the picker before the tier rebrand. These variants
  // were entry-level alternatives to the auto router,
  // so map them to Standard rather than dropping the user's preference.
  "grok-4.1": "hackerai-standard",
  "grok-4.3": "hackerai-standard",
  "hackerai-lite": "hackerai-standard",
};

/**
 * Coerce any stored selected-model string into the current `SelectedModel`
 * union. Returns `null` if the value isn't recognized (caller should fall
 * back to "auto").
 */
export function coerceSelectedModel(
  value: string | null,
): SelectedModel | null {
  if (value === null) return null;
  if ((SELECTABLE_MODELS as readonly string[]).includes(value)) {
    return value as SelectedModel;
  }
  // Use Object.hasOwn (not the `in` operator) to avoid matching inherited
  // properties like "toString" or "constructor" if a hostile/garbage value
  // ever reaches this function via localStorage or the request body.
  if (Object.hasOwn(LEGACY_MODEL_ID_MAP, value)) {
    return LEGACY_MODEL_ID_MAP[value];
  }
  return null;
}

export function isSelectedModel(value: string | null): value is SelectedModel {
  return (
    value !== null && (SELECTABLE_MODELS as readonly string[]).includes(value)
  );
}

export type LimitRescueRequest = {
  type: "paid_daily_free_allowance";
};

export function isLimitRescueRequest(
  value: unknown,
): value is LimitRescueRequest {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "paid_daily_free_allowance"
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

export function normalizeSelectedModelForSubscription(
  model: SelectedModel | null | undefined,
  subscription: SubscriptionTier,
): SelectedModel {
  if (subscription === "free") return "auto";
  return model ?? "auto";
}

export function normalizeSelectedModelOverrideForSubscription(
  model: SelectedModel | null | undefined,
  subscription: SubscriptionTier,
): SelectedModel | undefined {
  if (subscription === "free") return "auto";
  return model ?? undefined;
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
    | "viewing"
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
  /** Media type for viewed multimodal files */
  mediaType?: string;
  /** File size for viewed multimodal files */
  sizeBytes?: number;
  /** File kind for viewed multimodal files */
  kind?: "image" | "pdf";
  /** Display filename returned by the file tool */
  filename?: string;
  /** Preview images for viewed images/PDF pages */
  previewFiles?: Array<FilePart & { page?: number }>;
  /** PDF pages rendered for this view action */
  renderedPages?: number[];
  /** Maximum PDF pages rendered for this view action */
  renderedPageLimit?: number;
  /** Whether the PDF view was truncated to the render limit */
  truncatedPages?: boolean;
  /** Total PDF page count when known */
  pageCount?: number;
  /** Non-fatal preview upload/render error */
  previewError?: string;
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
    sizeBytes?: number;
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

export const TODO_STATUS_VALUES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export type TodoStatus = (typeof TODO_STATUS_VALUES)[number];

export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
  sourceMessageId?: string;
}

export interface TodoBlockProps {
  todos: Todo[];
  inputTodos?: TodoWriteInput["todos"];
  blockId: string;
  messageId: string;
}

export interface TodoWriteInput {
  merge?: boolean;
  todos?: Array<{
    id: string;
    content?: string;
    status?: Todo["status"];
    sourceMessageId?: string;
  }>;
}

export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

export const messageMetadataSchema = z.object({
  feedbackType: z.enum(["positive", "negative"]).optional(),
  isAutoContinue: z.boolean().optional(),
  mode: z.enum(["agent", "ask"]).optional(),
  createdAt: z.number().optional(),
  generationStartedAt: z.number().optional(),
  generationTimeMs: z.number().optional(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

export type ChatMessage = UIMessage<MessageMetadata> & {
  createdAt?: number;
  fileDetails?: FileDetails[];
  sourceMessageId?: string;
};

export type RateLimitInfo = {
  remaining: number;
  resetTime: Date;
  limit: number;
  // Monthly token bucket details for paid users
  monthly?: { remaining: number; limit: number; resetTime: Date };
  // Included-bucket points deducted for potential refund on error
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
  /** Optional monthly extra-usage spending cap in dollars */
  monthlyCapDollars?: number;
  /** Extra-usage spend already consumed in the current month */
  monthlySpentDollars?: number;
  /** Remaining extra-usage spend allowed by the monthly cap */
  monthlyRemainingDollars?: number;
  /** Whether auto-reload is enabled (can use extra usage even with $0 balance) */
  autoReloadEnabled?: boolean;
}

export interface QueuedMessage {
  id: string;
  text: string;
  files?: import("@/types/file").FileMessagePart[];
  timestamp: number;
}

export type QueueBehavior = "queue" | "stop-and-send";

// "e2b" for cloud sandbox, "desktop" for Tauri desktop app, or a connectionId UUID for a specific local connection.
// Uses `string & {}` to preserve autocomplete for well-known values while allowing arbitrary strings.
export type SandboxPreference = "e2b" | "desktop" | (string & {});

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
