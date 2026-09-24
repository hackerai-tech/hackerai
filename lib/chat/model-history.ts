import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import { preparePlatformAuthorizationForModel } from "./platform-authorization";

export const MODEL_HISTORY_FLAG = "cache_stable_history_v1";
export const CACHE_ALIGNED_SUMMARY_FLAG = "cache_aligned_summary_v1";
export const MODEL_HISTORY_MAX_BYTES = 700_000;

export type ModelHistorySnapshot = {
  version: 1;
  identity: string;
  source: string[];
  messages: ModelMessage[];
  system: string;
};

export function historyDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const canonicalSourceJson = (input: unknown): string =>
  JSON.stringify(input, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );

// Terminal adapters serialize structural results into text, sometimes after a
// process-status line. Convex reorders that JSON when rebuilding UI history.
// Match its values without ever canonicalizing stdout strings or replay bytes.
function canonicalTerminalOutput(toolName: string, text: string): string {
  if (!["run_terminal_cmd", "interact_terminal_session"].includes(toolName))
    return text;
  const boundary = text.startsWith("Process ") ? text.indexOf("\n") + 1 : 0;
  try {
    const value: unknown = JSON.parse(text.slice(boundary));
    if (!value || typeof value !== "object") return text;
    return text.slice(0, boundary) + canonicalSourceJson(value);
  } catch {
    return text;
  }
}

/** Only an exact, backend-owned request prefix is trusted; sanitize every new suffix. */
export function prepareReplayAuthorization(
  messages: ModelMessage[],
  trustedPrefix: ModelMessage[],
  authorized: boolean,
  model: string,
): ModelMessage[] {
  let boundary = 0;
  while (
    boundary < messages.length &&
    boundary < trustedPrefix.length &&
    JSON.stringify(messages[boundary]) ===
      JSON.stringify(trustedPrefix[boundary])
  )
    boundary++;
  return [
    ...messages.slice(0, boundary),
    ...preparePlatformAuthorizationForModel(
      messages.slice(boundary),
      authorized,
      model,
    ),
  ];
}

// Ignore display/provider metadata and reasoning in the *source identity* only.
// Persisted UI history intentionally strips these. Never change replay content.
export function sourceMessageDigests(messages: ModelMessage[]): string[] {
  return messages.flatMap((message) => {
    const content =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content
            .filter((part) => part.type !== "reasoning")
            .map((part) => {
              const { providerOptions: _options, ...rest } =
                part as typeof part & { providerOptions?: unknown };
              if (rest.type === "tool-result" && rest.output.type === "text") {
                return {
                  ...rest,
                  output: {
                    ...rest.output,
                    value: canonicalTerminalOutput(
                      rest.toolName,
                      rest.output.value,
                    ),
                  },
                };
              }
              return rest;
            });
    if (!content.length) return [];
    // Convex sorts object keys when it stores UI parts. Canonicalize source
    // identity only; never reorder the replay bytes or ordered content arrays.
    const canonical = canonicalSourceJson({ role: message.role, content });
    return [createHash("sha256").update(canonical).digest("hex")];
  });
}

/** Opaque provider blobs and multimodal payloads require adapter-specific replay. */
export function isReplayableTextHistory(messages: ModelMessage[]): boolean {
  return messages.every(
    (message) =>
      message &&
      ["system", "user", "assistant", "tool"].includes(message.role) &&
      (typeof message.content === "string" ||
        (Array.isArray(message.content) &&
          message.content.every((part) => {
            if (
              !part ||
              !["text", "reasoning", "tool-call", "tool-result"].includes(
                part.type,
              )
            )
              return false;
            if (part.type === "tool-result" && part.output.type === "content") {
              return part.output.value.every((item) => item.type === "text");
            }
            return true;
          }))),
  );
}

export function parseModelHistory(
  value: string | null,
): ModelHistorySnapshot | undefined {
  if (!value || Buffer.byteLength(value) > MODEL_HISTORY_MAX_BYTES) return;
  try {
    const parsed = JSON.parse(value) as ModelHistorySnapshot;
    if (
      parsed.version !== 1 ||
      typeof parsed.identity !== "string" ||
      typeof parsed.system !== "string" ||
      !Array.isArray(parsed.source) ||
      !parsed.source.every((item) => typeof item === "string") ||
      !Array.isArray(parsed.messages) ||
      !isReplayableTextHistory(parsed.messages)
    )
      return;
    return parsed;
  } catch {
    return;
  }
}

/** Exact source-prefix match: edits, truncation and summary replacement fail closed. */
export function restoreModelHistory(
  snapshot: ModelHistorySnapshot | undefined,
  identity: string,
  source: ModelMessage[],
  prepared: ModelMessage[],
): ModelMessage[] | undefined {
  if (!snapshot || snapshot.identity !== identity || !snapshot.source.length)
    return;
  // Require one fingerprint per message to keep the slice boundary unambiguous.
  const digests = sourceMessageDigests(source);
  if (
    digests.length !== source.length ||
    source.length !== prepared.length ||
    snapshot.source.length > digests.length ||
    !snapshot.source.every((value, index) => value === digests[index])
  )
    return;
  return [...snapshot.messages, ...prepared.slice(snapshot.source.length)];
}

/** Retains request-local injections when the SDK supplies its raw history again. */
export class ModelHistoryReplay {
  private checkpoint?: { messages: ModelMessage[]; cursor: number };
  private events = new Map<string, string>();

  project(raw: ModelMessage[]): ModelMessage[] {
    return this.checkpoint && raw.length >= this.checkpoint.cursor
      ? [...this.checkpoint.messages, ...raw.slice(this.checkpoint.cursor)]
      : raw;
  }

  commit(messages: ModelMessage[], rawCursor: number): void {
    this.checkpoint = {
      messages: structuredClone(messages),
      cursor: rawCursor,
    };
  }

  append(
    messages: ModelMessage[],
    kind: string,
    text: string | undefined,
  ): ModelMessage[] {
    if (!text || this.events.get(kind) === text) return messages;
    this.events.set(kind, text);
    return [...messages, { role: "user", content: text }];
  }

  reset(): void {
    this.checkpoint = undefined;
    this.events.clear();
  }
  hasEvent(kind: string): boolean {
    return this.events.has(kind);
  }
}
