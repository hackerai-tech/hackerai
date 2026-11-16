import { APICallError, generateText, NoObjectGeneratedError } from "ai";
import { generateNextActions } from "../generate";
import { buildPredictionSources } from "../contracts";

jest.mock("ai", () => ({
  generateText: jest.fn(),
  APICallError: jest.requireActual("ai").APICallError,
  NoObjectGeneratedError: jest.requireActual("ai").NoObjectGeneratedError,
  Output: { object: jest.fn((value) => value) },
}));
jest.mock("@/lib/ai/providers", () => ({
  myProvider: { languageModel: () => "deepseek-test-model" },
}));
const sources = [
  { id: "u", role: "user" as const, text: "Help me plan a scoped review." },
  {
    id: "a",
    role: "assistant" as const,
    text: "Do you have written permission, and which system is approved?",
  },
];
const draft =
  "I have written permission for the training portal; keep the review within that scope.";
function completion(
  output: unknown,
  cost: number | undefined = 0.001,
  finishReason: unknown = "stop",
) {
  return {
    output,
    finishReason,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      outputTokenDetails: { reasoningTokens: 0 },
      raw: { cost },
    },
    response: { modelId: "deepseek/deepseek-v4.1-flash-1017" },
  } as never;
}
beforeEach(() => jest.resetAllMocks());

test("returns one editable reply with one provider call and its receipt", async () => {
  jest
    .mocked(generateText)
    .mockResolvedValueOnce(completion({ suggestion: draft }));
  const result = await generateNextActions(
    sources,
    new AbortController().signal,
  );
  expect(result).toEqual(
    expect.objectContaining({
      suggestions: [draft],
      reason: "generated",
      finishReason: "stop",
      providerCalls: 1,
      pricedProviderCalls: 1,
      unknownProviderCalls: 0,
      cost: 0.001,
      knownCost: 0.001,
      inputTokens: 100,
      outputTokens: 20,
      unavailable: false,
    }),
  );
  expect(result).not.toHaveProperty("httpStatus");
  expect(generateText).toHaveBeenCalledTimes(1);
  const options = jest.mocked(generateText).mock.calls[0][0];
  expect(JSON.parse(options.prompt as string)).toEqual(
    sources.map(({ role, text }) => ({ role, text })),
  );
  expect(options).toEqual(
    expect.objectContaining({
      maxOutputTokens: 160,
      maxRetries: 0,
      timeout: 8000,
      providerOptions: {
        openrouter: {
          reasoning: { enabled: false },
          provider: { require_parameters: true, sort: "throughput" },
        },
      },
    }),
  );
  expect(options.tools).toBeUndefined();
});

test("a null prediction abstains without a second model call", async () => {
  jest
    .mocked(generateText)
    .mockResolvedValueOnce(completion({ suggestion: null }));
  const result = await generateNextActions(
    sources,
    new AbortController().signal,
  );
  expect(result.suggestions).toEqual([]);
  expect(result.unavailable).toBe(false);
  expect(result.reason).toBe("model_abstained");
  expect(result.providerCalls).toBe(1);
  expect(generateText).toHaveBeenCalledTimes(1);
});

test("a schema-valid draft the parser rejects is not reported as abstention", async () => {
  jest
    .mocked(generateText)
    .mockResolvedValueOnce(completion({ suggestion: "/goal inspect" }));
  const result = await generateNextActions(
    sources,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    suggestions: [],
    unavailable: false,
    reason: "parser_rejected",
    providerCalls: 1,
    cost: 0.001,
  });
});

test.each(["finished", { private: "provider value" }, null])(
  "omits an unrecognized provider finish reason: %p",
  async (finishReason) => {
    jest
      .mocked(generateText)
      .mockResolvedValueOnce(
        completion({ suggestion: draft }, 0.001, finishReason),
      );
    const result = await generateNextActions(
      sources,
      new AbortController().signal,
    );
    expect(result.reason).toBe("generated");
    expect(result).not.toHaveProperty("finishReason");
  },
);

test("an explicit conversational stop spends no provider tokens", async () => {
  const result = await generateNextActions(
    [{ id: "u", role: "user", text: "Define the term, then stop." }],
    new AbortController().signal,
  );
  expect(result).toEqual(
    expect.objectContaining({
      suggestions: [],
      providerCalls: 0,
      pricedProviderCalls: 0,
      unknownProviderCalls: 0,
      knownCost: 0,
      unavailable: false,
      reason: "explicit_stop",
    }),
  );
  expect(generateText).not.toHaveBeenCalled();
});

test("a stop delivered through a wait reply spends no provider tokens", async () => {
  const history = buildPredictionSources([
    {
      id: "answer",
      role: "assistant",
      parts: [
        {
          type: "tool-wait_for_user",
          state: "output-available",
          input: { questions: [{ question: "Probe the live lab hosts?" }] },
          output: {
            success: true,
            wait_outcome: "message_arrived",
            reply: "no, stop here.",
          },
        },
        { type: "text", text: "Understood, no probing." },
      ],
    },
    { id: "u", role: "user", parts: [{ type: "text", text: "List hosts." }] },
  ]);
  const result = await generateNextActions(
    history,
    new AbortController().signal,
  );
  expect(result).toMatchObject({ reason: "explicit_stop", providerCalls: 0 });
  expect(generateText).not.toHaveBeenCalled();
});

test.each([
  "What does ‘do not suggest follow-ups’ mean?",
  "What does ‘start and do not suggest follow-ups’ mean?",
  "What does 'I'm finished and do not suggest follow-ups' mean?",
])("quoted stop wording still allows a prediction: %s", async (text) => {
  jest
    .mocked(generateText)
    .mockResolvedValueOnce(
      completion({ suggestion: "show me where that setting is" }),
    );
  const result = await generateNextActions(
    [
      {
        id: "u",
        role: "user",
        text,
      },
      {
        id: "a",
        role: "assistant",
        text: "It disables predicted next messages.",
      },
    ],
    new AbortController().signal,
  );
  expect(result.providerCalls).toBe(1);
  expect(result.suggestions).toEqual(["show me where that setting is"]);
});

test("keeps a successful reply while reporting missing provider cost as unknown", async () => {
  const r = completion({ suggestion: draft });
  (r as { usage: { raw: object } }).usage.raw = {};
  jest.mocked(generateText).mockResolvedValueOnce(r);
  expect(
    await generateNextActions(sources, new AbortController().signal),
  ).toEqual(
    expect.objectContaining({
      suggestions: [draft],
      providerCalls: 1,
      pricedProviderCalls: 0,
      unknownProviderCalls: 1,
      cost: undefined,
      knownCost: 0,
    }),
  );
});

test("does not start work for an aborted caller", async () => {
  const c = new AbortController();
  c.abort();
  const result = await generateNextActions(sources, c.signal);
  expect(result.providerCalls).toBe(0);
  expect(result.reason).toBe("caller_aborted");
  expect(generateText).not.toHaveBeenCalled();
});

test("caller cancellation after provider completion hides the reply without losing priced spend", async () => {
  const c = new AbortController();
  jest.mocked(generateText).mockImplementationOnce(async () => {
    // The route's own request budget also aborts with a TimeoutError; that is
    // still the caller, not this generation's deadline.
    c.abort(new DOMException("caller budget", "TimeoutError"));
    return completion({ suggestion: draft });
  });
  expect(await generateNextActions(sources, c.signal)).toEqual(
    expect.objectContaining({
      suggestions: [],
      unavailable: true,
      reason: "caller_aborted",
      finishReason: "stop",
      providerCalls: 1,
      pricedProviderCalls: 1,
      unknownProviderCalls: 0,
      cost: 0.001,
    }),
  );
});

test("caller cancellation during the provider call is not attributed to the deadline", async () => {
  const c = new AbortController();
  jest.mocked(generateText).mockImplementationOnce(async () => {
    const reason = new DOMException("caller budget", "TimeoutError");
    c.abort(reason);
    throw reason;
  });
  const result = await generateNextActions(sources, c.signal);
  expect(result).toMatchObject({
    reason: "caller_aborted",
    unavailable: true,
    providerCalls: 1,
    unknownProviderCalls: 1,
  });
});

const providerError = () =>
  new APICallError({
    message: "PRIVATE_MESSAGE",
    url: "https://provider.invalid/PRIVATE_URL",
    requestBodyValues: { prompt: "PRIVATE_REQUEST" },
    statusCode: 503,
    responseBody: "PRIVATE_BODY",
  });
const structuredError = () => {
  const receipt = completion(null) as unknown as {
    usage: ConstructorParameters<typeof NoObjectGeneratedError>[0]["usage"];
    response: ConstructorParameters<
      typeof NoObjectGeneratedError
    >[0]["response"];
  };
  return new NoObjectGeneratedError({
    message: "PRIVATE_MESSAGE",
    text: "PRIVATE_MODEL_TEXT",
    usage: receipt.usage,
    response: receipt.response,
    finishReason: "stop",
  });
};

test.each([
  {
    name: "provider error after caller abort",
    aborts: ["caller"],
    error: providerError,
    expected: { reason: "caller_aborted", httpStatus: 503 },
  },
  {
    name: "provider error after our deadline",
    aborts: ["deadline"],
    error: providerError,
    expected: { reason: "deadline", httpStatus: 503 },
  },
  {
    name: "structured error after caller abort",
    aborts: ["caller"],
    error: structuredError,
    expected: { reason: "caller_aborted", finishReason: "stop", cost: 0.001 },
  },
  {
    name: "caller abort before a later deadline",
    aborts: ["caller", "deadline"],
    error: providerError,
    expected: { reason: "caller_aborted", httpStatus: 503 },
  },
  {
    name: "deadline before a later caller abort",
    aborts: ["deadline", "caller"],
    error: providerError,
    expected: { reason: "deadline", httpStatus: 503 },
  },
])(
  "the first known abort outranks a later typed error: $name",
  async ({ aborts, error, expected }) => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const timeout = jest
      .spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(deadline.signal);
    try {
      jest.mocked(generateText).mockImplementationOnce(async () => {
        for (const source of aborts)
          (source === "caller" ? caller : deadline).abort(
            new DOMException(source, "TimeoutError"),
          );
        throw error();
      });
      const result = await generateNextActions(sources, caller.signal);
      // Typed receipt and status fields survive the abort attribution.
      expect(result).toMatchObject({
        suggestions: [],
        unavailable: true,
        providerCalls: 1,
        ...expected,
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
    } finally {
      timeout.mockRestore();
    }
  },
);

test.each([
  ["this generation's deadline", true],
  ["the SDK's equal request timeout", false],
])(
  "reports %s as a deadline with unknown spend",
  async (_case, ownDeadlineFired) => {
    const deadline = new AbortController();
    const timeout = jest
      .spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(deadline.signal);
    try {
      jest.mocked(generateText).mockImplementationOnce(async () => {
        const reason = new DOMException("timed out", "TimeoutError");
        if (ownDeadlineFired) deadline.abort(reason);
        throw reason;
      });
      const result = await generateNextActions(
        sources,
        new AbortController().signal,
      );
      expect(result).toMatchObject({
        suggestions: [],
        unavailable: true,
        reason: "deadline",
        providerCalls: 1,
        unknownProviderCalls: 1,
        cost: undefined,
      });
    } finally {
      timeout.mockRestore();
    }
  },
);

test("provider failures expose no private error details and keep unknown spend", async () => {
  jest
    .mocked(generateText)
    .mockRejectedValueOnce(new Error("private provider payload"));
  const result = await generateNextActions(
    sources,
    new AbortController().signal,
  );
  expect(result).toEqual(
    expect.objectContaining({
      suggestions: [],
      unavailable: true,
      reason: "other_error",
      providerCalls: 1,
      pricedProviderCalls: 0,
      unknownProviderCalls: 1,
      cost: undefined,
    }),
  );
  expect(JSON.stringify(result)).not.toContain("private provider payload");
});

test.each([
  [429, 429],
  [99, undefined],
  [600, undefined],
  [429.5, undefined],
  [undefined, undefined],
])(
  "classifies a provider API failure without private details (status %p)",
  async (statusCode, expected) => {
    jest.mocked(generateText).mockRejectedValueOnce(
      new APICallError({
        message: "PRIVATE_MESSAGE",
        url: "https://provider.invalid/PRIVATE_URL",
        requestBodyValues: { prompt: "PRIVATE_REQUEST" },
        statusCode,
        responseHeaders: { "x-private": "PRIVATE_HEADER" },
        responseBody: "PRIVATE_BODY",
        cause: new Error("PRIVATE_CAUSE"),
      }),
    );
    const result = await generateNextActions(
      sources,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      suggestions: [],
      unavailable: true,
      reason: "provider_api_error",
      unknownProviderCalls: 1,
    });
    expect(result.httpStatus).toBe(expected);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  },
);

test("retains the billed generation when structured output is invalid", async () => {
  const receipt = completion(null) as unknown as {
    usage: ConstructorParameters<typeof NoObjectGeneratedError>[0]["usage"];
    response: ConstructorParameters<
      typeof NoObjectGeneratedError
    >[0]["response"];
  };
  jest.mocked(generateText).mockRejectedValueOnce(
    new NoObjectGeneratedError({
      message: "Private invalid output",
      text: "Private model content",
      usage: receipt.usage,
      response: receipt.response,
      finishReason: "stop",
    }),
  );
  const result = await generateNextActions(
    sources,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    suggestions: [],
    unavailable: true,
    reason: "invalid_structured_output",
    finishReason: "stop",
    providerCalls: 1,
    pricedProviderCalls: 1,
    unknownProviderCalls: 0,
    cost: 0.001,
    knownCost: 0.001,
    inputTokens: 100,
    outputTokens: 20,
  });
  expect(JSON.stringify(result)).not.toContain("Private");
});

test("passes persisted tool activity and actual answers to the predictor", async () => {
  jest
    .mocked(generateText)
    .mockResolvedValueOnce(completion({ suggestion: null }));
  const history = buildPredictionSources([
    {
      id: "finished",
      role: "assistant",
      parts: [
        {
          type: "tool-run_terminal_cmd",
          state: "output-available",
          output: { success: true, stdout: "PRIVATE_STDOUT" },
        },
        {
          type: "tool-wait_for_user",
          state: "output-available",
          input: { questions: [{ question: "Confirm your choice?" }] },
          output: {
            success: true,
            wait_outcome: "message_arrived",
            reply: "Continue",
          },
        },
        { type: "text", text: "Done, both answers received." },
      ],
    },
  ]);
  await generateNextActions(history, new AbortController().signal);
  const prompt = String(jest.mocked(generateText).mock.calls[0][0].prompt);
  // Wait-reply stop metadata never reaches the model payload.
  expect(history[0].latestUserReplyStopped).toBe(false);
  expect(Object.keys(JSON.parse(prompt)[0])).toEqual(["role", "text"]);
  const sent = JSON.parse(prompt)[0].text;
  expect(sent).toContain('"name":"run_terminal_cmd"');
  expect(sent).toContain("Confirm your choice?");
  expect(sent).toContain('"reply":"Continue"');
  expect(sent).not.toContain("PRIVATE_STDOUT");
});
