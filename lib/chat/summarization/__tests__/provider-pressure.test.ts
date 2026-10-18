import type { ModelMessage } from "ai";
import {
  getProviderPromptPressure,
  DEEPSEEK_AGENT_PRESSURE_SERIALIZED_MESSAGE_BYTES,
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
  const deepseekAgent = {
    modelId: "deepseek/deepseek-v4.1-flash",
    mode: "agent" as const,
  };
  const historyWithBytes = (bytes: number): ModelMessage[] => {
    const messages: ModelMessage[] = [{ role: "user", content: "" }];
    const overhead = new TextEncoder().encode(JSON.stringify(messages)).length;
    messages[0].content = "a".repeat(bytes - overhead);
    return messages;
  };

  it.each([
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4.1-flash",
    "deepseek/deepseek-v4.1-flash-1017",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-pro-0813",
  ])("allows larger Agent histories on %s", (modelId) => {
    const messages = historyWithBytes(600_000);
    expect(getProviderPromptPressure(messages)).toMatchObject({
      reason: "serialized_message_bytes",
    });
    expect(
      getProviderPromptPressure(messages, { ...deepseekAgent, modelId }),
    ).toBeNull();
  });

  it("compacts exactly at the larger byte ceiling", () => {
    expect(
      getProviderPromptPressure(
        historyWithBytes(DEEPSEEK_AGENT_PRESSURE_SERIALIZED_MESSAGE_BYTES - 1),
        deepseekAgent,
      ),
    ).toBeNull();
    expect(
      getProviderPromptPressure(
        historyWithBytes(DEEPSEEK_AGENT_PRESSURE_SERIALIZED_MESSAGE_BYTES),
        deepseekAgent,
      ),
    ).toMatchObject({ reason: "serialized_message_bytes" });
  });

  it.each([
    { modelId: "deepseek/deepseek-v4.1-flash", mode: "ask" as const },
    { modelId: "deepseek/deepseek-v3", mode: "agent" as const },
    { modelId: "deepseek/deepseek-v4-unknown", mode: "agent" as const },
    { modelId: "z-ai/glm-5.3", mode: "agent" as const },
    { mode: "agent" as const },
  ])("retains the legacy byte ceiling for $modelId / $mode", (route) => {
    expect(
      getProviderPromptPressure(
        historyWithBytes(PROVIDER_PRESSURE_SERIALIZED_MESSAGE_BYTES),
        route,
      ),
    ).toMatchObject({ reason: "serialized_message_bytes" });
  });

  it("keeps count guards active below the larger byte ceiling", () => {
    const results = Array.from(
      { length: PROVIDER_PRESSURE_TOOL_RESULT_COUNT },
      (_, index) => toolResultMessage(index, "short"),
    );
    expect(getProviderPromptPressure(results, deepseekAgent)).toMatchObject({
      reasons: ["tool_result_count"],
    });
    const messages: ModelMessage[] = Array.from(
      { length: PROVIDER_PRESSURE_MESSAGE_COUNT },
      () => ({ role: "user", content: "short" }),
    );
    expect(getProviderPromptPressure(messages, deepseekAgent)).toMatchObject({
      reasons: ["message_count"],
    });
  });

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

  it("does not trigger serialized pressure for a single image tool result", () => {
    const messages = [
      toolResultMessage(1, {
        type: "content",
        value: [
          { type: "text", text: "Viewing image file: screenshot.png" },
          {
            type: "image-data",
            data: "a".repeat(PROVIDER_PRESSURE_SERIALIZED_MESSAGE_BYTES + 1),
            mediaType: "image/png",
          },
        ],
      }),
    ] as ModelMessage[];

    expect(getProviderPromptPressure(messages)).toBeNull();
  });

  it("does not trigger serialized pressure for a single image data URL", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this screenshot" },
          {
            type: "file",
            mediaType: "image/png",
            url: `data:image/png;base64,${"a".repeat(
              PROVIDER_PRESSURE_SERIALIZED_MESSAGE_BYTES + 1,
            )}`,
          },
        ],
      },
    ] as unknown as ModelMessage[];

    expect(getProviderPromptPressure(messages)).toBeNull();
  });

  it("does not trigger serialized pressure for a single PDF data URL", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "tell me about this pdf" },
          {
            type: "file",
            mediaType: "application/pdf",
            url: `data:application/pdf;base64,${"a".repeat(
              PROVIDER_PRESSURE_SERIALIZED_MESSAGE_BYTES + 1,
            )}`,
          },
        ],
      },
    ] as unknown as ModelMessage[];

    expect(getProviderPromptPressure(messages)).toBeNull();
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
