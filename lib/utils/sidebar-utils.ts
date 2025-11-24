import { SidebarContent, SidebarFile } from "@/types/chat";

interface MessagePart {
  type: string;
  toolCallId?: string;
  input?: any;
  output?: any;
  state?: string;
  [key: string]: any;
}

interface Message {
  role: string;
  parts?: MessagePart[];
  [key: string]: any;
}

export function extractAllSidebarContent(
  messages: Message[],
): SidebarContent[] {
  const contentList: SidebarContent[] = [];

  messages.forEach((message) => {
    if (message.role !== "assistant" || !message.parts) return;

    // Collect terminal output from data-terminal parts (for streaming)
    const terminalDataMap = new Map<string, string>();
    // Collect Python output from data-python parts (for streaming)
    const pythonDataMap = new Map<string, string>();

    message.parts.forEach((part) => {
      if (part.type === "data-terminal" && part.data?.toolCallId) {
        const toolCallId = part.data.toolCallId;
        const terminalOutput = part.data?.terminal || "";
        const existing = terminalDataMap.get(toolCallId) || "";
        terminalDataMap.set(toolCallId, existing + terminalOutput);
      }
      if (part.type === "data-python" && part.data?.toolCallId) {
        const toolCallId = part.data.toolCallId;
        const pythonOutput = part.data?.terminal || ""; // Python uses same 'terminal' field
        const existing = pythonDataMap.get(toolCallId) || "";
        pythonDataMap.set(toolCallId, existing + pythonOutput);
      }
    });

    message.parts.forEach((part) => {
      // Terminal
      if (part.type === "tool-run_terminal_cmd" && part.input?.command) {
        const command = part.input.command;

        // Get streaming output from data-terminal parts
        const streamingOutput =
          terminalDataMap.get(part.toolCallId || "") || "";

        // Extract output from result object (handles both new and legacy formats)
        const result = part.output?.result;
        let output = "";

        if (result) {
          // New format: result.output
          if (typeof result.output === "string") {
            output = result.output;
          }
          // Legacy format: result.stdout + result.stderr
          else if (result.stdout !== undefined || result.stderr !== undefined) {
            output = (result.stdout || "") + (result.stderr || "");
          }
          // If result is a string directly (fallback)
          else if (typeof result === "string") {
            output = result;
          }
        }

        // Fallback to streaming output or direct output property
        const finalOutput =
          output || streamingOutput || part.output?.output || "";

        contentList.push({
          command,
          output: finalOutput,
          isExecuting:
            part.state === "input-available" || part.state === "running",
          isBackground: part.input.is_background,
          toolCallId: part.toolCallId || "",
        });
      }

      // Python
      if (part.type === "tool-python" && part.input?.code) {
        const code = part.input.code;

        // Get streaming output from data-python parts
        const streamingOutput = pythonDataMap.get(part.toolCallId || "") || "";

        const result = part.output?.result;
        let output = "";

        if (result) {
          // New format: result.output
          if (typeof result.output === "string") {
            output = result.output;
          }
          // Legacy format: result.stdout + result.stderr
          else if (result.stdout !== undefined || result.stderr !== undefined) {
            output = (result.stdout || "") + (result.stderr || "");
          }
          // If result is a string directly (fallback)
          else if (typeof result === "string") {
            output = result;
          }
        }

        const finalOutput =
          output || streamingOutput || part.output?.output || "";

        contentList.push({
          code,
          output: finalOutput,
          isExecuting:
            part.state === "input-available" || part.state === "running",
          toolCallId: part.toolCallId || "",
        });
      }

      // File Operations - only extract when output is available
      // This ensures content is ready when auto-following
      if (
        (part.type === "tool-read_file" ||
          part.type === "tool-write_file" ||
          part.type === "tool-search_replace" ||
          part.type === "tool-multi_edit") &&
        part.state === "output-available"
      ) {
        const fileInput = part.input;
        if (!fileInput) return;

        const filePath =
          fileInput.file_path || fileInput.path || fileInput.target_file || "";
        if (!filePath) return;

        let action: SidebarFile["action"] = "reading";
        let content = "";
        let range = undefined;

        if (part.type === "tool-read_file") {
          action = "reading";
          // Extract result - handle both string and object formats
          const result = part.output?.result;
          let rawContent = "";

          if (typeof result === "string") {
            rawContent = result;
          } else if (result && typeof result === "object") {
            // If result is an object, try to extract content
            rawContent = result.content || result.text || result.result || "";
          }

          // Clean line numbers from read output (only if we have content)
          if (rawContent) {
            content = rawContent.replace(/^\s*\d+\|/gm, "");
          }

          if (fileInput.offset && fileInput.limit) {
            range = {
              start: fileInput.offset,
              end: fileInput.offset + fileInput.limit - 1,
            };
          }
        } else if (part.type === "tool-write_file") {
          action = "writing";
          content = fileInput.contents || fileInput.content || "";
        } else if (
          part.type === "tool-search_replace" ||
          part.type === "tool-multi_edit"
        ) {
          action = "editing";
          // Extract result - handle both string and object formats
          const result = part.output?.result;
          if (typeof result === "string") {
            content = result;
          } else if (result && typeof result === "object") {
            content = result.content || result.text || result.result || "";
          } else {
            content = "";
          }
        }

        contentList.push({
          path: filePath,
          content,
          range,
          action,
          toolCallId: part.toolCallId || "",
        });
      }
    });
  });

  return contentList;
}
