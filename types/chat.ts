import { UIMessage } from "ai";
import { z } from "zod";
import { Id } from "@/convex/_generated/dataModel";
import type { FileDetails } from "./file";

export type ChatMode = "agent" | "ask";

export type SubscriptionTier = "free" | "pro" | "ultra" | "team";

export interface SidebarFile {
  path: string;
  content: string;
  language?: string;
  range?: {
    start: number;
    end: number;
  };
  action?: "reading" | "creating" | "editing" | "writing" | "searching";
  toolCallId?: string;
  /** Original content before edit (for diff view) */
  originalContent?: string;
  /** Modified content after edit (for diff view) */
  modifiedContent?: string;
}

export type ShellAction = "view" | "exec" | "wait" | "send" | "kill";

export interface SidebarTerminal {
  command: string;
  output: string;
  isExecuting: boolean;
  isBackground?: boolean;
  showContentOnly?: boolean;
  pid?: number | null;
  toolCallId: string;
  /** Shell action type for correct action text display */
  shellAction?: ShellAction;
  /** Session name for display in sidebar header */
  sessionName?: string;
}

export interface SidebarPython {
  code: string;
  output: string;
  isExecuting: boolean;
  toolCallId: string;
}

export type SidebarContent = SidebarFile | SidebarTerminal | SidebarPython;

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
};

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
