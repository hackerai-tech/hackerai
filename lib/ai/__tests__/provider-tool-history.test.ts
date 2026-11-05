import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAI } from "@ai-sdk/openai";
import {
  WritableStream as NodeWritableStream,
  TextDecoderStream as NodeTextDecoderStream,
} from "node:stream/web";
import { serialize, deserialize } from "node:v8";
import {
  convertToModelMessages,
  generateText,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { guardLanguageModelProviderResponse } from "../provider-response-guard";
import { namespaceLanguageModelToolCalls } from "../tool-call-id-namespace";

const originalWritableStream = globalThis.WritableStream;
const originalTextDecoderStream = globalThis.TextDecoderStream;
const originalStructuredClone = globalThis.structuredClone;
beforeAll(() => {
  globalThis.WritableStream = NodeWritableStream as typeof WritableStream;
  globalThis.TextDecoderStream =
    NodeTextDecoderStream as typeof TextDecoderStream;
  globalThis.structuredClone = (value) => deserialize(serialize(value));
});
afterAll(() => {
  globalThis.WritableStream = originalWritableStream;
  globalThis.TextDecoderStream = originalTextDecoderStream;
  globalThis.structuredClone = originalStructuredClone;
});

const invalidInputs = [
  undefined,
  null,
  '{"command":"PRIVATE_ARGUMENT_CANARY',
  [],
  7,
  false,
  "null",
];
const errorText = "The tool was not executed. Correct the arguments and retry.";

const savedHistory = (): UIMessage[] =>
  [
    {
      id: "saved-assistant",
      role: "assistant",
      parts: [
        ...invalidInputs.map((rawInput, index) => ({
          type: "tool-run_terminal_cmd",
          toolCallId: `failed-${index}`,
          state: "output-error",
          rawInput,
          errorText,
        })),
        {
          type: "tool-run_terminal_cmd",
          toolCallId: "completed",
          state: "output-available",
          input: {
            command: "printf DONE",
            nested: { values: [1, null, false] },
          },
          output: "DONE",
        },
        {
          type: "tool-run_terminal_cmd",
          toolCallId: "schema-error",
          state: "output-error",
          input: {
            unexpected:
              "Preserve valid JSON objects even if the tool schema rejected them",
          },
          errorText,
        },
      ],
    },
    {
      id: "continue",
      role: "user",
      parts: [{ type: "text", text: "Continue" }],
    },
  ] as UIMessage[];

describe("persisted tool arguments in provider history", () => {
  it.each(["chat", "responses"] as const)(
    "keeps OpenAI %s wire arguments object-shaped",
    async (route) => {
      let payload: any;
      const provider = createOpenAI({
        apiKey: "test-only-not-a-credential",
        fetch: async (_url, init) => {
          payload = JSON.parse(String(init?.body));
          throw new Error("CAPTURE_ONLY");
        },
      });
      const model = guardLanguageModelProviderResponse(
        provider[route]("test-model"),
      );
      if (typeof model === "string") throw new Error("Expected model object");
      const prompt = await convertToModelMessages(savedHistory());
      await expect(model.doGenerate({ prompt } as never)).rejects.toThrow(
        "CAPTURE_ONLY",
      );
      const args =
        route === "chat"
          ? payload.messages
              .flatMap((message: any) => message.tool_calls ?? [])
              .map((call: any) => call.function.arguments)
          : payload.input
              .filter((item: any) => item.type === "function_call")
              .map((item: any) => item.arguments);
      expect(
        args
          .slice(0, invalidInputs.length)
          .map((input: string) => JSON.parse(input)),
      ).toEqual(invalidInputs.map(() => ({})));
      expect(JSON.parse(args[invalidInputs.length])).toEqual({
        command: "printf DONE",
        nested: { values: [1, null, false] },
      });
    },
  );
  it.each(["generate", "stream"] as const)(
    "repairs replay on %s without mutating history or executing historical calls",
    async (method) => {
      const canonical = JSON.parse(
        JSON.stringify(savedHistory()),
      ) as UIMessage[];
      const original = JSON.stringify(canonical);
      const payloads: any[] = [];
      const fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        payloads.push(body);
        const calls = body.messages.flatMap(
          (message: any) => message.tool_calls ?? [],
        );
        const invalid = calls.some((call: any) => {
          try {
            const input = JSON.parse(call.function.arguments);
            return (
              input === null ||
              typeof input !== "object" ||
              Array.isArray(input)
            );
          } catch {
            return true;
          }
        });
        const Response =
          require("next/dist/compiled/@edge-runtime/primitives/fetch").Response;
        if (invalid)
          return new Response(
            JSON.stringify({
              error: {
                message: "Historical function arguments must encode an object",
                code: 400,
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        const base = { id: "test-response", created: 0, model: "test/model" };
        if (body.stream) {
          const chunks = [
            {
              ...base,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "Continued safely" },
                  finish_reason: null,
                },
              ],
            },
            {
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 2,
                total_tokens: 12,
              },
            },
          ];
          return new Response(
            chunks
              .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
              .join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(
          JSON.stringify({
            ...base,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Continued safely" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      });
      const execute = jest.fn();
      const report = jest.fn();
      const messages = await convertToModelMessages(canonical);
      const messageSnapshot = JSON.stringify(messages);
      // A fallback or child continuation rebuilds a provider projection from the
      // same saved messages. Each projection must repair independently.
      for (const namespace of [undefined, "child-resume"]) {
        const base = createOpenRouter({
          apiKey: "test-only-not-a-credential",
          fetch: fetch as typeof globalThis.fetch,
        })("test/model");
        const guarded = guardLanguageModelProviderResponse(base, {
          onPromptRepaired: report,
        });
        const options = {
          model: namespace
            ? namespaceLanguageModelToolCalls(guarded, namespace)
            : guarded,
          messages,
          tools: {
            run_terminal_cmd: tool({
              inputSchema: z.object({ command: z.string() }),
              execute,
            }),
          },
          maxRetries: 0,
        };
        const result =
          method === "generate"
            ? await generateText(options)
            : streamText(options);
        expect(await result.text).toBe("Continued safely");
      }
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify(canonical)).toBe(original);
      expect(JSON.stringify(messages)).toBe(messageSnapshot);
      expect(payloads).toHaveLength(2);
      for (const body of payloads) {
        const calls = body.messages.flatMap(
          (message: any) => message.tool_calls ?? [],
        );
        expect(calls.map((call: any) => call.id)).toEqual([
          ...invalidInputs.map((_, index) => `failed-${index}`),
          "completed",
          "schema-error",
        ]);
        expect(
          calls
            .slice(0, invalidInputs.length)
            .map((call: any) => JSON.parse(call.function.arguments)),
        ).toEqual(invalidInputs.map(() => ({})));
        expect(
          JSON.parse(calls[invalidInputs.length].function.arguments),
        ).toEqual({
          command: "printf DONE",
          nested: { values: [1, null, false] },
        });
        expect(
          JSON.parse(calls[invalidInputs.length + 1].function.arguments),
        ).toEqual({
          unexpected:
            "Preserve valid JSON objects even if the tool schema rejected them",
        });
        const results = body.messages.filter(
          (message: any) => message.role === "tool",
        );
        expect(results.map((message: any) => message.tool_call_id)).toEqual(
          calls.map((call: any) => call.id),
        );
        expect(results.map((message: any) => message.content)).toEqual([
          ...invalidInputs.map(() => errorText),
          "DONE",
          errorText,
        ]);
        expect(JSON.stringify(body)).not.toContain("PRIVATE_ARGUMENT_CANARY");
      }
      expect(report).toHaveBeenCalledTimes(2);
      expect(report).toHaveBeenCalledWith({
        removedToolCallCount: 0,
        removedToolResultCount: 0,
        repairedToolInputCount: invalidInputs.length,
      });
      expect(JSON.stringify(report.mock.calls)).not.toContain(
        "PRIVATE_ARGUMENT_CANARY",
      );
    },
  );
});
