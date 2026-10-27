import { randomUUID } from "node:crypto";
import {
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";

type StreamOptions = Parameters<
  NonNullable<LanguageModelMiddleware["wrapStream"]>
>[0];
type StreamResult = Awaited<ReturnType<StreamOptions["doStream"]>>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer T> ? T : never;

function requestedHandoff(params: StreamOptions["params"]): boolean {
  const userIndex = params.prompt.findLastIndex((m) => m.role === "user");
  const user = params.prompt[userIndex];
  if (user?.role !== "user") return false;
  const text = user.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/```[\s\S]*?(?:```|$)/g, "")
    .replace(/^\s*>.*$|"[^"\n]*"|“[^”\n]*”/gm, "");
  if (
    /\b(?:don't|do not|never|no need to)\s+(?:(?:want|need)(?: you)? to\s+)?(?:wait|hand\s*over|handoff|call\s+browser_handoff|take\s+(?:control|over))\b/i.test(
      text,
    )
  )
    return false;
  if (!/\b(?:browser_handoff|take\s+control|take\s*over|handoff)\b/i.test(text))
    return false;
  // Never repair a second wait after a real call, including an errored call:
  // its outcome must be handled by the Agent rather than silently retried.
  return !params.prompt
    .slice(userIndex + 1)
    .some((message) =>
      (message.role === "assistant" || message.role === "tool") &&
      Array.isArray(message.content)
        ? message.content.some(
            (part) =>
              (part.type === "tool-call" || part.type === "tool-result") &&
              part.toolName === "browser_handoff",
          )
        : false,
    );
}

function promisedImmediateHandoff(text: string): boolean {
  const prose = text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/^\s*>.*$/gm, "")
    .replace(/\*\*|__/g, "");
  return [
    /(?:^|[.!?]\s+|\n)\s*(?:(?:i'm|i am)\s+)?handing (?:the )?(?:browser )?control(?: over)?(?: to you)? (?:right )?now\s*(?:[.!—–:]|$)/i,
    /(?:^|[.!?]\s+|\n)\s*i(?:'ll| will| am|'m) (?:now )?(?:paus(?:e|ing)(?: now)? and )?wait(?:ing)? (?:here )?for you to (?:take control|take over)\s*(?:[.!—–:,]|$)/i,
    /(?:^|[.!?]\s+|\n)\s*(?:the )?browser is (?:now )?ready for you to (?:take control|take over)\b/i,
  ].some((pattern) => pattern.test(prose));
}

/** Repair a declared, requested handoff at normal completion. The SDK executes
 * the real tool and continues the same loop after resume; no result is invented.
 * Waiting until the declaration preserves any browser preparation before it.
 */
export function recoverBrowserHandoffCompletion(
  model: LanguageModel,
  options: {
    state: { attempted?: boolean };
    canRecover: (signal?: AbortSignal) => Promise<boolean>;
  },
): LanguageModel {
  if (typeof model === "string" || model.specificationVersion !== "v3")
    return model;
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapStream: async ({ doStream, params }) => {
        const result = await doStream();
        if (
          options.state.attempted ||
          !params.tools?.some(
            (tool) =>
              tool.type === "function" && tool.name === "browser_handoff",
          ) ||
          params.toolChoice?.type === "none" ||
          (params.toolChoice?.type === "tool" &&
            params.toolChoice.toolName !== "browser_handoff") ||
          !requestedHandoff(params)
        )
          return result;
        let text = "";
        let inFence = false;
        let pendingTicks = 0;
        // Strip fences before bounding the prose, including delimiters split
        // across chunks. A long code block must not discard its opening fence.
        const appendText = (delta: string) => {
          for (const char of delta) {
            if (char === "`") {
              pendingTicks++;
              if (pendingTicks === 3) {
                inFence = !inFence;
                pendingTicks = 0;
              }
            } else {
              if (!inFence) text += "`".repeat(pendingTicks) + char;
              pendingTicks = 0;
            }
          }
          text = text.slice(-4000);
        };
        let hasToolOrError = false;
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<StreamPart, StreamPart>({
              async transform(part, controller) {
                if (part.type === "text-delta") appendText(part.delta);
                if (part.type.startsWith("tool-") || part.type === "error")
                  hasToolOrError = true;
                if (
                  part.type === "finish" &&
                  part.finishReason.unified === "stop" &&
                  !hasToolOrError &&
                  !options.state.attempted &&
                  !params.abortSignal?.aborted &&
                  promisedImmediateHandoff(text) &&
                  (await options.canRecover(params.abortSignal)) &&
                  !params.abortSignal?.aborted
                ) {
                  options.state.attempted = true;
                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: `handoff_recovery_${randomUUID()}`,
                    toolName: "browser_handoff",
                    input: "{}",
                  });
                  controller.enqueue({
                    ...part,
                    finishReason: {
                      unified: "tool-calls",
                      raw: part.finishReason.raw,
                    },
                  });
                  return;
                }
                controller.enqueue(part);
              },
            }),
          ),
        };
      },
    },
  });
}
