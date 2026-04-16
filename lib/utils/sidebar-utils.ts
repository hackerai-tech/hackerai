import {
  SidebarContent,
  SidebarFile,
  SidebarNote,
  SidebarNotes,
  WebSearchResult,
} from "@/types/chat";

/** Parse a unified git diff into original and modified content for diff view. */
function parseGitDiff(diff: string): {
  originalContent: string;
  modifiedContent: string;
} | null {
  if (!diff) return null;
  const lines = diff.split("\n");
  const original: string[] = [];
  const modified: string[] = [];
  let inHunk = false;
  for (const line of lines) {
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file")
    )
      continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("-")) original.push(line.slice(1));
    else if (line.startsWith("+")) modified.push(line.slice(1));
    else if (line.startsWith(" ")) {
      original.push(line.slice(1));
      modified.push(line.slice(1));
    }
  }
  if (original.length === 0 && modified.length === 0) return null;
  return {
    originalContent: original.join("\n"),
    modifiedContent: modified.join("\n"),
  };
}

interface MessagePart {
  type: string;
  toolCallId?: string;
  input?: any;
  output?: any;
  state?: string;
  [key: string]: any;
}

export interface Message {
  role: string;
  parts?: MessagePart[];
  [key: string]: any;
}

/**
 * Extract sidebar content from a single message. Exported for incremental processing
 * (e.g. only reprocess the last message during streaming).
 */
export function extractSidebarContentFromMessage(
  message: Message,
): SidebarContent[] {
  const contentList: SidebarContent[] = [];
  if (message.role !== "assistant" || !message.parts) return contentList;

  // Collect terminal output from data-terminal parts (for streaming)
  const terminalDataMap = new Map<string, string>();
  // Collect diff data from data-diff parts (for search_replace UI-only diff display)
  const diffDataMap = new Map<
    string,
    { originalContent: string; modifiedContent: string }
  >();

  message.parts.forEach((part) => {
    if (part.type === "data-terminal" && part.data?.toolCallId) {
      const toolCallId = part.data.toolCallId;
      const terminalOutput = part.data?.terminal || "";
      const existing = terminalDataMap.get(toolCallId) || "";
      terminalDataMap.set(toolCallId, existing + terminalOutput);
    }
    if (part.type === "data-diff" && part.data?.toolCallId) {
      const toolCallId = part.data.toolCallId;
      diffDataMap.set(toolCallId, {
        originalContent: part.data.originalContent || "",
        modifiedContent: part.data.modifiedContent || "",
      });
    }
  });

  message.parts.forEach((part) => {
    // Terminal (including Codex local commands)
    if (part.type === "tool-run_terminal_cmd" && part.input?.command) {
      const command = part.input.command;

      // Get streaming output from data-terminal parts
      const streamingOutput = terminalDataMap.get(part.toolCallId || "") || "";

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

    // Generic Codex tools (tool-codex_*) — route to correct sidebar type
    if (typeof part.type === "string" && part.type.startsWith("tool-codex_")) {
      const input = part.input || {};
      const itemType =
        input.codexItemType || part.type.replace("tool-codex_", "");
      const isExec =
        part.state === "input-available" || part.state === "running";

      if (itemType === "webSearch") {
        // Web search → SidebarWebSearch
        const query =
          part.output?.query || input.toolLabel || input.query || "web search";
        const action = part.output?.action;
        const queries: string[] = action?.queries || [];
        const results: WebSearchResult[] = queries.map((q: string) => ({
          title: q,
          url: "",
          content: "",
          date: null,
          lastUpdated: null,
        }));
        contentList.push({
          query,
          results,
          isSearching: isExec,
          toolCallId: part.toolCallId || "",
        });
      } else if (itemType === "fileChange") {
        // File change → SidebarFile
        const filePath =
          part.output?.path || input.path || input.file || "file";
        const changeAction = part.output?.action || input.action || "edit";
        const actionMap: Record<string, string> = {
          add: "writing",
          update: "editing",
          delete: "reading",
        };
        const rawDiff = part.output?.diff || input.diff || "";
        const parsed = parseGitDiff(rawDiff);
        contentList.push({
          path: filePath,
          content:
            parsed?.modifiedContent || rawDiff || part.output?.output || "",
          action: (actionMap[changeAction] || "editing") as
            | "writing"
            | "editing"
            | "reading",
          toolCallId: part.toolCallId || "",
          isExecuting: isExec,
          originalContent: parsed?.originalContent,
          modifiedContent: parsed?.modifiedContent,
        });
      } else {
        // Commands and unknown types → SidebarTerminal
        const command =
          input.command || input.toolLabel || input.path || itemType;
        const streamingOutput =
          terminalDataMap.get(part.toolCallId || "") || "";
        const completedOutput = part.output?.output || part.output?.diff || "";
        contentList.push({
          command,
          output: completedOutput || streamingOutput || "",
          isExecuting: isExec,
          isBackground: false,
          toolCallId: part.toolCallId || "",
        });
      }
    }

    // Shell tool (new interactive PTY-based shell)
    if (part.type === "tool-shell" && part.input) {
      const command = part.input.command || part.input.brief || "";

      // Skip if no command/brief available yet (input still streaming)
      if (!command) return;

      // Get streaming output from data-terminal parts
      const streamingOutput = terminalDataMap.get(part.toolCallId || "") || "";

      // Shell tool returns { output: string } directly (not nested in result)
      const directOutput =
        typeof part.output?.output === "string" ? part.output.output : "";

      const finalOutput = directOutput || streamingOutput || "";

      contentList.push({
        command,
        output: finalOutput,
        isExecuting:
          part.state === "input-available" || part.state === "running",
        isBackground: false,
        toolCallId: part.toolCallId || "",
        shellAction: part.input.action,
        pid: part.input.pid ?? part.output?.pid,
        session: part.input.session ?? part.output?.session,
        input: part.input.input,
      });
    }

    // HTTP Request
    if (part.type === "tool-http_request" && part.input?.url) {
      const method = part.input.method || "GET";
      const url = part.input.url;
      const command = `${method} ${url}`;

      // Get streaming output from data-terminal parts (HTTP uses same streaming mechanism)
      const streamingOutput = terminalDataMap.get(part.toolCallId || "") || "";

      // Extract output from result
      let output = "";
      if (part.output) {
        output = part.output.output || part.output.error || "";
      }

      const finalOutput = output || streamingOutput || "";

      contentList.push({
        command,
        output: finalOutput,
        isExecuting:
          part.state === "input-available" || part.state === "running",
        isBackground: false,
        toolCallId: part.toolCallId || "",
      });
    }

    // Web Search - extract at input-available for auto-follow, and output-available for results
    if (part.type === "tool-web_search" && part.state === "input-available") {
      const queries = part.input?.queries || [];
      const query = Array.isArray(queries) ? queries.join(", ") : queries;
      if (query) {
        contentList.push({
          query,
          results: [],
          isSearching: true,
          toolCallId: part.toolCallId || "",
        });
      }
    }

    if (part.type === "tool-web_search" && part.state === "output-available") {
      const queries = part.input?.queries || [];
      const query = Array.isArray(queries) ? queries.join(", ") : queries;

      let results: WebSearchResult[] = [];
      if (part.output) {
        // Handle both formats: output as array directly, or output.result as array
        const rawResults = Array.isArray(part.output)
          ? part.output
          : part.output.result;
        if (Array.isArray(rawResults)) {
          results = rawResults.map((r: WebSearchResult) => ({
            title: r.title || "",
            url: r.url || "",
            content: r.content || "",
            date: r.date || null,
            lastUpdated: r.lastUpdated || null,
          }));
        }
      }

      contentList.push({
        query,
        results,
        isSearching: false,
        toolCallId: part.toolCallId || "",
      });
    }

    // File tool streaming - extract during input-streaming/input-available
    // so sidebar auto-follow works for file operations (like terminals)
    if (
      part.type === "tool-file" &&
      (part.state === "input-streaming" || part.state === "input-available")
    ) {
      const fileInput = part.input;
      if (fileInput?.path) {
        const fileAction = fileInput.action as string;
        if (fileAction === "write" || fileAction === "append") {
          contentList.push({
            path: fileInput.path,
            content: fileInput.text || "",
            action: fileAction === "write" ? "creating" : "appending",
            toolCallId: part.toolCallId || "",
            isExecuting: true,
          });
        } else if (
          part.state === "input-available" &&
          (fileAction === "read" || fileAction === "edit")
        ) {
          const range =
            fileAction === "read" && fileInput.range
              ? {
                  start: fileInput.range[0],
                  end:
                    fileInput.range[1] === -1 ? undefined : fileInput.range[1],
                }
              : undefined;
          contentList.push({
            path: fileInput.path,
            content: "",
            range,
            action: fileAction === "read" ? "reading" : "editing",
            toolCallId: part.toolCallId || "",
            isExecuting: true,
          });
        }
      }
    }

    // File Operations - extract at input-available for early auto-follow
    if (
      (part.type === "tool-read_file" ||
        part.type === "tool-search_replace" ||
        part.type === "tool-multi_edit") &&
      part.state === "input-available"
    ) {
      const fileInput = part.input;
      const filePath =
        fileInput?.file_path || fileInput?.path || fileInput?.target_file || "";
      if (filePath) {
        const action: SidebarFile["action"] =
          part.type === "tool-read_file" ? "reading" : "editing";
        let range = undefined;
        if (
          part.type === "tool-read_file" &&
          fileInput.offset &&
          fileInput.limit
        ) {
          range = {
            start: fileInput.offset,
            end: fileInput.offset + fileInput.limit - 1,
          };
        }
        contentList.push({
          path: filePath,
          content: "",
          range,
          action,
          toolCallId: part.toolCallId || "",
          isExecuting: true,
        });
      }
    }

    // File Operations - extract when output is available with full content
    if (
      (part.type === "tool-read_file" ||
        part.type === "tool-write_file" ||
        part.type === "tool-search_replace" ||
        part.type === "tool-multi_edit" ||
        part.type === "tool-file") &&
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
      let originalContent: string | undefined;
      let modifiedContent: string | undefined;

      if (part.type === "tool-file") {
        // New unified file tool
        const fileAction = fileInput.action as string;
        const actionMap: Record<string, SidebarFile["action"]> = {
          read: "reading",
          write: "writing",
          append: "appending",
          edit: "editing",
        };
        action = actionMap[fileAction] || "reading";

        if (fileAction === "read") {
          // Output is an object with originalContent (raw content without line numbers)
          const output = part.output;
          if (
            typeof output === "object" &&
            output !== null &&
            "originalContent" in output
          ) {
            content = (output.originalContent as string) || "";
          }

          if (fileInput.range) {
            const [start, end] = fileInput.range;
            range = {
              start,
              end: end === -1 ? undefined : end,
            };
          }
        } else if (fileAction === "write") {
          content = fileInput.text || "";
        } else if (fileAction === "append") {
          // Output is now an object with originalContent (modifiedContent computed from input.text)
          const output = part.output;
          const appendedText = fileInput.text || "";

          if (
            typeof output === "object" &&
            output !== null &&
            "originalContent" in output
          ) {
            // New format: object with originalContent, compute modifiedContent (no auto newline)
            originalContent = output.originalContent as string;
            const computedModified = originalContent + appendedText;
            modifiedContent = computedModified;
            content = computedModified;
          } else {
            // Fallback: no original content, just show appended text
            originalContent = "";
            modifiedContent = appendedText;
            content = appendedText;
          }
        } else if (fileAction === "edit") {
          // Output is now an object with originalContent and modifiedContent
          const output = part.output;

          if (
            typeof output === "object" &&
            output !== null &&
            "originalContent" in output &&
            "modifiedContent" in output
          ) {
            // New format: object with diff data
            originalContent = output.originalContent as string;
            modifiedContent = output.modifiedContent as string;
            content = modifiedContent || "";
          } else if (typeof output === "string") {
            // Fallback: old string format
            const lines = output.split("\n");
            const contentLines = lines
              .slice(2)
              .map((line: string) => line.replace(/^\d+\t/, ""));
            content = contentLines.join("\n");
          }
        }
      } else if (part.type === "tool-read_file") {
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

      // For search_replace, try to get diff data from data-diff parts (not persisted across reloads)
      if (part.type === "tool-search_replace" && part.toolCallId) {
        const streamedDiff = diffDataMap.get(part.toolCallId);
        if (streamedDiff) {
          originalContent = streamedDiff.originalContent;
          modifiedContent = streamedDiff.modifiedContent;
        }
      }

      contentList.push({
        path: filePath,
        content: modifiedContent || content,
        range,
        action,
        toolCallId: part.toolCallId || "",
        originalContent,
        modifiedContent,
        isExecuting: false,
      });
    }

    // Shared files (get_terminal_files)
    if (part.type === "tool-get_terminal_files") {
      const requestedPaths: string[] = part.input?.files || [];

      // Seed from persisted message.fileDetails so sidebar shows files after reload
      const persistedFiles = (message.fileDetails as any[] | undefined) || [];
      const files = persistedFiles.map((f: any) => ({
        name: f.name || "",
        mediaType: f.mediaType,
        fileId: f.fileId,
        s3Key: f.s3Key,
        storageId: f.storageId,
      }));

      contentList.push({
        files,
        requestedPaths,
        isExecuting:
          part.state === "input-available" || part.state === "input-streaming",
        toolCallId: part.toolCallId || "",
      });
    }

    // Proxy tools (Caido)
    const proxyToolTypes = [
      "tool-list_requests",
      "tool-view_request",
      "tool-send_request",
      "tool-scope_rules",
      "tool-list_sitemap",
      "tool-view_sitemap_entry",
    ];

    if (proxyToolTypes.includes(part.type)) {
      const toolName = part.type.replace("tool-", "");
      const proxyInput = part.input || {};
      const cmdParts: string[] = [toolName];
      if (proxyInput.request_id) cmdParts.push(`id:${proxyInput.request_id}`);
      if (proxyInput.method && proxyInput.url)
        cmdParts.push(`${proxyInput.method} ${proxyInput.url}`);
      if (proxyInput.httpql_filter)
        cmdParts.push(`filter:"${proxyInput.httpql_filter}"`);
      if (proxyInput.action) cmdParts.push(proxyInput.action);
      if (proxyInput.entry_id) cmdParts.push(`entry:${proxyInput.entry_id}`);
      const command = cmdParts.join(" ");

      let output = "";
      if (part.errorText) {
        output = `Error: ${part.errorText}`;
      } else if (part.output?.result?.error) {
        output = `Error: ${part.output.result.error}`;
      } else if (part.output?.result) {
        try {
          output = JSON.stringify(part.output.result, null, 2);
        } catch {
          output = String(part.output.result);
        }
      }

      contentList.push({
        proxyAction: toolName,
        command,
        output,
        isExecuting:
          part.state === "input-available" || part.state === "running",
        toolCallId: part.toolCallId || "",
      });
    }

    // Notes tools
    const notesToolTypes = [
      "tool-create_note",
      "tool-list_notes",
      "tool-update_note",
      "tool-delete_note",
    ];

    if (notesToolTypes.includes(part.type)) {
      const toolName = part.type.replace("tool-", "") as
        | "create_note"
        | "list_notes"
        | "update_note"
        | "delete_note";

      const actionMap: Record<string, SidebarNotes["action"]> = {
        create_note: "create",
        list_notes: "list",
        update_note: "update",
        delete_note: "delete",
      };

      const action = actionMap[toolName] || "list";
      const input = part.input || {};
      const result = part.output?.result || part.output || {};

      let notes: SidebarNote[] = [];
      let totalCount = 0;
      let affectedTitle: string | undefined;
      let newNoteId: string | undefined;
      let original: SidebarNotes["original"];
      let modified: SidebarNotes["modified"];

      if (action === "list" && result?.notes) {
        notes = result.notes;
        totalCount = result.total_count || notes.length;
      } else if (action === "create" && input) {
        notes = [
          {
            note_id: result?.note_id || "pending",
            title: input.title || "",
            content: input.content || "",
            category: input.category || "general",
            tags: input.tags || [],
            updated_at: Date.now(),
          },
        ];
        totalCount = 1;
        affectedTitle = input.title;
        newNoteId = result?.note_id;
      } else if (action === "update") {
        // For update, use original/modified for before/after comparison
        original = result?.original;
        modified = result?.modified;
        affectedTitle = modified?.title || input?.title || input?.note_id;
        totalCount = 1;
      } else if (action === "delete") {
        affectedTitle = result?.deleted_title || input?.note_id;
        totalCount = 0;
      }

      contentList.push({
        action,
        notes,
        totalCount,
        isExecuting: part.state !== "output-available",
        toolCallId: part.toolCallId || "",
        affectedTitle,
        newNoteId,
        original,
        modified,
      });
    }
  });

  return contentList;
}

export function extractAllSidebarContent(
  messages: Message[],
): SidebarContent[] {
  return messages.flatMap(extractSidebarContentFromMessage);
}
