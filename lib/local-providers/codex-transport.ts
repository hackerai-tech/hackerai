"use client";

import type { UIMessage } from "ai";
import { buildLocalSystemPrompt, buildNotesContext } from "@/lib/system-prompt";
import type { UserCustomization } from "@/types";

/**
 * UIMessageChunk types that useChat() expects from a ChatTransport.
 */
type UIMessageChunk =
  | { type: "start"; messageId?: string }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | {
      type: "tool-input-available";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | { type: "tool-output-available"; toolCallId: string; output: unknown }
  | { type: "data-part-start"; id: string; dataType: string }
  | { type: "data-part-delta"; id: string; delta: string }
  | { type: "data-part-available"; id: string; dataType: string; data: unknown }
  | { type: "start-step" }
  | { type: "finish-step" }
  | { type: "finish"; finishReason?: string }
  | { type: "error"; errorText: string };

interface ChatTransportSendOptions {
  trigger: "submit-message" | "regenerate-message";
  chatId: string;
  messageId: string | undefined;
  messages: UIMessage[];
  abortSignal: AbortSignal | undefined;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface ChatTransportReconnectOptions {
  chatId: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

function extractPrompt(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      const textParts = msg.parts
        ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text);
      if (textParts && textParts.length > 0) {
        return textParts.join("\n");
      }
    }
  }
  return "";
}

/** Data needed to build the user-specific system prompt */
export interface LocalPromptData {
  userCustomization?: UserCustomization | null;
  notes?: Array<{ title: string; content: string; category: string }>;
  model?: string;
  cmdServerPort?: number;
  cmdServerToken?: string;
}

/**
 * Custom ChatTransport that communicates with `codex app-server` (stdio mode)
 * via Tauri IPC:
 *   - invoke("codex_rpc_send") → writes JSON-RPC to app-server stdin
 *   - listen("codex-rpc-event") → receives JSON-RPC from app-server stdout
 *
 * No WebSocket, no HTTP, no CSP issues. Works offline.
 */
export class CodexLocalTransport {
  private initialized = false;
  private threadIds = new Map<string, string>();
  private currentModel: string | undefined;
  private promptData: LocalPromptData = {};
  private rpcId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (result: any) => void; reject: (error: any) => void }
  >();
  private eventUnlisten: (() => void) | null = null;
  private notificationHandler: ((method: string, params: any) => void) | null =
    null;

  /** Set the Codex model to use (e.g., "gpt-5.4" from "codex-local:gpt-5.4") */
  setModel(model: string | undefined) {
    this.currentModel = model;
  }

  /** Set user-specific data for building the system prompt */
  setUserData(data: LocalPromptData) {
    this.promptData = data;
  }

  /** Restore a thread ID from persisted chat data (e.g., on page reload) */
  restoreThread(chatId: string, threadId: string) {
    if (!this.threadIds.has(chatId)) {
      this.threadIds.set(chatId, threadId);
      console.log(
        "[CodexTransport] Restored thread:",
        threadId,
        "for chat:",
        chatId,
      );
    }
  }

  /** Get the current thread ID for a chat (for persisting to Convex) */
  getThreadId(chatId: string): string | undefined {
    return this.threadIds.get(chatId);
  }

  /**
   * Start listening for codex-rpc-event from Tauri.
   * Each event payload is a JSON-RPC message string from app-server stdout.
   */
  async startListening(): Promise<void> {
    if (this.eventUnlisten) return;

    const { listen } = await import("@tauri-apps/api/event");
    this.eventUnlisten = await listen<string>("codex-rpc-event", (event) => {
      try {
        const msg = JSON.parse(event.payload);

        // Response to a request (has id field)
        if ("id" in msg && this.pendingRequests.has(msg.id)) {
          const pending = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message || "RPC error"));
          } else {
            pending.resolve(msg.result);
          }
          return;
        }

        // Notification (no id field) — forward to current handler
        if (msg.method && this.notificationHandler) {
          this.notificationHandler(msg.method, msg.params || {});
        }
      } catch (err) {
        console.warn("[CodexTransport] Failed to parse event:", err);
      }
    });

    console.log("[CodexTransport] Listening for Tauri events");
  }

  async sendMessages(
    options: ChatTransportSendOptions,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const { messages, chatId, abortSignal } = options;
    const prompt = extractPrompt(messages);

    console.log("[CodexTransport] sendMessages", {
      chatId,
      promptPreview: prompt.slice(0, 100),
    });

    if (!prompt) return this.errorStream("No prompt provided");

    // Ensure event listener is active
    await this.startListening();

    // Initialize handshake (first time only)
    if (!this.initialized) {
      try {
        console.log("[CodexTransport] Initializing...");
        await this.rpcRequest("initialize", {
          clientInfo: {
            name: "hackerai",
            title: "HackerAI Desktop",
            version: "0.1.0",
          },
        });
        this.rpcNotify("initialized", {});
        this.initialized = true;
        console.log("[CodexTransport] Initialized");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // "Already initialized" means the process survived HMR — treat as success
        if (msg.includes("Already initialized")) {
          console.log(
            "[CodexTransport] Already initialized (process survived reload)",
          );
          this.initialized = true;
        } else {
          return this.errorStream(`Initialize failed: ${msg}`);
        }
      }
    }

    let partCounter = 0;
    let currentTextId: string | null = null;
    let currentReasoningId: string | null = null;
    let hasStarted = false;
    let turnId: string | null = null;
    let streamClosed = false;
    // Accumulate tool output for tool-output-available on completion
    const toolOutputBuffers = new Map<string, string>();
    // Track last fileChange toolCallId to update with turn/diff/updated
    let lastFileChangeToolCallId: string | null = null;

    const safeEnqueue = (
      controller: ReadableStreamDefaultController<UIMessageChunk>,
      chunk: UIMessageChunk,
    ) => {
      if (!streamClosed) controller.enqueue(chunk);
    };
    const safeClose = (
      controller: ReadableStreamDefaultController<UIMessageChunk>,
    ) => {
      if (!streamClosed) {
        streamClosed = true;
        controller.close();
      }
    };

    return new ReadableStream<UIMessageChunk>({
      start: async (controller) => {
        try {
          // Start or resume thread
          const existingThreadId = this.threadIds.get(chatId);
          let threadId: string;

          if (existingThreadId) {
            threadId = existingThreadId;
            console.log("[CodexTransport] Reusing thread:", threadId);
          } else {
            const instructions = buildLocalSystemPrompt({
              ...this.promptData,
            });
            console.log(
              "[CodexTransport] Starting thread with model:",
              this.currentModel || "gpt-5.4 (default)",
            );
            const result = await this.rpcRequest("thread/start", {
              model: this.currentModel || "gpt-5.4",
              developerInstructions: instructions,
              approvalPolicy: "never",
              sandbox: "danger-full-access",
            });
            threadId = result?.thread?.id;
            if (!threadId) {
              safeEnqueue(controller, {
                type: "error",
                errorText: "Failed to start thread",
              });
              safeClose(controller);
              return;
            }
            this.threadIds.set(chatId, threadId);
            console.log("[CodexTransport] Thread started:", threadId);
          }

          // Set up notification handler for this turn
          this.notificationHandler = (method, params) => {
            console.log(
              "[CodexTransport] ←",
              method,
              JSON.stringify(params).slice(0, 500),
            );
            switch (method) {
              case "turn/started": {
                turnId = params.turn?.id;
                if (!hasStarted) {
                  hasStarted = true;
                  safeEnqueue(controller, { type: "start" });
                  safeEnqueue(controller, { type: "start-step" });
                }
                break;
              }

              case "item/agentMessage/delta": {
                const delta = params.delta || params.textDelta;
                if (delta) {
                  if (!currentTextId) {
                    currentTextId = `codex-part-${partCounter++}`;
                    if (!hasStarted) {
                      hasStarted = true;
                      safeEnqueue(controller, { type: "start" });
                      safeEnqueue(controller, { type: "start-step" });
                    }
                    safeEnqueue(controller, {
                      type: "text-start",
                      id: currentTextId,
                    });
                  }
                  safeEnqueue(controller, {
                    type: "text-delta",
                    id: currentTextId,
                    delta,
                  });
                }
                break;
              }

              case "item/started": {
                const item = params.item;
                if (!item) break;

                if (!hasStarted) {
                  hasStarted = true;
                  safeEnqueue(controller, { type: "start" });
                  safeEnqueue(controller, { type: "start-step" });
                }

                // Skip non-tool items — they're handled via delta events or are just echoes
                if (
                  item.type === "agentMessage" ||
                  item.type === "reasoning" ||
                  item.type === "userMessage"
                )
                  break;

                // Generic handler for ALL Codex tool types (command, file, mcp, etc.)
                if (currentTextId) {
                  safeEnqueue(controller, {
                    type: "text-end",
                    id: currentTextId,
                  });
                  currentTextId = null;
                }

                // Extract fields based on item type
                const toolLabel = this.getToolLabel(item);
                const firstChange = item.changes?.[0];
                // Track fileChange for turn/diff/updated
                if (item.type === "fileChange") {
                  lastFileChangeToolCallId = item.id;
                }

                safeEnqueue(controller, {
                  type: "tool-input-available",
                  toolCallId: item.id,
                  toolName: `codex_${item.type}`,
                  input: {
                    codexItemType: item.type,
                    toolLabel,
                    command: item.commandActions?.[0]?.command || item.command,
                    path: firstChange?.path || item.filename || item.path,
                    action: firstChange?.kind?.type || item.changeType,
                    diff: firstChange?.diff,
                    // Pass through all original item fields for future tool types
                    ...item,
                  },
                });
                break;
              }

              case "item/reasoning/textDelta":
              case "item/reasoning/summaryTextDelta": {
                const delta = params.delta || params.textDelta;
                if (delta) {
                  if (!currentReasoningId) {
                    currentReasoningId = `codex-reason-${partCounter++}`;
                    safeEnqueue(controller, {
                      type: "reasoning-start",
                      id: currentReasoningId,
                    });
                  }
                  safeEnqueue(controller, {
                    type: "reasoning-delta",
                    id: currentReasoningId,
                    delta,
                  });
                }
                break;
              }

              case "item/completed": {
                const item = params.item;
                if (!item) break;

                // Close text/reasoning streams
                if (item.type === "agentMessage" && currentTextId) {
                  safeEnqueue(controller, {
                    type: "text-end",
                    id: currentTextId,
                  });
                  currentTextId = null;
                }
                if (item.type === "reasoning" && currentReasoningId) {
                  safeEnqueue(controller, {
                    type: "reasoning-end",
                    id: currentReasoningId,
                  });
                  currentReasoningId = null;
                }

                // Generic tool completion — emit output for ANY non-text/reasoning item
                if (
                  item.type !== "agentMessage" &&
                  item.type !== "reasoning" &&
                  item.type !== "userMessage"
                ) {
                  const accumulated = toolOutputBuffers.get(item.id) || "";
                  toolOutputBuffers.delete(item.id);
                  const firstChange = item.changes?.[0];
                  safeEnqueue(controller, {
                    type: "tool-output-available",
                    toolCallId: item.id,
                    output: {
                      codexItemType: item.type,
                      output: accumulated || item.output || "",
                      exit_code: item.exitCode ?? item.exit_code ?? 0,
                      diff: firstChange?.diff || item.diff,
                      path: firstChange?.path || item.path,
                      action: firstChange?.kind?.type || item.changeType,
                      // Pass through all item fields for future tool types
                      ...item,
                    },
                  });
                }
                break;
              }

              case "turn/completed":
              case "turn/aborted": {
                if (currentTextId) {
                  safeEnqueue(controller, {
                    type: "text-end",
                    id: currentTextId,
                  });
                  currentTextId = null;
                }
                if (currentReasoningId) {
                  safeEnqueue(controller, {
                    type: "reasoning-end",
                    id: currentReasoningId,
                  });
                  currentReasoningId = null;
                }
                this.notificationHandler = null;
                safeEnqueue(controller, { type: "finish-step" });
                safeEnqueue(controller, {
                  type: "finish",
                  finishReason: "stop",
                });
                safeClose(controller);
                break;
              }

              case "error": {
                console.error("[CodexTransport] Error:", params);
                // Extract readable error message — may be nested JSON
                let errorText = "Codex error";
                const rawMsg = params.error?.message || params.message || "";
                try {
                  const parsed = JSON.parse(rawMsg);
                  errorText = parsed.error?.message || parsed.message || rawMsg;
                } catch {
                  errorText = rawMsg || errorText;
                }

                // Show as visible text in the chat UI
                if (!hasStarted) {
                  hasStarted = true;
                  safeEnqueue(controller, { type: "start" });
                  safeEnqueue(controller, { type: "start-step" });
                }
                const errId = `codex-err-${partCounter++}`;
                safeEnqueue(controller, { type: "text-start", id: errId });
                safeEnqueue(controller, {
                  type: "text-delta",
                  id: errId,
                  delta: `**Error:** ${errorText}`,
                });
                safeEnqueue(controller, { type: "text-end", id: errId });
                safeEnqueue(controller, { type: "finish-step" });
                safeEnqueue(controller, {
                  type: "finish",
                  finishReason: "error",
                });
                this.notificationHandler = null;
                safeClose(controller);
                break;
              }

              // Full git diff for all file changes in this turn
              case "turn/diff/updated": {
                const diff = params.diff;
                if (diff && lastFileChangeToolCallId) {
                  // Re-emit tool output with the full git diff
                  safeEnqueue(controller, {
                    type: "tool-output-available",
                    toolCallId: lastFileChangeToolCallId,
                    output: {
                      codexItemType: "fileChange",
                      output: "",
                      diff,
                    },
                  });
                }
                break;
              }

              // Generic handler for ALL item output deltas (item/*/outputDelta)
              default: {
                if (
                  method.startsWith("item/") &&
                  method.endsWith("/outputDelta")
                ) {
                  const delta = params.delta || params.outputDelta;
                  const itemId = params.itemId;
                  if (delta && itemId) {
                    const existing = toolOutputBuffers.get(itemId) || "";
                    toolOutputBuffers.set(itemId, existing + delta);

                    // Emit data-terminal chunk so sidebar streams output in real-time
                    safeEnqueue(controller, {
                      type: "data-part-available",
                      id: `codex-stream-${itemId}-${partCounter++}`,
                      dataType: "data-terminal",
                      data: { toolCallId: itemId, terminal: delta },
                    });
                  }
                }
                break;
              }
            }
          };

          // Handle abort
          if (abortSignal) {
            abortSignal.addEventListener(
              "abort",
              () => {
                if (turnId && threadId) {
                  this.rpcNotify("turn/interrupt", { threadId, turnId });
                }
                if (currentTextId) {
                  safeEnqueue(controller, {
                    type: "text-end",
                    id: currentTextId,
                  });
                }
                this.notificationHandler = null;
                safeEnqueue(controller, { type: "finish-step" });
                safeEnqueue(controller, {
                  type: "finish",
                  finishReason: "stop",
                });
                safeClose(controller);
              },
              { once: true },
            );
          }

          // Start the turn — append notes context to the user message
          const notesCtx = buildNotesContext(this.promptData.notes);
          const userInput = notesCtx ? `${prompt}${notesCtx}` : prompt;
          console.log("[CodexTransport] Starting turn...");
          await this.rpcRequest("turn/start", {
            threadId,
            model: this.currentModel || "gpt-5.4",
            input: [{ type: "text", text: userInput }],
          });
          console.log("[CodexTransport] Turn started");
        } catch (err) {
          console.error("[CodexTransport] Error:", err);
          safeEnqueue(controller, {
            type: "error",
            errorText: err instanceof Error ? err.message : "Turn failed",
          });
          safeClose(controller);
        }
      },
    });
  }

  async reconnectToStream(
    _options: ChatTransportReconnectOptions,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }

  // ── JSON-RPC helpers via Tauri IPC ──────────────────────────────

  private async rpcRequest(method: string, params: any): Promise<any> {
    const id = ++this.rpcId;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, id, params });

    console.log("[CodexTransport] →", method, `(id=${id})`);

    const { invoke } = await import("@tauri-apps/api/core");

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      invoke("codex_rpc_send", { message: msg }).catch((err) => {
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `Failed to send: ${err instanceof Error ? err.message : err}`,
          ),
        );
      });

      // Timeout after 30s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 30000);
    });
  }

  private async rpcNotify(method: string, params: any): Promise<void> {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    console.log("[CodexTransport] → (notify)", method);
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("codex_rpc_send", { message: msg });
  }

  /** Build a human-readable label for a Codex tool item */
  private getToolLabel(item: any): string {
    if (item.type === "commandExecution") {
      return item.commandActions?.[0]?.command || item.command || "command";
    }
    if (item.type === "fileChange") {
      return item.changes?.[0]?.path || item.filename || item.path || "file";
    }
    if (item.type === "webSearch") {
      return item.query || "web";
    }
    // Generic: use type name as label (e.g., "mcpToolCall" → "mcpToolCall")
    return item.name || item.type || "tool";
  }

  private errorStream(message: string): ReadableStream<UIMessageChunk> {
    console.error("[CodexTransport]", message);
    return new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "error", errorText: message });
        controller.close();
      },
    });
  }
}
