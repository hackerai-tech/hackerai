import { deserialize, serialize } from "node:v8";
import { TextDecoderStream, WritableStream } from "node:stream/web";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, streamText, type ModelMessage } from "ai";
import {
  addCacheBreakpointToLastUserMessage,
  buildSystemPrompt,
} from "../chat-stream-helpers";
import {
  systemPrompt,
  SYSTEM_PROMPT_RUNTIME_BOUNDARY,
} from "@/lib/system-prompt";

jest.mock("server-only", () => ({}));
jest.mock("@/lib/db/actions", () => ({ getNotes: jest.fn() }));

const fetchPrimitives =
  require("next/dist/compiled/@edge-runtime/primitives/fetch") as {
    Headers: typeof Headers;
    Response: typeof Response;
  };
const originalClone = globalThis.structuredClone;
const originalWritableStream = globalThis.WritableStream;
const originalDecoderStream = globalThis.TextDecoderStream;
const originalHeaders = globalThis.Headers;
const originalResponse = globalThis.Response;
beforeAll(() => {
  globalThis.structuredClone = <T>(value: T): T =>
    deserialize(serialize(value));
  globalThis.TextDecoderStream =
    TextDecoderStream as typeof globalThis.TextDecoderStream;
  globalThis.WritableStream =
    WritableStream as typeof globalThis.WritableStream;
  globalThis.Headers = fetchPrimitives.Headers;
  globalThis.Response = fetchPrimitives.Response;
});
afterAll(() => {
  globalThis.structuredClone = originalClone;
  globalThis.TextDecoderStream = originalDecoderStream;
  globalThis.WritableStream = originalWritableStream;
  globalThis.Headers = originalHeaders;
  globalThis.Response = originalResponse;
});

const claudeRoute = "anthropic/claude-cache-test";
const makePrompt = (
  host: string,
  name: string,
  mode: "ask" | "agent" = "agent",
) =>
  systemPrompt(
    "synthetic-user",
    mode,
    "pro",
    "agent-model",
    {
      nickname: name,
      occupation: null,
      additional_info: null,
      traits: null,
      include_notes: true,
    },
    `<sandbox_environment>Commands run directly on ${host}.</sandbox_environment>`,
    "ask_approval",
    true,
  );

it("keeps an identical instruction prefix across host, profile and date changes", async () => {
  const first = await makePrompt("first-host", "Alice");
  const second = (await makePrompt("second-host", "Bob")).replace(
    /^The current date is .+$/m,
    "The current date is another day.",
  );
  const a = buildSystemPrompt(first, claudeRoute);
  const b = buildSystemPrompt(second, claudeRoute);
  if (!Array.isArray(a) || !Array.isArray(b))
    throw new Error("Expected two system blocks");
  expect(a).toHaveLength(2);
  expect(a[0]).toEqual(b[0]);
  expect(a[0].content).toContain("Agent tool approval mode: Ask for approval.");
  expect(a[0].content).toContain("<generic_delegation>");
  expect(a[0].content).not.toContain("The current date is");
  expect(a[1].content).toContain("first-host");
  expect(a[1].content).toContain("Alice");
  expect(b[1].content).toContain("second-host");
  expect(b[1].content).toContain("Bob");
  expect(a.map((message) => message.content).join("")).toBe(first);
  expect(b.map((message) => message.content).join("")).toBe(second);
});

it("refreshes the runtime date across midnight without changing the instruction prefix", async () => {
  jest.useFakeTimers();
  try {
    jest.setSystemTime(new Date(2026, 9, 2, 23, 59, 59));
    const first = buildSystemPrompt(
      await makePrompt("host", "Alice"),
      claudeRoute,
    );
    jest.setSystemTime(new Date(2026, 9, 3, 0, 0, 1));
    const second = buildSystemPrompt(
      await makePrompt("host", "Alice"),
      claudeRoute,
    );
    if (!Array.isArray(first) || !Array.isArray(second))
      throw new Error("Expected two system blocks");
    expect(first[0]).toEqual(second[0]);
    expect(first[1].content).toContain("Friday, October 2, 2026");
    expect(second[1].content).toContain("Saturday, October 3, 2026");
  } finally {
    jest.useRealTimers();
  }
});

it("preserves cloud, local, Ask and approval distinctions without promoting context", async () => {
  const cloud = await systemPrompt(
    "user",
    "agent",
    "pro",
    "agent-model",
    null,
    null,
    "full_access",
  );
  const local = await makePrompt("local-host", "Alice");
  const ask = await makePrompt("unused-host", "Alice", "ask");
  expect(cloud).toContain("<sandbox_environment>");
  expect(cloud).toContain("Agent tool approval mode: Full access.");
  expect(local).not.toContain("<sandbox_tool_recipes>");
  expect(ask).not.toContain("unused-host");
  expect(ask).not.toContain("Agent tool approval mode");
  for (const prompt of [cloud, local, ask]) {
    const messages = buildSystemPrompt(prompt, claudeRoute);
    if (!Array.isArray(messages)) throw new Error("Expected two system blocks");
    expect(messages.every((message) => message.role === "system")).toBe(true);
    expect(messages.map((message) => message.content).join("")).toBe(prompt);
    expect(buildSystemPrompt(prompt, "agent-model")).toBe(prompt);
  }
});

it("does not let marker text in host or profile data create more cache blocks", async () => {
  const prompt = await makePrompt(
    `host${SYSTEM_PROMPT_RUNTIME_BOUNDARY}host-tail`,
    `name${SYSTEM_PROMPT_RUNTIME_BOUNDARY}name-tail`,
  );
  const messages = buildSystemPrompt(prompt, claudeRoute);
  if (!Array.isArray(messages)) throw new Error("Expected two system blocks");
  expect(messages).toHaveLength(2);
  expect(messages[0].content).not.toContain("host-tail");
  expect(messages[0].content).not.toContain("name-tail");
  expect(messages.map((message) => message.content).join("")).toBe(prompt);
});

it("retains the single-message shape for legacy prompts and other providers", () => {
  expect(
    buildSystemPrompt("Stored prompt without a boundary", claudeRoute),
  ).toEqual({
    role: "system",
    content: "Stored prompt without a boundary",
    providerOptions: { openrouter: { cacheControl: { type: "ephemeral" } } },
  });
  expect(buildSystemPrompt("Unchanged", "agent-model")).toBe("Unchanged");
});

it.each([false, true])(
  "serializes both system cache points and the user breakpoint through the real SDK (stream=%s)",
  async (streaming) => {
    let body:
      | {
          messages: Array<{
            role: string;
            content: Array<{
              type: string;
              text: string;
              cache_control?: { type: string };
            }>;
          }>;
        }
      | undefined;
    const provider = createOpenRouter({
      apiKey: "synthetic-test-key",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        const base = { id: "test-completion", model: claudeRoute, created: 1 };
        if (streaming) {
          const chunks = [
            {
              ...base,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "OK" },
                  finish_reason: null,
                },
              ],
            },
            {
              ...base,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 1,
                total_tokens: 101,
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
        return Response.json({
          ...base,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "OK" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 1,
            total_tokens: 101,
          },
        });
      },
    });
    const prompt = await makePrompt("synthetic-host", "Alice");
    const messages = addCacheBreakpointToLastUserMessage(
      [{ role: "user", content: "Reply OK" }],
      claudeRoute,
    ) as ModelMessage[];
    const options = {
      model: provider(claudeRoute),
      system: buildSystemPrompt(prompt, claudeRoute),
      messages,
      maxRetries: 0,
    };
    const text = streaming
      ? await streamText(options).text
      : (await generateText(options)).text;
    expect(text).toBe("OK");
    expect(body?.messages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "user",
    ]);
    expect(
      body?.messages.map((message) => message.content[0].cache_control),
    ).toEqual(Array(3).fill({ type: "ephemeral" }));
    expect(
      body?.messages
        .slice(0, 2)
        .map((message) => message.content[0].text)
        .join(""),
    ).toBe(prompt);
  },
);
