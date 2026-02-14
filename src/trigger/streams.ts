import { streams } from "@trigger.dev/sdk/v3";
import type { UIMessageChunk } from "ai";
import type { RateLimitWarningData } from "@/lib/utils/stream-writer-utils";

// Main LLM output stream -- typed as UIMessageChunk for direct
// compatibility with the AI SDK's toUIMessageStream()
export const aiStream = streams.define<UIMessageChunk>({ id: "ai" });

// Metadata sideband stream -- discriminated union for all custom data parts
export type MetadataEvent =
  | { type: "data-title"; data: { chatTitle: string } }
  | {
      type: "data-upload-status";
      data: { message: string; isUploading: boolean };
    }
  | {
      type: "data-summarization";
      data: { status: "started" | "completed"; message: string };
    }
  | { type: "data-rate-limit-warning"; data: RateLimitWarningData }
  | {
      type: "data-file-metadata";
      data: { messageId: string; fileDetails: unknown[] };
    }
  | {
      type: "data-sandbox-fallback";
      data: {
        occurred: boolean;
        reason?: string;
        originalType?: string;
        fallbackType?: string;
      };
    }
  | {
      type: "data-terminal";
      data: { terminal: string; toolCallId: string };
    }
  | { type: "data-appendMessage"; data: string };

// We send JSON-stringified MetadataEvent so the client receives parseable strings
// (Trigger's pipeline was turning objects into "[object Object]" when sent as objects).
export const metadataStream = streams.define<string>({ id: "metadata" });
