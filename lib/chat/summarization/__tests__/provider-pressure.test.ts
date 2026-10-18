import type { ModelMessage } from "ai";
import {
  getProviderPromptPressure,
  PROVIDER_PRESSURE_SERIALIZED_MESSAGE_BYTES,
  PROVIDER_PRESSURE_SUMMARIZATION_MAX_TOKENS,
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
  const historyWithBytes = (bytes: number): ModelMessage[] => {
    const messages: ModelMessage[] = [{ role: "user", content: "" }];
    const overhead = new TextEncoder().encode(JSON.stringify(messages)).length;
    messages[0].content = "a".repeat(bytes - overhead);
    return messages;
  };

  it("allows larger histories in Agent mode without a model selector", () => {
    const messages = historyWithBytes(700_000);
    expect(getProviderPromptPressure(messages, { mode: "agent" })).toBeNull();
    expect(getProviderPromptPressure(messages, { mode: "ask" })).toMatchObject({
      reason: "serialized_message_bytes",
    });
    expect(getProviderPromptPressure(messages)).toMatchObject({
      reason: "serialized_message_bytes",
    });
  });

  it.each([
    { mode: "agent" as const, limit: 1_800_000 },
    { mode: "ask" as const, limit: 600_000 },
    { mode: undefined, limit: 600_000 },
  ])("compacts exactly at the $mode byte ceiling", ({ mode, limit }) => {
    expect(
      getProviderPromptPressure(historyWithBytes(limit - 1), { mode }),
    ).toBeNull();
    expect(
      getProviderPromptPressure(historyWithBytes(limit), { mode }),
    ).toMatchObject({ reason: "serialized_message_bytes" });
  });

  it.each([undefined, { mode: "agent" as const }, { mode: "ask" as const }])(
    "does not compact small histories merely because of their counts (%j)",
    (route) => {
      const results = Array.from({ length: 150 }, (_, index) =>
        toolResultMessage(index, "short"),
      );
      expect(getProviderPromptPressure(results, route)).toBeNull();
      const messages: ModelMessage[] = Array.from({ length: 200 }, () => ({
        role: "user",
        content: "short",
      }));
      expect(getProviderPromptPressure(messages, route)).toBeNull();
    },
  );

  it("triggers for large tool-heavy provider prompts", () => {
    const messages = Array.from({ length: 100 }, (_, index) =>
      toolResultMessage(index, "x".repeat(7_000)),
    );

    const pressure = getProviderPromptPressure(messages);

    expect(pressure).toMatchObject({
      reason: "serialized_message_bytes",
      toolResultCount: 100,
      messageCount: 100,
      summarizationMaxTokensOverride:
        PROVIDER_PRESSURE_SUMMARIZATION_MAX_TOKENS,
    });
    expect(pressure?.reasons).toEqual(["serialized_message_bytes"]);
    expect(pressure?.serializedMessageBytes).toBeGreaterThanOrEqual(
      PROVIDER_PRESSURE_SERIALIZED_MESSAGE_BYTES,
    );
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
