/**
 * In-repo accumulator: UIMessageChunk[] → ChatMessage.
 * Replicates the AI SDK's processUIMessageStream logic without ReadableStream
 * to avoid "Cannot close an errored readable stream" errors.
 */
import type { UIMessageChunk } from "ai";
import type { ChatMessage } from "@/types";

/** Sync partial JSON parse for tool-input-delta accumulation */
function parsePartialJsonSync(text: string): unknown {
  if (!text?.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const trimmed = text.trim();
    const closed = trimmed.endsWith(",")
      ? `${trimmed.slice(0, -1)}]`
      : trimmed.endsWith('"') || trimmed.endsWith("'")
        ? `${trimmed}}`
        : `${trimmed}]`;
    try {
      return JSON.parse(closed) as unknown;
    } catch {
      return undefined;
    }
  }
}

export function accumulateChunksToMessage(
  chunks: UIMessageChunk[],
  messageId: string,
): ChatMessage {
  const parts: ChatMessage["parts"] = [];
  const activeTextParts: Record<
    string,
    { text: string; state?: "streaming" | "done" }
  > = {};
  const activeReasoningParts: Record<
    string,
    { text: string; state?: "streaming" | "done" }
  > = {};
  const partialToolCalls: Record<
    string,
    { text: string; toolName: string; dynamic?: boolean; title?: string }
  > = {};
  let id = messageId;

  const getToolInvocation = (toolCallId: string) => {
    const inv = parts.find(
      (p) => (p as { toolCallId?: string }).toolCallId === toolCallId,
    );
    if (!inv) return null;
    return inv as {
      type: string;
      toolCallId: string;
      state?: string;
      output?: unknown;
      errorText?: string;
      approval?: { id: string };
    };
  };

  for (const chunk of chunks) {
    switch (chunk.type) {
      case "start":
        if (chunk.messageId != null) id = chunk.messageId;
        break;

      case "text-start": {
        const textPart = {
          type: "text" as const,
          text: "",
          state: "streaming" as const,
        };
        activeTextParts[chunk.id] = textPart;
        parts.push(textPart);
        break;
      }
      case "text-delta": {
        const textPart = activeTextParts[chunk.id];
        if (textPart) {
          textPart.text += chunk.delta;
        }
        break;
      }
      case "text-end": {
        const textPart = activeTextParts[chunk.id];
        if (textPart) {
          textPart.state = "done";
          delete activeTextParts[chunk.id];
        }
        break;
      }

      case "reasoning-start": {
        const reasoningPart = {
          type: "reasoning" as const,
          text: "",
          state: "streaming" as const,
        };
        activeReasoningParts[chunk.id] = reasoningPart;
        parts.push(reasoningPart);
        break;
      }
      case "reasoning-delta": {
        const reasoningPart = activeReasoningParts[chunk.id];
        if (reasoningPart) reasoningPart.text += chunk.delta;
        break;
      }
      case "reasoning-end": {
        const reasoningPart = activeReasoningParts[chunk.id];
        if (reasoningPart) {
          reasoningPart.state = "done";
          delete activeReasoningParts[chunk.id];
        }
        break;
      }

      case "tool-input-start": {
        const toolInvocations = parts.filter(
          (p) =>
            (p as { type?: string }).type?.startsWith("tool-") ||
            (p as { type?: string }).type === "dynamic-tool",
        );
        partialToolCalls[chunk.toolCallId] = {
          text: "",
          toolName: chunk.toolName,
          dynamic: chunk.dynamic,
          title: chunk.title,
        };
        if (chunk.dynamic) {
          parts.push({
            type: "dynamic-tool",
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            state: "input-streaming",
            input: undefined,
            providerExecuted: chunk.providerExecuted,
            title: chunk.title,
          });
        } else {
          parts.push({
            type: `tool-${chunk.toolName}` as "tool-call",
            toolCallId: chunk.toolCallId,
            state: "input-streaming",
            input: undefined,
            providerExecuted: chunk.providerExecuted,
            title: chunk.title,
          } as ChatMessage["parts"][0]);
        }
        break;
      }
      case "tool-input-delta": {
        const partial = partialToolCalls[chunk.toolCallId];
        if (partial) {
          partial.text += chunk.inputTextDelta;
          const value = parsePartialJsonSync(partial.text);
          const part = parts.find(
            (p) =>
              (p as { toolCallId?: string }).toolCallId === chunk.toolCallId,
          ) as
            | { input?: unknown; toolName?: string; title?: string }
            | undefined;
          if (part) part.input = value;
        }
        break;
      }
      case "tool-input-available": {
        const part = parts.find(
          (p) => (p as { toolCallId?: string }).toolCallId === chunk.toolCallId,
        ) as
          | {
              state?: string;
              input?: unknown;
              toolName?: string;
              title?: string;
            }
          | undefined;
        if (part) {
          part.state = "input-available";
          part.input = chunk.input;
        }
        delete partialToolCalls[chunk.toolCallId];
        break;
      }
      case "tool-input-error": {
        const part = parts.find(
          (p) => (p as { toolCallId?: string }).toolCallId === chunk.toolCallId,
        ) as
          | {
              state?: string;
              input?: unknown;
              errorText?: string;
              rawInput?: unknown;
            }
          | undefined;
        if (part) {
          part.state = "output-error";
          part.rawInput = chunk.input;
          part.errorText = chunk.errorText;
        }
        delete partialToolCalls[chunk.toolCallId];
        break;
      }
      case "tool-approval-request": {
        const inv = getToolInvocation(chunk.toolCallId);
        if (inv && "state" in inv)
          (inv as { state?: string }).state = "approval-requested";
        if (inv && "approval" in inv)
          (inv as { approval?: { id: string } }).approval = {
            id: chunk.approvalId,
          };
        break;
      }
      case "tool-output-denied": {
        const inv = getToolInvocation(chunk.toolCallId);
        if (inv && "state" in inv)
          (inv as { state?: string }).state = "output-denied";
        break;
      }
      case "tool-output-available": {
        const inv = getToolInvocation(chunk.toolCallId);
        if (inv && "state" in inv) {
          (inv as { state?: string }).state = "output-available";
          (inv as { output?: unknown }).output = chunk.output;
        }
        break;
      }
      case "tool-output-error": {
        const inv = getToolInvocation(chunk.toolCallId);
        if (inv && "state" in inv) {
          (inv as { state?: string }).state = "output-error";
          (inv as { errorText?: string }).errorText = chunk.errorText;
        }
        break;
      }

      case "file":
        parts.push({
          type: "file",
          mediaType: chunk.mediaType,
          url: chunk.url,
        });
        break;
      case "source-url":
        parts.push({
          type: "source-url",
          sourceId: chunk.sourceId,
          url: chunk.url,
          title: chunk.title,
        });
        break;
      case "source-document":
        parts.push({
          type: "source-document",
          sourceId: chunk.sourceId,
          mediaType: chunk.mediaType,
          title: chunk.title,
          filename: chunk.filename,
        });
        break;

      case "start-step":
        parts.push({ type: "step-start" });
        break;
      case "finish-step":
        for (const k of Object.keys(activeTextParts)) {
          delete activeTextParts[k];
        }
        for (const k of Object.keys(activeReasoningParts)) {
          delete activeReasoningParts[k];
        }
        break;

      case "finish":
        // finishReason could be stored on message if needed
        break;
      case "error":
        // optional: push error part or leave as-is
        break;
      case "abort":
        break;
      case "message-metadata":
        break;

      default:
        if (
          typeof (chunk as { type?: string }).type === "string" &&
          (chunk as { type: string }).type.startsWith("data-")
        ) {
          const dataChunk = chunk as {
            type: `data-${string}`;
            id?: string;
            data: unknown;
            transient?: boolean;
          };
          if (dataChunk.transient) break;
          const existing =
            dataChunk.id != null
              ? parts.find(
                  (p) =>
                    (p as { type?: string; id?: string }).type ===
                      dataChunk.type &&
                    (p as { id?: string }).id === dataChunk.id,
                )
              : undefined;
          if (existing && "data" in existing) {
            (existing as { data: unknown }).data = dataChunk.data;
          } else {
            parts.push({
              type: dataChunk.type,
              id: dataChunk.id,
              data: dataChunk.data,
            } as ChatMessage["parts"][0]);
          }
        }
        break;
    }
  }

  return {
    id,
    role: "assistant",
    parts,
  };
}
