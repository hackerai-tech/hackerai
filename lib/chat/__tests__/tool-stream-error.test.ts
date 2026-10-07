import { WritableStream as NodeWritableStream } from "node:stream/web";
import { InvalidToolInputError, NoSuchToolError, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { formatToolStreamError } from "../tool-stream-error";

const originalWritableStream = globalThis.WritableStream;
beforeAll(() => {
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: NodeWritableStream,
  });
});
afterAll(() => {
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: originalWritableStream,
  });
});

describe("formatToolStreamError", () => {
  it("streams an actionable error for the misspelled terminal tool without executing it", async () => {
    const execute = jest.fn();
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: "tool-call",
              toolCallId: "bad-call",
              toolName: "run_terminal_cord",
              input: "{}",
            });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      }),
    });
    const result = streamText({
      model,
      prompt: "Test",
      tools: {
        run_terminal_cmd: tool({
          inputSchema: z.object({ command: z.string() }),
          execute,
        }),
      },
    });
    const chunks = [];
    for await (const chunk of result.toUIMessageStream({
      onError: formatToolStreamError,
    }))
      chunks.push(chunk);
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: "tool-input-error",
        toolName: "run_terminal_cord",
        errorText: expect.stringContaining("unavailable tool"),
      }),
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it("explains unavailable tools without reflecting model-supplied names", () => {
    const result = formatToolStreamError(
      new NoSuchToolError({ toolName: "private-content" }),
    );
    expect(result).toContain("unavailable tool");
    expect(result).toContain("not executed");
    expect(result).not.toContain("private-content");
  });

  it("explains invalid arguments without revealing the input or cause", () => {
    const result = formatToolStreamError(
      new InvalidToolInputError({
        toolName: "run_terminal_cmd",
        toolInput: "private-content",
        cause: new Error("private-content"),
      }),
    );
    expect(result).toContain("invalid tool arguments");
    expect(result).not.toContain("private-content");
  });

  it.each([new Error("private-content"), "private-content", null])(
    "keeps unrecognized errors private",
    (error) => expect(formatToolStreamError(error)).toBe("An error occurred."),
  );
});
