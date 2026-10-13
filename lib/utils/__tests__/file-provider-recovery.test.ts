import {
  convertToModelMessages,
  generateText,
  streamText,
  type UIMessage,
} from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenRouterPatchFetch } from "@/lib/ai/providers";
import { processMessageFiles } from "../file-transform-utils";
import { deserialize, serialize } from "node:v8";
import {
  TextDecoderStream as NodeTextDecoderStream,
  WritableStream as NodeWritableStream,
} from "node:stream/web";

jest.mock("server-only", () => ({}));
const mockConvexAction = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ action: mockConvexAction }),
}));

const fetchPrimitives =
  require("next/dist/compiled/@edge-runtime/primitives/fetch") as {
    Headers: typeof Headers;
    Response: typeof Response;
  };
const originalHeaders = globalThis.Headers;
const originalResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
const originalClone = globalThis.structuredClone;
const originalTextDecoderStream = globalThis.TextDecoderStream;
const originalWritableStream = globalThis.WritableStream;

const invalidDocumentMessage =
  "Failed to parse the file: The file could not be read as a valid document. It may be corrupt, truncated, or not actually a PDF.";

const attachmentMessage = (name: string, id = "message-1"): UIMessage => ({
  id,
  role: "user",
  parts: [
    { type: "text", text: "Inspect the attachment." },
    {
      type: "file",
      fileId: "stored-file",
      name,
      mediaType: "application/pdf",
    } as UIMessage["parts"][number],
  ],
});

const parserError = (message: string) =>
  new Response(JSON.stringify({ error: { message } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

const completion = () =>
  new Response(
    JSON.stringify({
      id: "synthetic-completion",
      created: 1,
      model: "synthetic-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Attachment inspection ready.",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { headers: { "content-type": "application/json" } },
  );

beforeAll(() => {
  globalThis.Headers = fetchPrimitives.Headers;
  globalThis.Response = fetchPrimitives.Response;
  globalThis.structuredClone = <T>(value: T): T =>
    deserialize(serialize(value));
  globalThis.TextDecoderStream = NodeTextDecoderStream;
  globalThis.WritableStream = NodeWritableStream;
});

afterAll(() => {
  globalThis.Headers = originalHeaders;
  globalThis.Response = originalResponse;
  globalThis.structuredClone = originalClone;
  globalThis.TextDecoderStream = originalTextDecoderStream;
  globalThis.WritableStream = originalWritableStream;
});

beforeEach(() => {
  mockConvexAction.mockResolvedValue([
    {
      url: "https://storage.example/attachment.pdf",
      mediaType: "application/pdf",
      sizeBytes: 100,
    },
  ]);
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

it.each([
  {
    name: "Report with spaces (1).pdf",
    filename: "Report_with_spaces_1.pdf",
    error: "Failed to parse the file",
    model: "deepseek/deepseek-v4.1-flash",
    engine: "mistral-ocr",
    failures: 1,
  },
  {
    name: "Résumé.pdf",
    filename: "Rsum.pdf",
    error: invalidDocumentMessage,
    model: "deepseek/deepseek-v4.1-flash",
    engine: "mistral-ocr",
    failures: 2,
  },
  {
    name: "Report with spaces (1).pdf",
    filename: "Report_with_spaces_1.pdf",
    error: invalidDocumentMessage,
    model: "z-ai/glm-5.3-flash",
    engine: undefined,
    failures: 1,
  },
])(
  "recovers a saved $name through real SDK serialization on $model",
  async ({ name, filename, error, model, engine, failures }) => {
    const originalMessage = attachmentMessage(name);
    const processed = await processMessageFiles(
      [originalMessage],
      "agent",
      "test-user",
    );
    const fetchMock = jest.fn();
    for (let index = 0; index < failures; index++) {
      fetchMock.mockResolvedValueOnce(parserError(error));
    }
    fetchMock.mockResolvedValueOnce(completion());
    const provider = createOpenRouter({
      apiKey: "synthetic-test-only",
      fetch: createOpenRouterPatchFetch(fetchMock as typeof fetch),
    });

    const result = await generateText({
      model: provider(model),
      messages: await convertToModelMessages(processed.messages),
      providerOptions: engine
        ? { openrouter: { plugins: [{ id: "file-parser", pdf: { engine } }] } }
        : undefined,
      maxRetries: 0,
    });

    expect(result.text).toBe("Attachment inspection ready.");
    expect(fetchMock).toHaveBeenCalledTimes(failures + 1);
    const initialBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(initialBody.messages[0].content).toContainEqual({
      type: "file",
      file: {
        filename,
        file_data: "https://storage.example/attachment.pdf",
      },
    });
    const recoveredBody = JSON.parse(fetchMock.mock.calls[failures][1].body);
    expect(recoveredBody.messages[0].content).not.toContainEqual(
      expect.objectContaining({ type: "file" }),
    );
    expect(JSON.stringify(recoveredBody)).toContain(
      processed.sandboxFiles[0].localPath,
    );
    expect(recoveredBody.plugins).toEqual(engine ? [] : undefined);
    expect(originalMessage.parts[1]).toMatchObject({ name });
    expect(originalMessage.parts[1]).not.toHaveProperty("filename");
    expect(processed.messages[0].parts[1]).toMatchObject({ name, filename });
  },
);

it("preserves Ask filenames when reloading saved attachments", async () => {
  globalThis.fetch = jest
    .fn()
    .mockResolvedValue(new Response("%PDF-synthetic", { status: 200 }));
  const processed = await processMessageFiles(
    [attachmentMessage("Résumé with spaces.pdf")],
    "ask",
    "test-user",
  );
  const modelMessages = await convertToModelMessages(processed.messages);
  expect(modelMessages[0].content).toContainEqual(
    expect.objectContaining({
      type: "file",
      filename: "Résumé with spaces.pdf",
      mediaType: "application/pdf",
    }),
  );
  expect(processed.sandboxFiles).toEqual([]);
});

it("streams a response after a GLM parser failure without an explicit OCR plugin", async () => {
  const processed = await processMessageFiles(
    [attachmentMessage("Report with spaces.pdf")],
    "agent",
    "test-user",
  );
  const chunks = [
    {
      choices: [
        {
          index: 0,
          delta: { content: "Attachment inspection ready." },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ];
  const fetchMock = jest
    .fn()
    .mockResolvedValueOnce(parserError(invalidDocumentMessage))
    .mockResolvedValueOnce(
      new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  const provider = createOpenRouter({
    apiKey: "synthetic-test-only",
    fetch: createOpenRouterPatchFetch(fetchMock as typeof fetch),
  });
  const onError = jest.fn();
  const result = streamText({
    model: provider("z-ai/glm-5.3-flash"),
    messages: await convertToModelMessages(processed.messages),
    maxRetries: 0,
    onError,
  });
  const streamErrors = [];
  for await (const part of result.fullStream) {
    if (part.type === "error") {
      const error = part.error as Error & { cause?: unknown };
      streamErrors.push({ message: error.message, cause: error.cause });
    }
  }
  expect(streamErrors).toEqual([]);
  expect(await result.text).toBe("Attachment inspection ready.");
  expect(await result.finishReason).toBe("stop");
  expect(onError).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("normalizes filename-only attachments in earlier Agent messages", async () => {
  const previous = attachmentMessage("unused.pdf", "previous");
  const file = previous.parts[1] as unknown as Record<string, unknown>;
  delete file.name;
  file.filename = "Previous report.pdf";
  const processed = await processMessageFiles(
    [
      previous,
      {
        id: "current",
        role: "user",
        parts: [{ type: "text", text: "Continue." }],
      },
    ],
    "agent",
    "test-user",
  );
  const modelMessages = await convertToModelMessages(processed.messages);
  expect(modelMessages[0].content).toContainEqual(
    expect.objectContaining({ type: "file", filename: "Previous_report.pdf" }),
  );
  expect(modelMessages[0].content).toContainEqual(
    expect.objectContaining({
      type: "text",
      text: expect.stringContaining('filename="Previous_report.pdf"'),
    }),
  );
  expect(processed.sandboxFiles).toEqual([]);
});

it("keeps recovery disabled when sanitized filenames collide", async () => {
  const message = attachmentMessage("a b.pdf");
  message.parts.push({ ...attachmentMessage("a_b.pdf").parts[1] });
  const processed = await processMessageFiles([message], "agent", "test-user");
  const fetchMock = jest
    .fn()
    .mockResolvedValue(parserError("Failed to parse the file"));
  const provider = createOpenRouter({
    apiKey: "synthetic-test-only",
    fetch: createOpenRouterPatchFetch(fetchMock as typeof fetch),
  });
  await expect(
    generateText({
      model: provider("z-ai/glm-5.3-flash"),
      messages: await convertToModelMessages(processed.messages),
      maxRetries: 0,
    }),
  ).rejects.toThrow("Failed to parse the file");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
