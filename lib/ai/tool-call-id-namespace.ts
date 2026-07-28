import {
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";

type MiddlewareStreamOptions = Parameters<
  NonNullable<LanguageModelMiddleware["wrapStream"]>
>[0];
type LanguageModelStreamResult = Awaited<
  ReturnType<MiddlewareStreamOptions["doStream"]>
>;
type LanguageModelStreamPart =
  LanguageModelStreamResult["stream"] extends ReadableStream<infer T>
    ? T
    : never;

const TOOL_INPUT_PART_TYPES = new Set([
  "tool-input-start",
  "tool-input-delta",
  "tool-input-end",
]);

export const namespaceToolCallId = (
  toolCallId: string,
  namespace: string,
): string =>
  toolCallId.startsWith(`${namespace}_`)
    ? toolCallId
    : `${namespace}_${toolCallId}`;

export const namespaceLanguageModelToolPart = <
  T extends {
    type: string;
    id?: string;
    toolCallId?: string;
  },
>(
  part: T,
  namespace: string,
): T => {
  if (TOOL_INPUT_PART_TYPES.has(part.type) && typeof part.id === "string") {
    return {
      ...part,
      id: namespaceToolCallId(part.id, namespace),
    };
  }

  if (
    ["tool-call", "tool-result", "tool-approval-request"].includes(part.type) &&
    typeof part.toolCallId === "string"
  ) {
    return {
      ...part,
      toolCallId: namespaceToolCallId(part.toolCallId, namespace),
    };
  }

  return part;
};

export const namespaceLanguageModelToolCalls = (
  model: LanguageModel,
  namespace: string,
): LanguageModel => {
  if (typeof model === "string" || model.specificationVersion !== "v3") {
    return model;
  }

  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        return {
          ...result,
          content: result.content.map((part) =>
            namespaceLanguageModelToolPart(part, namespace),
          ),
        };
      },
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<
              LanguageModelStreamPart,
              LanguageModelStreamPart
            >({
              transform(part, controller) {
                controller.enqueue(
                  namespaceLanguageModelToolPart(part, namespace),
                );
              },
            }),
          ),
        };
      },
    },
  });
};
