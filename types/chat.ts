export type ChatMode = "agent" | "ask";

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
  toolCallId: string;
}

export type SidebarContent = SidebarFile | SidebarTerminal;

export const isSidebarFile = (
  content: SidebarContent,
): content is SidebarFile => {
  return "path" in content;
};

export const isSidebarTerminal = (
  content: SidebarContent,
): content is SidebarTerminal => {
  return "command" in content;
};

export interface Todo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface TodoBlockProps {
  todos: Todo[];
  inputTodos?: Todo[];
  blockId: string;
  messageId: string;
}
