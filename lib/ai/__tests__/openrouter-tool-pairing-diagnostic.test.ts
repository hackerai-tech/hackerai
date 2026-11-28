import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  APICallError,
  streamText,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { TextDecoderStream, WritableStream } from "node:stream/web";
import { withOpenRouterStreamErrorContext } from "../openrouter-stream-error-context";
import {
  describeBedrockToolPairing,
  reportBedrockToolPairingRejection,
} from "../openrouter-tool-pairing-diagnostic";

jest.mock("server-only", () => ({}), { virtual: true });

const edge = require("next/dist/compiled/@edge-runtime/primitives/fetch");
const replacements = {
  Request: edge.Request,
  Response: edge.Response,
  Headers: edge.Headers,
  TextDecoderStream,
  WritableStream,
};
const descriptors = Object.keys(replacements).map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
beforeAll(() => {
  for (const [key, value] of Object.entries(replacements))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
});
afterAll(() => {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const EVENT = "openrouter_bedrock_tool_pairing_diagnostic";
const diagnostics = () =>
  warn.mock.calls.flatMap(([value]) =>
    typeof value === "string" && value.includes(EVENT)
      ? [JSON.parse(value)]
      : [],
  );

// Synthetic canaries: none may appear in any diagnostic output. ai@6 rejects
// unpaired prompts before the SDK, so the SDK boundary uses a paired history
// whose namespaced ID exceeds Bedrock's 64-character limit.
const CALL_ID = "PRIVATE_CALL_ID.ns:".padEnd(68, "x");
const TOOL = "PRIVATE_TOOL";
const REJECTION = {
  code: 400,
  message:
    "[Amazon Bedrock] invalid_request: invalid_tool_result unmatched tool_calls PRIVATE_ERROR_CANARY",
  type: "invalid_request",
};
const MESSAGES: ModelMessage[] = [
  { role: "user", content: "PRIVATE_USER_CANARY" },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: CALL_ID,
        toolName: TOOL,
        input: { secret: "PRIVATE_INPUT_CANARY" },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: CALL_ID,
        toolName: TOOL,
        output: { type: "text", value: "PRIVATE_OUTPUT_CANARY" },
      },
    ],
  },
];
const EXPECTED_PAIRING = {
  message_count: 3,
  assistant_tool_call_count: 1,
  tool_result_count: 1,
  unmatched_tool_call_count: 0,
  unmatched_tool_result_count: 0,
  tool_id_over_64_count: 2,
  tool_id_invalid_alphabet_count: 0,
  max_tool_id_length: 68,
};

function expectNoPrivateValues() {
  for (const [value] of warn.mock.calls)
    expect(String(value)).not.toMatch(
      /PRIVATE_|synthetic-unused|invalid_request|Bedrock\]/,
    );
}

async function runStream(model: LanguageModel, errorCount = 1) {
  const errors: unknown[] = [];
  const stream = streamText({
    model,
    messages: MESSAGES,
    maxRetries: 0,
    onError: ({ error }) => {
      errors.push(error);
    },
  });
  const parts = [];
  for await (const part of stream.fullStream) parts.push(part);
  expect(errors).toHaveLength(errorCount);
  // The emitted error parts carry the same objects, in order, as onError.
  const errorParts = parts.flatMap((part) =>
    part.type === "error" ? [part.error] : [],
  );
  expect(errorParts).toHaveLength(errorCount);
  errorParts.forEach((error, index) => expect(error).toBe(errors[index]));
  return { error: errors[0], partTypes: parts.map((part) => part.type) };
}

function sdkModel(response: () => Response, optIn: boolean) {
  const fetch = jest.fn().mockImplementation(async () => response());
  const model = withOpenRouterStreamErrorContext(
    createOpenRouter({ apiKey: "synthetic-unused", fetch }).chat(
      "x-ai/grok-4.6",
    ),
    { bedrockToolPairingDiagnostic: optIn },
  );
  return { fetch, model };
}

const httpRejection = () =>
  new Response(JSON.stringify({ error: REJECTION }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
const inBandRejection =
  (errors = [REJECTION]) =>
  () =>
    new Response(
      errors.map((error) => `data: ${JSON.stringify({ error })}\n\n`).join("") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );

it("reports an actual SDK HTTP 400 rejection from its own request body without changing the error", async () => {
  const plain = sdkModel(httpRejection, false);
  const baseline = await runStream(plain.model);
  expect(diagnostics()).toEqual([]);

  const opted = sdkModel(httpRejection, true);
  const observed = await runStream(opted.model);
  expect(APICallError.isInstance(observed.error)).toBe(true);
  expect(observed.error).toMatchObject({
    statusCode: 400,
    message: (baseline.error as Error).message,
    isRetryable: false,
  });
  expect(observed.partTypes).toEqual(baseline.partTypes);
  expect(opted.fetch).toHaveBeenCalledTimes(1);
  expect(diagnostics()).toEqual([
    expect.objectContaining({
      diagnostic_version: 1,
      source: "sdk_http_rejection",
      evidence: "complete",
      ...EXPECTED_PAIRING,
    }),
  ]);
  expectNoPrivateValues();
});

it("reports a returned in-band 400 error part once per call without altering stream order", async () => {
  const twoErrors = inBandRejection([REJECTION, { ...REJECTION }]);
  const baseline = await runStream(sdkModel(twoErrors, false).model, 2);
  const opted = sdkModel(twoErrors, true);
  const observed = await runStream(opted.model, 2);
  expect(observed.error).toMatchObject(REJECTION);
  expect(observed.partTypes).toEqual(baseline.partTypes);
  expect(opted.fetch).toHaveBeenCalledTimes(1);
  expect(diagnostics()).toEqual([
    expect.objectContaining({
      source: "sdk_error_part",
      evidence: "complete",
      ...EXPECTED_PAIRING,
    }),
  ]);
  expectNoPrivateValues();
});

it.each([
  ["400 without a tool pairing marker", { code: 400, message: "Bad request" }],
  ["a marker without status 400", { ...REJECTION, code: 502 }],
])("does not report %s", async (_label, error) => {
  await runStream(sdkModel(inBandRejection([error]), true).model);
  expect(diagnostics()).toEqual([]);
});

it("reports the same error object once even when observed twice", () => {
  const error = { ...REJECTION };
  const body = () => ({ messages: [] });
  expect(reportBedrockToolPairingRejection(error, "sdk_error_part", body)).toBe(
    true,
  );
  expect(reportBedrockToolPairingRejection(error, "sdk_error_part", body)).toBe(
    false,
  );
  expect(diagnostics()).toHaveLength(1);
});

it("opts in only the Bedrock route in the provider map", async () => {
  const fetch = jest.fn().mockImplementation(async () => httpRejection());
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  globalThis.fetch = fetch;
  process.env.OPENROUTER_API_KEY = "synthetic-unused";
  try {
    let providers!: typeof import("../providers");
    jest.isolateModules(() => {
      providers = require("../providers");
    });
    const { GROK_4_6_BEDROCK_MODEL_KEY } = require("../grok-bedrock");
    await runStream(providers.myProvider.languageModel("model-grok-4.6"));
    expect(diagnostics()).toEqual([]);
    await runStream(
      providers.myProvider.languageModel(GROK_4_6_BEDROCK_MODEL_KEY),
    );
    expect(diagnostics()).toEqual([
      expect.objectContaining({ source: "sdk_http_rejection" }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expectNoPrivateValues();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});

describe("describeBedrockToolPairing", () => {
  const call = (id: unknown, name: unknown = "run_terminal_cmd") => ({
    id,
    type: "function",
    function: { name, arguments: "{}" },
  });
  const result = (id: unknown, name: unknown = "run_terminal_cmd") => ({
    role: "tool",
    tool_call_id: id,
    name,
    content: "ok",
  });
  const tools = [{ type: "function", function: { name: "run_terminal_cmd" } }];

  it("accepts the Bedrock ID alphabet, including period and colon, up to 64 characters", () => {
    const id64 = "a.b:c-d_".repeat(8);
    expect(id64).toHaveLength(64);
    expect(
      describeBedrockToolPairing({
        tools,
        messages: [
          { role: "assistant", tool_calls: [call(id64), call("x:1.y")] },
          result(id64),
          result("x:1.y"),
        ],
      }),
    ).toMatchObject({
      evidence: "complete",
      assistant_tool_call_count: 2,
      tool_result_count: 2,
      unmatched_tool_call_count: 0,
      unmatched_tool_result_count: 0,
      tool_id_over_64_count: 0,
      tool_id_invalid_alphabet_count: 0,
      max_tool_id_length: 64,
      invalid_tool_call_name_count: 0,
      undeclared_tool_call_name_count: 0,
    });
  });

  it("counts over-length, invalid-alphabet, missing, and duplicate IDs", () => {
    const id65 = "a".repeat(65);
    const id68 = "r".repeat(68);
    expect(
      describeBedrockToolPairing({
        tools,
        messages: [
          {
            role: "assistant",
            tool_calls: [call(id65), call("bad/id"), call(""), call("dup")],
          },
          result(id65),
          result("bad/id"),
          result("dup"),
          result("dup"),
          { role: "assistant", tool_calls: [call("dup"), call(id68)] },
          result("dup"),
          result(id68),
        ],
      }),
    ).toMatchObject({
      evidence: "complete",
      assistant_tool_call_count: 6,
      tool_result_count: 6,
      missing_tool_id_count: 1,
      tool_id_over_64_count: 4,
      tool_id_invalid_alphabet_count: 2,
      max_tool_id_length: 68,
      duplicate_tool_result_id_count: 1,
      cross_turn_duplicate_tool_call_id_count: 1,
      duplicate_tool_call_id_in_turn_count: 0,
      unmatched_tool_call_count: 0,
      unmatched_tool_result_count: 0,
    });
  });

  it("counts in-turn duplicate calls, unmatched results, and tool name problems", () => {
    expect(
      describeBedrockToolPairing({
        tools: [...tools, { type: "function", function: { name: "bad.name" } }],
        messages: [
          result("orphan"),
          {
            role: "assistant",
            tool_calls: [
              call("a"),
              call("a"),
              call("b", "bad name"),
              call("c", "other_tool"),
            ],
          },
          result("a", "bad name"),
        ],
      }),
    ).toMatchObject({
      tool_definition_count: 2,
      invalid_tool_definition_name_count: 1,
      duplicate_tool_call_id_in_turn_count: 1,
      unmatched_tool_result_count: 1,
      unmatched_tool_call_count: 2,
      invalid_tool_call_name_count: 1,
      invalid_tool_result_name_count: 1,
      undeclared_tool_call_name_count: 1,
    });
  });

  it("reports malformed or getter-backed bodies as unavailable without invoking getters", () => {
    const getter = jest.fn(() => "PRIVATE");
    const message = { role: "tool" };
    Object.defineProperty(message, "tool_call_id", {
      enumerable: true,
      get: getter,
    });
    for (const body of [
      undefined,
      "{}",
      { messages: "not-an-array" },
      { messages: [message] },
      { tools: {}, messages: [] },
    ])
      expect(describeBedrockToolPairing(body).evidence).toBe("unavailable");
    expect(getter).not.toHaveBeenCalled();
  });

  it("marks oversized bodies and IDs as limited without counting unvisited results unmatched", () => {
    const calls = Array.from({ length: 20_000 }, (_, index) =>
      call(`id${index}`),
    );
    expect(
      describeBedrockToolPairing({
        messages: [{ role: "assistant", tool_calls: calls }],
      }),
    ).toMatchObject({ evidence: "limited", unmatched_tool_call_count: 0 });
    expect(
      describeBedrockToolPairing({
        messages: [
          { role: "assistant", tool_calls: [call("a".repeat(5000))] },
          result("a".repeat(5000)),
        ],
      }),
    ).toMatchObject({
      evidence: "limited",
      tool_id_over_64_count: 2,
      tool_id_invalid_alphabet_count: 0,
      max_tool_id_length: 1025,
    });
  });
});
