import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { UIMessage, UIMessageStreamWriter } from "ai";

const mockGenerateText = jest.fn();
const mockLanguageModel = jest.fn((modelName: string) => ({ modelName }));

jest.mock("ai", () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  Output: {
    object: (config: unknown) => ({ type: "object", ...config }),
  },
}));

jest.mock("@/lib/ai/providers", () => ({
  myProvider: {
    languageModel: (modelName: string) => mockLanguageModel(modelName),
  },
}));

jest.mock("@/lib/api/chat-stream-helpers", () => ({
  isXaiSafetyError: jest.fn(() => false),
}));

const { generateTitleFromUserMessage, generateTitleFromUserMessageWithWriter } =
  require("../index") as typeof import("../index");

const makeMessage = (text: string): UIMessage[] =>
  [
    {
      id: "message-1",
      role: "user",
      parts: [{ type: "text", text }],
    },
  ] as UIMessage[];

describe("generateTitleFromUserMessage", () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockLanguageModel.mockClear();
  });

  it("uses the title generator model with a small but safe output budget", async () => {
    mockGenerateText.mockResolvedValue({
      output: { title: "Web Recon Tips" },
    });

    await expect(
      generateTitleFromUserMessage(
        makeMessage("how do I enumerate subdomains"),
      ),
    ).resolves.toBe("Web Recon Tips");

    expect(mockLanguageModel).toHaveBeenCalledWith("title-generator-model");
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 64,
        maxRetries: 1,
        providerOptions: {
          openrouter: {
            reasoning: { enabled: true, effort: "high" },
          },
          xai: { store: false },
        },
        temperature: 0,
      }),
    );
  });

  it("constrains generated titles to non-empty strings under the chat title limit", async () => {
    mockGenerateText.mockResolvedValue({
      output: { title: "Schema Bound Title" },
    });

    await generateTitleFromUserMessage(makeMessage("title schema check"));

    const generateTextOptions = mockGenerateText.mock.calls[0][0] as {
      output: {
        schema: { safeParse: (value: unknown) => { success: boolean } };
      };
    };
    const schema = generateTextOptions.output.schema;

    expect(schema.safeParse({ title: "Valid Title" }).success).toBe(true);
    expect(schema.safeParse({ title: "" }).success).toBe(false);
    expect(schema.safeParse({ title: "x".repeat(101) }).success).toBe(false);
  });

  it("falls back to the first user message when structured output parsing fails", async () => {
    mockGenerateText.mockRejectedValue(
      Object.assign(new Error("No object generated"), {
        name: "AI_NoObjectGeneratedError",
      }),
    );

    await expect(
      generateTitleFromUserMessage(
        makeMessage("what wrong you think with this chat title"),
      ),
    ).resolves.toBe("what wrong you think with");
  });

  it("writes the fallback title without logging when the title model fails", async () => {
    mockGenerateText.mockRejectedValue(
      new Error("Unexpected end of JSON input"),
    );
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const writer = {
      write: jest.fn(),
    } as unknown as UIMessageStreamWriter;

    await expect(
      generateTitleFromUserMessageWithWriter(
        makeMessage("debug truncated title JSON responses"),
        writer,
      ),
    ).resolves.toBe("debug truncated title JSON responses");

    expect(writer.write).toHaveBeenCalledWith({
      type: "data-title",
      data: { chatTitle: "debug truncated title JSON responses" },
      transient: true,
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
