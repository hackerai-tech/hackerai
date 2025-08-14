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
