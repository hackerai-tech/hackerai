import {
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";

import {
  recordOpenRouterStreamErrorContext,
  type OpenRouterStreamErrorContext,
} from "@/lib/utils/openrouter-stream-error-context";

type StreamResult = Awaited<
  ReturnType<
    Parameters<
      NonNullable<LanguageModelMiddleware["wrapStream"]>
    >[0]["doStream"]
  >
>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer T> ? T : never;

/** Snapshot only opaque router IDs; never retain other headers or invoke getters. */
function headerContext(headers: unknown): OpenRouterStreamErrorContext {
  if (headers === undefined || headers === null)
    return {
      version: 1,
      source: "sdk_error_part",
      headers: "absent",
      association: "same_call",
    };
  if (typeof headers !== "object") throw new Error("Unreadable headers");
  /** Read only allowlisted own values; a getter cannot supply diagnostic evidence. */
  const header = (name: string) => {
    if (headers instanceof Headers)
      return Headers.prototype.get.call(headers, name);
    const key = Object.keys(headers).find((key) => key.toLowerCase() === name);
    if (!key) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(headers, key);
    if (descriptor && !("value" in descriptor))
      throw new Error("Unreadable header");
    return descriptor?.value;
  };
  const generation =
    header("x-generation-id") ?? header("x-openrouter-generation-id");
  const request = header("request-id") ?? header("x-request-id");
  return {
    version: 1,
    source: "sdk_error_part",
    headers: "present",
    association: "same_call",
    ...(typeof generation === "string" &&
    /^gen-[A-Za-z0-9_-]{1,128}$/.test(generation)
      ? { generationId: generation }
      : {}),
    ...(typeof request === "string" &&
    /^req-[A-Za-z0-9_-]{1,128}$/.test(request)
      ? { requestId: request }
      : {}),
  };
}

/** Observe same-call SDK error parts without replacing errors or stream values. */
export function withOpenRouterStreamErrorContext(
  model: LanguageModel,
): LanguageModel {
  if (typeof model === "string" || model.specificationVersion !== "v3")
    return model;
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      /** Keep response ownership local to this invocation, including overlapping streams. */
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        const call = {};
        let context: OpenRouterStreamErrorContext;
        try {
          context = headerContext(result.response?.headers);
        } catch {
          context = {
            version: 1,
            source: "sdk_error_part",
            headers: "unreadable",
            association: "same_call",
          };
        }
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<StreamPart, StreamPart>({
              transform(part, controller) {
                try {
                  if (part.type === "error")
                    recordOpenRouterStreamErrorContext(
                      part.error,
                      call,
                      context,
                    );
                } catch {
                  // Diagnostics must not interfere with forwarding the original part.
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
