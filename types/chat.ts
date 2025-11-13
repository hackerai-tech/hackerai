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
  action?: "reading" | "creating" | "editing" | "writing";
}

export interface SidebarTerminal {
  command: string;
  output: string;
  isExecuting: boolean;
  isBackground?: boolean;
  pid?: number | null;
  toolCallId: string;
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
