/**
 * @jest-environment node
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, generateText, type LanguageModelMiddleware } from "ai";
import {
  classifyInferenceRejection,
  getSafeProviderErrorCode,
  parseRetryAfterMs,
  withInferenceRequestRecovery,
  type InferenceAttemptDiagnostic,
} from "../inference-request-recovery";
import { INFERENCE_CYBER_MODEL_KEY } from "../inference";
import { myProvider } from "../providers";

type Model = Parameters<
  NonNullable<LanguageModelMiddleware["wrapStream"]>
>[0]["model"];
type Part =
  Awaited<ReturnType<Model["doStream"]>>["stream"] extends ReadableStream<
    infer P
  >
    ? P
    : never;

const PROMPT = "Synthetic benign prompt: summarize this changelog.";
const PROVIDER_TEXT = "Synthetic provider detail that must stay out of logs";
const REQUEST_ID = "req_synthetic_0001";
const prompt = [
  { role: "user" as const, content: [{ type: "text" as const, text: PROMPT }] },
];

const rejection = (
  status: number,
  code: string,
  headers: Record<string, string> = {},
) =>
  new Response(
    JSON.stringify({
      error: { message: PROVIDER_TEXT, type: "invalid_request_error", code },
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "x-request-id": REQUEST_ID,
        ...headers,
      },
    },
  );
const capacity = (headers?: Record<string, string>) =>
  rejection(429, "capacity_exceeded", headers);
const sse = (...chunks: object[]) =>
  new Response(
    [
      ...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`),
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
const streamed = (text: string) =>
  sse(
    {
      id: "r",
      model: "m",
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    },
    {
      id: "r",
      model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  );

function setup(
  respond: (call: number) => Response,
  observe?: (diagnostic: InferenceAttemptDiagnostic) => void,
) {
  const diagnostics: InferenceAttemptDiagnostic[] = [];
  const fetch = jest.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    respond(fetch.mock.calls.length),
  );
  const provider = createOpenAICompatible({
    name: "inference",
    baseURL: "https://inference.test/v1",
    apiKey: "synthetic-test-key",
    fetch,
  });
  const model = withInferenceRequestRecovery(provider("synthetic-model"), {
    random: () => 0.5,
    observe: observe ?? ((diagnostic) => diagnostics.push(diagnostic)),
  });
  return { fetch, diagnostics, model };
}

const rejected = (pending: PromiseLike<unknown>) =>
  Promise.resolve(pending).then(
    () => {
      throw new Error("Expected the provider call to reject");
    },
    (error: unknown) => error,
  );

async function readText(stream: ReadableStream<Part>) {
  const parts: Part[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return {
    parts,
    text: parts
      .map((part) => (part.type === "text-delta" ? part.delta : ""))
      .join(""),
  };
}

const base = {
  event: "inference_request_attempt",
  diagnostic_version: 1,
} as const;

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
    now: new Date("2026-11-19T00:00:00Z"),
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it("retries one capacity rejection after jitter and returns the recovered stream", async () => {
  const s = setup((call) => (call === 1 ? capacity() : streamed("Recovered")));
  const pending = s.model.doStream({ prompt });
  await jest.advanceTimersByTimeAsync(1499);
  expect(s.fetch).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect((await readText((await pending).stream)).text).toBe("Recovered");
  expect(s.fetch).toHaveBeenCalledTimes(2);
  expect(s.diagnostics).toEqual([
    {
      ...base,
      operation: "stream",
      attempt: 1,
      outcome: "rejected",
      retry: "scheduled",
      retry_delay_ms: 1500,
      status_code: 429,
      error_code: "capacity_exceeded",
      provider_request_id: REQUEST_ID,
    },
    {
      ...base,
      operation: "stream",
      attempt: 2,
      outcome: "accepted",
      retry_delay_ms: 1500,
    },
  ]);
  const logged = JSON.stringify(s.diagnostics);
  for (const secret of [PROMPT, PROVIDER_TEXT, "synthetic-test-key"])
    expect(logged).not.toContain(secret);
});

it("stops after one owned retry and keeps SDK retries from repeating exhausted capacity", async () => {
  const s = setup(() => capacity());
  // Summary generation's doGenerate path, with the SDK's default maxRetries.
  const outcome = rejected(generateText({ model: s.model, prompt: PROMPT }));
  await jest.advanceTimersByTimeAsync(60_000);
  const error = await outcome;
  expect(APICallError.isInstance(error)).toBe(true);
  expect(error).toMatchObject({
    statusCode: 429,
    isRetryable: false,
    message: "capacity_exceeded",
  });
  // Compaction telemetry still classifies the rewrapped error exactly.
  expect(getSafeProviderErrorCode(error)).toBe("capacity_exceeded");
  expect(JSON.stringify(error)).not.toContain(PROVIDER_TEXT);
  expect(s.fetch).toHaveBeenCalledTimes(2);
  expect(
    s.diagnostics.map((d) => [d.operation, d.attempt, d.outcome, d.retry]),
  ).toEqual([
    ["generate", 1, "rejected", "scheduled"],
    ["generate", 2, "rejected", "exhausted"],
  ]);
});

it.each([
  ["2", 2000],
  ["Thu, 19 Nov 2026 00:00:02 GMT", 2000],
  // Retry-After is a minimum; jitter still spreads immediate retries.
  ["0", 1500],
])("honors Retry-After %s within the ceiling", async (retryAfter, delay) => {
  const s = setup((call) =>
    call === 1 ? capacity({ "retry-after": retryAfter }) : streamed("ok"),
  );
  const pending = s.model.doStream({ prompt });
  await jest.advanceTimersByTimeAsync(delay - 1);
  expect(s.fetch).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  await pending;
  expect(s.fetch).toHaveBeenCalledTimes(2);
  expect(s.diagnostics[0]).toMatchObject({ retry_delay_ms: delay });
});

it.each(["3", "Thu, 19 Nov 2026 00:00:10 GMT"])(
  "proceeds to the caller's fallback without waiting when Retry-After %s exceeds 2s",
  async (retryAfter) => {
    const s = setup(() => capacity({ "retry-after": retryAfter }));
    const error = await rejected(s.model.doStream({ prompt }));
    expect(error).toMatchObject({ statusCode: 429, isRetryable: false });
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(s.diagnostics).toEqual([
      expect.objectContaining({
        attempt: 1,
        retry: "retry_after_exceeds_ceiling",
      }),
    ]);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it("stops waiting without a retry when the upstream request is canceled", async () => {
  const controller = new AbortController();
  const s = setup(() => capacity());
  const outcome = rejected(
    s.model.doStream({ prompt, abortSignal: controller.signal }),
  );
  await jest.advanceTimersByTimeAsync(500);
  controller.abort();
  expect(await outcome).toMatchObject({ name: "AbortError" });
  await jest.advanceTimersByTimeAsync(5000);
  expect(s.fetch).toHaveBeenCalledTimes(1);
  expect(s.diagnostics.at(-1)).toMatchObject({
    attempt: 2,
    outcome: "cancelled",
  });
});

it.each([
  [429, "rate_limit_exceeded"],
  [503, "capacity_exceeded"],
])("keeps existing policy for unrelated HTTP %i %s", async (status, code) => {
  const s = setup(() => rejection(status, code));
  const error = await rejected(s.model.doStream({ prompt }));
  expect(s.fetch).toHaveBeenCalledTimes(1);
  // The SDK's own error, so its default retry policy is unchanged.
  expect(error).toMatchObject({
    statusCode: status,
    isRetryable: true,
    message: PROVIDER_TEXT,
  });
  expect(s.diagnostics).toEqual([
    expect.objectContaining({ retry: "not_retryable", status_code: status }),
  ]);
});

it("reports sent request bytes, never content, for an exact context-length rejection", async () => {
  const inferenceId = "6e06c563-b393-4395-a40c-6b4b73ddb576";
  const s = setup(() =>
    rejection(400, "context_length_exceeded", {
      "x-inference-id": inferenceId,
    }),
  );
  const error = await rejected(s.model.doStream({ prompt }));
  expect(s.fetch).toHaveBeenCalledTimes(1);
  expect(classifyInferenceRejection(error)).toBe("context_length_exceeded");
  const sentBytes = new TextEncoder().encode(
    String(s.fetch.mock.calls[0][1]?.body),
  ).byteLength;
  expect(s.diagnostics).toEqual([
    {
      ...base,
      operation: "stream",
      attempt: 1,
      outcome: "rejected",
      retry: "not_retryable",
      status_code: 400,
      error_code: "context_length_exceeded",
      provider_request_id: inferenceId,
      request_body_bytes: sentBytes,
    },
  ]);
  expect(JSON.stringify(s.diagnostics)).not.toContain(PROMPT);
  const terminalError = JSON.stringify(error);
  expect(terminalError).not.toContain(PROVIDER_TEXT);
  expect(terminalError).not.toContain(PROMPT);
});

it("never retries a capacity error delivered inside a started stream", async () => {
  const s = setup(() =>
    sse({ error: { message: PROVIDER_TEXT, code: "capacity_exceeded" } }),
  );
  const { parts } = await readText((await s.model.doStream({ prompt })).stream);
  expect(parts).toContainEqual(expect.objectContaining({ type: "error" }));
  expect(s.fetch).toHaveBeenCalledTimes(1);
  expect(s.diagnostics).toEqual([]);
});

it("keeps recovering when the diagnostics sink fails", async () => {
  const s = setup(
    (call) => (call === 1 ? capacity() : streamed("ok")),
    () => {
      throw new Error("sink unavailable");
    },
  );
  const pending = s.model.doStream({ prompt });
  await jest.advanceTimersByTimeAsync(1500);
  expect((await readText((await pending).stream)).text).toBe("ok");
});

it.each([
  ["1.5", 1500],
  ["soon", undefined],
  ["-1", undefined],
])("parses Retry-After %s", (value, expected) => {
  expect(parseRetryAfterMs(value, Date.now())).toBe(expected);
});

it("installs recovery on the registered Inference model with content-free logs", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "info").mockImplementation(() => {});
  const fetch = jest
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () =>
      fetch.mock.calls.length === 1 ? capacity() : streamed("Registered"),
    );
  const model = myProvider.languageModel(INFERENCE_CYBER_MODEL_KEY) as Model;
  const pending = model.doStream({ prompt });
  await jest.advanceTimersByTimeAsync(2000);
  expect((await readText((await pending).stream)).text).toBe("Registered");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[0][0])).toBe(
    "https://api.inference.net/v1/chat/completions",
  );
  const [line] = warn.mock.calls[0] as [string];
  expect(JSON.parse(line)).toMatchObject({
    event: "inference_request_attempt",
    error_code: "capacity_exceeded",
  });
  expect(line).not.toContain(PROVIDER_TEXT);
});
