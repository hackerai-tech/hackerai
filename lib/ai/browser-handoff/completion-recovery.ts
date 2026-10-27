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
  if (
    /(?:^|[.!?]\s+|\n)\s*(?:(?:i'm|i am)\s+)?handing (?:the )?(?:browser )?control(?: over)?(?: to you)? (?:right )?now\s*(?:[.!—–:]|$)/i.test(
      prose,
    )
  )
    return true;
  return [
    /(?:^|[.!?]\s+|\n)\s*i(?:'ll| will| am|'m) (?:now )?(?:paus(?:e|ing)(?: now)? and )?wait(?:ing)? (?:here )?for you to (?:take control|take over)\b/gi,
    /(?:^|[.!?]\s+|\n)\s*(?:the )?browser is (?:now )?ready for you to (?:take control|take over)\b/gi,
  ].some((pattern) => {
    for (const match of prose.matchAll(pattern)) {
      const continuation = prose.slice(match.index + match[0].length);
      // Accept bounded immediate qualifiers, but not an unfinished setup promise.
      if (
        /^(?:\s+(?:right )?now)?(?:\s+in (?:the )?(?:browser )?sidebar)?\s*(?:[.!]|$|[,—–:](?!\s*(?:but\s+)?(?:not\s+)?(?:until|after|once|when)\b))/i.test(
          continuation,
        )
      )
        return true;
    }
    return false;
  });
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
        let pendingLine = "";
        let fence: { character: string; length: number } | undefined;
        // Classify complete lines before bounding prose. Only a matching fence
        // line closes code; delimiters inside code strings stay inside code.
        const appendLine = (line: string) => {
          if (fence) {
            const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/);
            if (
              closing &&
              closing[1][0] === fence.character &&
              closing[1].length >= fence.length
            )
              fence = undefined;
            return;
          }
          const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
          if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
            fence = { character: opening[1][0], length: opening[1].length };
            return;
          }
          if (!/^(?: {4}|\t)/.test(line))
            text = (text + line + "\n").slice(-4000);
        };
        const appendText = (delta: string) => {
          const lines = (pendingLine + delta).split("\n");
          pendingLine = lines.pop() ?? "";
          for (const line of lines) appendLine(line);
        };
        let hasToolOrError = false;
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<StreamPart, StreamPart>({
              async transform(part, controller) {
                if (part.type === "text-delta") appendText(part.delta);
                if (part.type === "finish" && pendingLine) {
                  appendLine(pendingLine);
                  pendingLine = "";
                }
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
