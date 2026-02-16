import { UIMessage } from "ai";
import { z } from "zod";
import { Id } from "@/convex/_generated/dataModel";
import type { FileDetails } from "./file";

export type ChatMode = "agent" | "agent-long" | "ask";

export const CHAT_MODES: readonly ChatMode[] = ["agent", "agent-long", "ask"];

export function isChatMode(value: string | null): value is ChatMode {
  return value !== null && (CHAT_MODES as readonly string[]).includes(value);
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
  /** E2B process ID (only for E2B sandboxes). */
  pid?: number | null;
  /** Local session identifier (only for local sandboxes). */
  session?: string | null;
  toolCallId: string;
  shellAction?: string;
  /** The raw input text sent via the `send` action. */
  input?: string;
}

export interface SidebarPython {
  code: string;
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

export type SidebarContent =
  | SidebarFile
  | SidebarTerminal
  | SidebarPython
  | SidebarWebSearch
  | SidebarNotes;

export const isSidebarFile = (
  content: SidebarContent,
): content is SidebarFile => {
  return "path" in content;
};

export const isSidebarTerminal = (
  content: SidebarContent,
): content is SidebarTerminal => {
  return "command" in content && !("code" in content);
};

export const isSidebarPython = (
  content: SidebarContent,
): content is SidebarPython => {
  return "code" in content;
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
  feedbackType: z.enum(["positive", "negative"]),
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
  // Token bucket details for paid users (session = daily, weekly = weekly)
  session?: { remaining: number; limit: number; resetTime: Date };
  weekly?: { remaining: number; limit: number; resetTime: Date };
  // Points deducted for potential refund on error (always = estimatedCost)
  pointsDeducted?: number;
  // Extra usage points deducted (only set when extra usage balance was used)
  extraUsagePointsDeducted?: number;
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

// Sandbox preference: "e2b" for cloud, or a connection ID for local sandbox
export type SandboxPreference = "e2b" | string;

/**
 * Memory entry returned by Convex memories queries
 */
export interface Memory {
  memory_id: string;
  content: string;
  update_time: number;
}

/**
 * Preview message for share dialog (simplified message structure)
 */
export interface PreviewMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content?: string;
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
