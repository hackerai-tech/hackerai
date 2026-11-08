import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { UIMessage, UIMessageStreamWriter } from "ai";
import {
  APICallError,
  JSONParseError,
  NoOutputGeneratedError,
  TypeValidationError,
} from "ai";

const mockGenerateText = jest.fn();
const mockLanguageModel = jest.fn((modelName: string) => ({ modelName }));

jest.mock("ai", () => ({
  APICallError: jest.requireActual<typeof import("ai")>("ai").APICallError,
  NoObjectGeneratedError:
    jest.requireActual<typeof import("ai")>("ai").NoObjectGeneratedError,
  NoOutputGeneratedError:
    jest.requireActual<typeof import("ai")>("ai").NoOutputGeneratedError,
  TypeValidationError:
    jest.requireActual<typeof import("ai")>("ai").TypeValidationError,
  JSONParseError: jest.requireActual<typeof import("ai")>("ai").JSONParseError,
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
  buildProviderOptions: jest.fn(() => ({
    openrouter: {
      reasoning: { enabled: true, effort: "low" },
      provider: { sort: "latency", data_collection: "deny" },
    },
  })),
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

const makeImageOnlyMessage = (): UIMessage[] =>
  [
    {
      id: "message-1",
      role: "user",
      parts: [
        {
          type: "file",
          mediaType: "image/png",
          filename: "screenshot.png",
          url: "https://example.com/screenshot.png",
        },
      ],
    },
  ] as UIMessage[];

const makeDescribedImageMessage = (text?: string): UIMessage[] =>
  [
    {
      id: "message-1",
      role: "user",
      parts: [
        ...(text ? [{ type: "text" as const, text }] : []),
        {
          type: "text",
          text: '<image_description filename="screenshot.png" trust="untrusted">\nA terminal screenshot.\n</image_description>',
        },
      ],
    },
  ] as UIMessage[];

describe("generateTitleFromUserMessage", () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockLanguageModel.mockClear();
  });

  it("uses the title generator model with low reasoning and a small output budget", async () => {
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
            reasoning: { enabled: true, effort: "low" },
            provider: { sort: "latency", data_collection: "deny" },
          },
        },
        temperature: 0,
      }),
    );
  });

  it("reports the title model's authoritative provider cost", async () => {
    mockGenerateText.mockResolvedValue({
      output: { title: "Costed Title" },
      usage: { raw: { cost: 0.0042 } },
    });
    const onCost = jest.fn();

    await generateTitleFromUserMessage(
      makeMessage("track title generation cost"),
      onCost,
    );

    expect(onCost).toHaveBeenCalledWith(0.0042);
  });

  it("keeps the default title without calling the title model for an image-only message", async () => {
    const onCost = jest.fn();

    await expect(
      generateTitleFromUserMessage(makeImageOnlyMessage(), onCost),
    ).resolves.toBe("New chat");

    expect(mockLanguageModel).not.toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(onCost).not.toHaveBeenCalled();
  });

  it("keeps the default title when auxiliary preprocessing replaced the only image", async () => {
    await expect(
      generateTitleFromUserMessage(makeDescribedImageMessage()),
    ).resolves.toBe("New chat");

    expect(mockLanguageModel).not.toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("generates a title from user text without auxiliary image markup", async () => {
    mockGenerateText.mockResolvedValue({
      output: { title: "Explain This Screenshot" },
    });

    await expect(
      generateTitleFromUserMessage(
        makeDescribedImageMessage("Tell me about this image"),
      ),
    ).resolves.toBe("Explain This Screenshot");

    const prompt = mockGenerateText.mock.calls[0][0].messages[0]
      .content as string;
    expect(prompt).toContain("### User Message:\nTell me about this image");
    expect(prompt).not.toContain("<image_description");
    expect(prompt).not.toContain("A terminal screenshot.");
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

  it("writes the fallback title and logs only safe provider failure metadata", async () => {
    mockGenerateText.mockRejectedValue(
      new APICallError({
        message: "Private provider response with secret API key",
        url: "https://provider.example/?key=secret",
        requestBodyValues: { prompt: "private user prompt" },
        responseBody: "private response",
        statusCode: 400,
      }),
    );
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const writer = {
      write: jest.fn(),
    } as unknown as UIMessageStreamWriter;

    try {
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
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "chat_title_generation_failed",
        {
          category: "provider_error",
          statusCode: 400,
          error_kind_version: 1,
          error_kind: "provider_api_error",
        },
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it.each([
    [
      "sdk_no_output",
      () => new NoOutputGeneratedError({ message: "fixture-private output" }),
    ],
    [
      "sdk_type_validation",
      () =>
        new TypeValidationError({
          value: { prompt: "fixture-private prompt" },
          cause: new Error("fixture-private validation"),
        }),
    ],
    [
      "sdk_json_parse",
      () =>
        new JSONParseError({
          text: "fixture-private response",
          cause: new SyntaxError("fixture-private syntax"),
        }),
    ],
    ["js_type_error", () => new TypeError("fixture-private type")],
    ["js_range_error", () => new RangeError("fixture-private range")],
    ["js_syntax_error", () => new SyntaxError("fixture-private syntax")],
    [
      "other_error",
      () =>
        Object.defineProperty(new Error("fixture-private message"), "name", {
          get() {
            throw new Error("fixture-private name must not be read");
          },
        }),
    ],
    ["non_error", () => ({ token: "fixture-private token" })],
    [
      "unavailable",
      () =>
        new Proxy(new NoOutputGeneratedError(), {
          get(target, key, receiver) {
            if (typeof key === "symbol")
              throw new Error("fixture-private guard failure");
            return Reflect.get(target, key, receiver);
          },
        }),
    ],
  ] as const)(
    "retains fallback delivery and emits only the closed %s error kind",
    async (errorKind, makeError) => {
      mockGenerateText.mockRejectedValue(makeError());
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const writer = { write: jest.fn() } as unknown as UIMessageStreamWriter;
      const persist = jest.fn(async () => undefined);
      const onCost = jest.fn();

      try {
        await expect(
          generateTitleFromUserMessageWithWriter(
            makeMessage("retain the existing fallback title now"),
            writer,
            persist,
            onCost,
          ),
        ).resolves.toBe("retain the existing fallback title");
        expect(writer.write).toHaveBeenCalledWith({
          type: "data-title",
          data: { chatTitle: "retain the existing fallback title" },
          transient: true,
        });
        expect(persist).toHaveBeenCalledWith(
          "retain the existing fallback title",
        );
        expect(onCost).not.toHaveBeenCalled();
        expect(mockGenerateText).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith("chat_title_generation_failed", {
          category: "unknown_error",
          error_kind_version: 1,
          error_kind: errorKind,
        });
        expect(JSON.stringify(warn.mock.calls)).not.toContain(
          "fixture-private",
        );
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("persists the generated title after streaming it to the header", async () => {
    mockGenerateText.mockResolvedValue({
      output: { title: "Sidebar Title Update" },
    });
    const callOrder: string[] = [];
    const writer = {
      write: jest.fn(() => callOrder.push("stream")),
    } as unknown as UIMessageStreamWriter;
    const onTitleGenerated = jest.fn(async () => {
      callOrder.push("persist");
    });

    await expect(
      generateTitleFromUserMessageWithWriter(
        makeMessage("update this title everywhere"),
        writer,
        onTitleGenerated,
      ),
    ).resolves.toBe("Sidebar Title Update");

    expect(onTitleGenerated).toHaveBeenCalledWith("Sidebar Title Update");
    expect(callOrder).toEqual(["stream", "persist"]);
  });

  it("keeps the generated title when early sidebar persistence fails", async () => {
    mockGenerateText.mockResolvedValue({
      output: { title: "Resilient Generated Title" },
    });
    const writer = {
      write: jest.fn(),
    } as unknown as UIMessageStreamWriter;
    const persistenceError = new Error("database unavailable");
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      await expect(
        generateTitleFromUserMessageWithWriter(
          makeMessage("do not lose this title"),
          writer,
          async () => {
            throw persistenceError;
          },
        ),
      ).resolves.toBe("Resilient Generated Title");

      expect(writer.write).toHaveBeenCalledWith({
        type: "data-title",
        data: { chatTitle: "Resilient Generated Title" },
        transient: true,
      });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to persist generated chat title:",
        persistenceError,
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
