import type { ModelMessage } from "ai";
import {
  getProviderPromptPressure,
  PROVIDER_PRESSURE_MESSAGE_COUNT,
  PROVIDER_PRESSURE_SERIALIZED_MESSAGE_BYTES,
  PROVIDER_PRESSURE_SUMMARIZATION_MAX_TOKENS,
  PROVIDER_PRESSURE_TOOL_RESULT_COUNT,
} from "../provider-pressure";

const toolResultMessage = (index: number, output: unknown): ModelMessage =>
  ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: `call-${index}`,
        toolName: "shell",
        output,
      },
    ],
  }) as unknown as ModelMessage;

describe("getProviderPromptPressure", () => {
  it("triggers for large tool-heavy provider prompts", () => {
    const messages = Array.from(
      { length: PROVIDER_PRESSURE_TOOL_RESULT_COUNT },
      (_, index) => toolResultMessage(index, "x".repeat(5_000)),
    );

    const pressure = getProviderPromptPressure(messages);

    expect(pressure).toMatchObject({
      reason: "serialized_message_bytes",
      toolResultCount: PROVIDER_PRESSURE_TOOL_RESULT_COUNT,
      messageCount: PROVIDER_PRESSURE_TOOL_RESULT_COUNT,
      summarizationMaxTokensOverride:
        PROVIDER_PRESSURE_SUMMARIZATION_MAX_TOKENS,
    });
    expect(pressure?.reasons).toEqual([
      "serialized_message_bytes",
      "tool_result_count",
    ]);
    expect(pressure?.serializedMessageBytes).toBeGreaterThanOrEqual(
      PROVIDER_PRESSURE_SERIALIZED_MESSAGE_BYTES,
    );
  });

  it("triggers on provider message count even when content is small", () => {
    const messages = Array.from(
      { length: PROVIDER_PRESSURE_MESSAGE_COUNT },
      (_, index) =>
        ({
          role: "user",
          content: `small ${index}`,
        }) as ModelMessage,
    );

    expect(getProviderPromptPressure(messages)).toMatchObject({
      reason: "message_count",
      reasons: ["message_count"],
      toolResultCount: 0,
      messageCount: PROVIDER_PRESSURE_MESSAGE_COUNT,
    });
  });

  it("does not trigger for small prompts", () => {
    const messages = [
      {
        role: "user",
        content: "hello",
      },
      toolResultMessage(1, "short output"),
    ] as ModelMessage[];

    expect(getProviderPromptPressure(messages)).toBeNull();
  });
});
