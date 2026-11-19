/**
 * @jest-environment node
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { UIMessage, UIMessageStreamWriter } from "ai";
import {
  APICallError,
  JSONParseError,
  NoOutputGeneratedError,
  TypeValidationError,
} from "ai";
import { MockLanguageModelV3 } from "ai/test";

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

  describe("UTF-16 scalar boundaries", () => {
    const ROCKET = "\u{1F680}";

    const rejectTitleModel = () =>
      mockGenerateText.mockRejectedValue(
        new APICallError({
          message: "provider unavailable",
          url: "https://provider.example/",
          requestBodyValues: {},
          statusCode: 503,
        }),
      );

    it.each([
      [
        "drops an emoji that would be split by the title limit",
        `${"a".repeat(99)}${ROCKET}`,
        "a".repeat(99),
      ],
      [
        "keeps an emoji that ends exactly at the title limit",
        `${"a".repeat(98)}${ROCKET}`,
        `${"a".repeat(98)}${ROCKET}`,
      ],
      ["keeps the ASCII limit", "a".repeat(150), "a".repeat(100)],
      ["keeps the BMP limit", "é".repeat(150), "é".repeat(100)],
    ])(
      "%s in the delivered and persisted fallback title",
      async (_name, message, expected) => {
        rejectTitleModel();
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        const writer = { write: jest.fn() } as unknown as UIMessageStreamWriter;
        const persist = jest.fn(async () => undefined);

        try {
          const title = await generateTitleFromUserMessageWithWriter(
            makeMessage(message),
            writer,
            persist,
          );

          expect(title).toBe(expected);
          expect(title!.isWellFormed()).toBe(true);
          expect(title!.length).toBeLessThanOrEqual(100);
          expect(writer.write).toHaveBeenCalledWith({
            type: "data-title",
            data: { chatTitle: expected },
            transient: true,
          });
          expect(persist).toHaveBeenCalledWith(expected);
        } finally {
          warn.mockRestore();
        }
      },
    );

    it.each([
      ["head", `${"a".repeat(3997)}${ROCKET}${"b".repeat(5000)}`],
      ["tail", `${"a".repeat(5000)}${ROCKET}${"b".repeat(3997)}`],
    ])(
      "keeps the title prompt well-formed when an emoji crosses the %s truncation boundary",
      async (_edge, message) => {
        mockGenerateText.mockResolvedValue({ output: { title: "Long Input" } });

        await generateTitleFromUserMessage(makeMessage(message));

        const generateTextOptions = mockGenerateText.mock.calls[0][0] as {
          messages: [{ content: string }];
        };
        const prompt = generateTextOptions.messages[0].content;
        const context = prompt.split("### User Message:\n")[1];
        expect(message.isWellFormed()).toBe(true);
        expect(prompt.isWellFormed()).toBe(true);
        expect(context).toContain("...");
        expect(context.length).toBeLessThanOrEqual(8000);
        expect(context.startsWith("a".repeat(3997))).toBe(true);
        expect(context.endsWith("b".repeat(3997))).toBe(true);
      },
    );
  });

  describe("generated title quote cleanup", () => {
    it.each([
      ["Explain `curl -I`", "Explain `curl -I`"],
      ['Rename "foo" to "bar"', 'Rename "foo" to "bar"'],
      ['"foo" Variable Naming', '"foo" Variable Naming'],
      ["'sudo' Permission Errors", "'sudo' Permission Errors"],
      ['"Debug login"', "Debug login"],
      ["'Debug login'", "Debug login"],
      ["`Debug login`", "Debug login"],
      ['"Debug the user\'s login"', "Debug the user's login"],
      ["User's Login Bug", "User's Login Bug"],
      ['"foo" and "bar"', '"foo" and "bar"'],
    ])("normalizes %j to %j", async (generated, expected) => {
      mockGenerateText.mockResolvedValue({ output: { title: generated } });

      await expect(
        generateTitleFromUserMessage(makeMessage("title quote check")),
      ).resolves.toBe(expected);
    });

    it.each(['"', "'", "`", '""', '"""', "``` `"])(
      "falls back to the user message when the generated title is only quote delimiters %j",
      async (generated) => {
        mockGenerateText.mockResolvedValue({ output: { title: generated } });

        await expect(
          generateTitleFromUserMessage(makeMessage("title quote check")),
        ).resolves.toBe("title quote check");
      },
    );
  });

  it.each(["title", '  "TiTlE"  '])(
    "streams and persists a useful fallback when the model echoes %j",
    async (title) => {
      mockGenerateText.mockResolvedValue({ output: { title } });
      const write = jest.fn();
      const writer = { write } as unknown as UIMessageStreamWriter;
      const persist = jest.fn(async (_title: string) => undefined);
      const expected = "List the ingredients for tomato";

      await generateTitleFromUserMessageWithWriter(
        makeMessage("List the ingredients for tomato soup"),
        writer,
        persist,
      );

      expect(write).toHaveBeenCalledWith({
        type: "data-title",
        data: { chatTitle: expected },
        transient: true,
      });
      expect(persist).toHaveBeenCalledWith(expected);
    },
  );

  // Scope: the shared redactor's recognized credential patterns, not every
  // possible secret. Fixtures are synthetic.
  describe("credential redaction", () => {
    const CANARY = "SYNTHETIC_TITLE_CANARY_90341";

    const credentials = [
      ["a password assignment", `password=${CANARY}`],
      ["a quoted multi-word password", `password="synthetic phrase ${CANARY}"`],
      ["an authorization header", `Authorization: Bearer ${CANARY}`],
      ["a bare bearer credential", `Bearer ${CANARY}`],
      [
        "an environment assignment",
        `EXAMPLE_DATABASE_URL=postgres://synthetic:${CANARY}@db.example/app`,
      ],
      ["a provider key", `sk-${CANARY}`],
      [
        "a signed URL",
        `https://bucket.example/report.pdf?X-Amz-Signature=${CANARY}`,
      ],
    ] as const;

    const runWithWriter = async (message: string) => {
      const write = jest.fn();
      const writer = { write } as unknown as UIMessageStreamWriter;
      const persist = jest.fn(async (_title: string) => undefined);
      const onCost = jest.fn();
      const title = await generateTitleFromUserMessageWithWriter(
        makeMessage(message),
        writer,
        persist,
        onCost,
      );
      const prompt = (
        mockGenerateText.mock.calls[0][0] as {
          messages: [{ content: string }];
        }
      ).messages[0].content;
      return { title, prompt, streamed: write.mock.calls, persist, onCost };
    };

    it.each(credentials)(
      "keeps %s out of the prompt and the generated title",
      async (_name, credential) => {
        mockGenerateText.mockResolvedValue({
          output: { title: `Debug ${credential}` },
          usage: { raw: { cost: 0.0021 } },
        });

        const { title, prompt, streamed, persist, onCost } =
          await runWithWriter(`${credential} breaks login`);

        expect(prompt).toContain("breaks login");
        expect(prompt).not.toContain(CANARY);
        expect(title).toMatch(/^Debug .*\[Redacted/);
        expect(title).not.toContain(CANARY);
        expect(streamed).toEqual([
          [{ type: "data-title", data: { chatTitle: title }, transient: true }],
        ]);
        expect(persist.mock.calls).toEqual([[title]]);
        expect(onCost).toHaveBeenCalledWith(0.0021);
      },
    );

    it.each(credentials)(
      "keeps %s out of the prompt and the fallback title",
      async (_name, credential) => {
        mockGenerateText.mockRejectedValue(
          new APICallError({
            message: "provider unavailable",
            url: "https://provider.example/",
            requestBodyValues: {},
            statusCode: 503,
          }),
        );
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

        try {
          const { title, prompt, streamed, persist, onCost } =
            await runWithWriter(`${credential} breaks login`);

          expect(prompt).not.toContain(CANARY);
          expect(title).toMatch(/\[Redacted.* breaks login$/);
          expect(title).not.toContain(CANARY);
          expect(streamed).toEqual([
            [
              {
                type: "data-title",
                data: { chatTitle: title },
                transient: true,
              },
            ],
          ]);
          expect(persist.mock.calls).toEqual([[title]]);
          expect(onCost).not.toHaveBeenCalled();
        } finally {
          warn.mockRestore();
        }
      },
    );

    it("unwraps a quoted generated title before redacting its credential", async () => {
      mockGenerateText.mockResolvedValue({
        output: { title: `"Fix login password=${CANARY}"` },
      });

      await expect(
        generateTitleFromUserMessage(makeMessage("login check")),
      ).resolves.toBe('Fix login password="[Redacted]"');
    });

    it("redacts before the prompt's middle truncation can drop the field name", async () => {
      mockGenerateText.mockResolvedValue({ output: { title: "Long Input" } });
      // The value alone opens the kept tail; its key falls in the dropped middle.
      const keptTail = `${CANARY} ${"b".repeat(3998 - CANARY.length - 1)}`;
      const message = `${"a".repeat(5000)} password=${keptTail}`;

      await generateTitleFromUserMessage(makeMessage(message));

      const prompt = (
        mockGenerateText.mock.calls[0][0] as {
          messages: [{ content: string }];
        }
      ).messages[0].content;
      const context = prompt.split("### User Message:\n")[1];
      expect(context.length).toBeLessThanOrEqual(8000);
      expect(context.startsWith("a".repeat(3998))).toBe(true);
      expect(context.endsWith("b".repeat(3000))).toBe(true);
      expect(prompt).not.toContain(CANARY);
    });

    it("keeps ordinary token vocabulary and security identifiers", async () => {
      const message = "JWT token refresh CVE-2024-3094 tokenCount=42";
      mockGenerateText.mockResolvedValueOnce({
        output: { title: "OAuth password reset max_tokens=4096" },
      });

      await expect(
        generateTitleFromUserMessage(makeMessage(message)),
      ).resolves.toBe("OAuth password reset max_tokens=4096");
      expect(mockGenerateText.mock.calls[0][0].messages[0].content).toContain(
        `### User Message:\n${message}`,
      );

      mockGenerateText.mockRejectedValueOnce(new Error("provider failed"));
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await expect(
          generateTitleFromUserMessage(makeMessage(message)),
        ).resolves.toBe(message);
      } finally {
        warn.mockRestore();
      }
    });
  });

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

describe("generateTitleFromUserMessageWithWriter with the installed AI SDK", () => {
  // Only model I/O is controlled; generateText, retries and abort are real.
  const loadWithInstalledSdk = () => {
    // The stubbed "ai" module is cached; reset so the factory below applies.
    jest.resetModules();
    jest.doMock("ai", () => jest.requireActual("ai"));
    return (require("../index") as typeof import("../index"))
      .generateTitleFromUserMessageWithWriter;
  };

  const useTitleModel = (model: MockLanguageModelV3) =>
    mockLanguageModel.mockReturnValueOnce(
      model as unknown as { modelName: string },
    );

  it("aborts a stalled title request and delivers the fallback without inventing cost", async () => {
    const generateWithWriter = loadWithInstalledSdk();
    let providerCalls = 0;
    let providerAborted = false;
    let releaseProvider = () => {};
    useTitleModel(
      new MockLanguageModelV3({
        doGenerate: ({ abortSignal }) =>
          new Promise((_resolve, reject) => {
            providerCalls++;
            releaseProvider = () =>
              reject(new Error("stalled provider released by the test"));
            abortSignal?.addEventListener(
              "abort",
              () => {
                providerAborted = true;
                reject(abortSignal.reason);
              },
              { once: true },
            );
          }),
      }),
    );
    const writer = { write: jest.fn() } as unknown as UIMessageStreamWriter;
    const persist = jest.fn(async () => undefined);
    const onCost = jest.fn();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const generation = generateWithWriter(
      makeMessage("Check a bounded synthetic title request"),
      writer,
      persist,
      onCost,
    );
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    const stillPending = new Promise<"still pending">((resolve) => {
      observationTimer = setTimeout(() => resolve("still pending"), 9_000);
    });

    try {
      await expect(Promise.race([generation, stillPending])).resolves.toBe(
        "Check a bounded synthetic title",
      );
      expect(providerAborted).toBe(true);
      expect(providerCalls).toBe(1);
      expect(writer.write).toHaveBeenCalledTimes(1);
      expect(writer.write).toHaveBeenCalledWith({
        type: "data-title",
        data: { chatTitle: "Check a bounded synthetic title" },
        transient: true,
      });
      expect(persist).toHaveBeenCalledTimes(1);
      expect(persist).toHaveBeenCalledWith("Check a bounded synthetic title");
      expect(onCost).not.toHaveBeenCalled();
    } finally {
      clearTimeout(observationTimer);
      releaseProvider();
      await generation;
      warn.mockRestore();
    }
  }, 15_000);

  it("reports provider usage cost once for a successful title", async () => {
    const generateWithWriter = loadWithInstalledSdk();
    useTitleModel(
      new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [
            { type: "text", text: JSON.stringify({ title: "Costed Title" }) },
          ],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: {
              total: 120,
              noCache: 120,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 6, text: 6, reasoning: undefined },
            raw: { cost: 0.0042 },
          },
          warnings: [],
        }),
      }),
    );
    const writer = { write: jest.fn() } as unknown as UIMessageStreamWriter;
    const persist = jest.fn(async () => undefined);
    const onCost = jest.fn();

    await expect(
      generateWithWriter(
        makeMessage("track title generation cost"),
        writer,
        persist,
        onCost,
      ),
    ).resolves.toBe("Costed Title");

    expect(onCost).toHaveBeenCalledTimes(1);
    expect(onCost).toHaveBeenCalledWith(0.0042);
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith("Costed Title");
  });

  it.each(["succeeds", "fails"] as const)(
    "keeps a synthetic credential out of the provider prompt and delivered title when the model %s",
    async (outcome) => {
      const canary = "SYNTHETIC_TITLE_CANARY_90341";
      const generateWithWriter = loadWithInstalledSdk();
      const providerPrompts: string[] = [];
      useTitleModel(
        new MockLanguageModelV3({
          doGenerate: async ({ prompt }) => {
            providerPrompts.push(JSON.stringify(prompt));
            if (outcome === "fails") {
              throw new Error("synthetic provider failure");
            }
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ title: `Login password=${canary}` }),
                },
              ],
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: 120,
                  noCache: 120,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 6, text: 6, reasoning: undefined },
              },
              warnings: [],
            };
          },
        }),
      );
      const write = jest.fn();
      const writer = { write } as unknown as UIMessageStreamWriter;
      const persist = jest.fn(async (_title: string) => undefined);
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

      try {
        const title = await generateWithWriter(
          makeMessage(`password=${canary} rejected at login`),
          writer,
          persist,
        );

        expect(providerPrompts.length).toBeGreaterThanOrEqual(1);
        expect(providerPrompts.join("\n")).toContain("rejected at login");
        expect(providerPrompts.join("\n")).not.toContain(canary);
        expect(title).toBe(
          outcome === "succeeds"
            ? 'Login password="[Redacted]"'
            : 'password="[Redacted]" rejected at login',
        );
        expect(write.mock.calls).toEqual([
          [{ type: "data-title", data: { chatTitle: title }, transient: true }],
        ]);
        expect(persist.mock.calls).toEqual([[title]]);
      } finally {
        warn.mockRestore();
      }
    },
  );
});
