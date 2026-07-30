import type { LanguageModel } from "ai";
import {
  namespaceLanguageModelToolCalls,
  namespaceLanguageModelToolPart,
  namespaceToolCallId,
} from "../tool-call-id-namespace";

describe("tool-call ID namespaces", () => {
  it("prefixes provider tool stream parts with the run and compaction namespace", () => {
    const namespace = "rabc123c1";

    expect(
      namespaceLanguageModelToolPart(
        {
          type: "tool-input-start",
          id: "run_terminal_cmd_1",
          toolName: "run_terminal_cmd",
        },
        namespace,
      ),
    ).toEqual({
      type: "tool-input-start",
      id: "rabc123c1_run_terminal_cmd_1",
      toolName: "run_terminal_cmd",
    });

    expect(
      namespaceLanguageModelToolPart(
        {
          type: "tool-call",
          toolCallId: "run_terminal_cmd_1",
          toolName: "run_terminal_cmd",
          input: "{}",
        },
        namespace,
      ),
    ).toEqual({
      type: "tool-call",
      toolCallId: "rabc123c1_run_terminal_cmd_1",
      toolName: "run_terminal_cmd",
      input: "{}",
    });
  });

  it("keeps matching results correlated and does not double-prefix IDs", () => {
    const namespace = "rabc123c2";
    const namespacedId = namespaceToolCallId("run_terminal_cmd_1", namespace);

    expect(namespaceToolCallId(namespacedId, namespace)).toBe(namespacedId);
    expect(
      namespaceLanguageModelToolPart(
        {
          type: "tool-result",
          toolCallId: "run_terminal_cmd_1",
          toolName: "run_terminal_cmd",
          result: { ok: true },
        },
        namespace,
      ).toolCallId,
    ).toBe(namespacedId);
  });

  it("leaves non-tool stream IDs unchanged", () => {
    expect(
      namespaceLanguageModelToolPart(
        { type: "reasoning-start", id: "reasoning-1" },
        "rabc123c1",
      ),
    ).toEqual({ type: "reasoning-start", id: "reasoning-1" });
  });

  it("rewrites tool IDs before the AI SDK executes streamed calls", async () => {
    const sourceParts = [
      {
        type: "tool-input-start",
        id: "run_terminal_cmd_1",
        toolName: "run_terminal_cmd",
      },
      {
        type: "tool-call",
        toolCallId: "run_terminal_cmd_1",
        toolName: "run_terminal_cmd",
        input: "{}",
      },
    ];
    const sourceModel = {
      specificationVersion: "v3",
      provider: "test",
      modelId: "test-model",
      supportedUrls: {},
      doGenerate: jest.fn(),
      doStream: jest.fn(async () => ({
        stream: new ReadableStream({
          start(controller) {
            sourceParts.forEach((part) => controller.enqueue(part));
            controller.close();
          },
        }),
      })),
    } as unknown as LanguageModel;
    const wrappedModel = namespaceLanguageModelToolCalls(
      sourceModel,
      "rrun1c1s8",
    );
    if (typeof wrappedModel === "string") {
      throw new Error("Expected a wrapped language model");
    }

    const result = await wrappedModel.doStream({} as never);
    const reader = result.stream.getReader();
    const parts: Array<{ id?: string; toolCallId?: string }> = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
    }

    expect(parts[0].id).toBe("rrun1c1s8_run_terminal_cmd_1");
    expect(parts[1].toolCallId).toBe("rrun1c1s8_run_terminal_cmd_1");
  });
});
