import { generateText } from "ai";
import { generateNextActions } from "../generate";

jest.mock("ai", () => ({
  generateText: jest.fn(),
  Output: { object: jest.fn((value) => value) },
}));
jest.mock("@/lib/ai/providers", () => ({
  myProvider: { languageModel: () => "deepseek-test-model" },
}));
const sources = [
  {
    id: "question",
    role: "user" as const,
    text: "Compare ways to debug a toy application.",
  },
  {
    id: "answer",
    role: "assistant" as const,
    text: "The language and operating system have not been specified.",
  },
];
const draft =
  "Compare general debugging approaches without assuming a runtime.";
const output = {
  suggestions: [
    {
      text: draft,
      sourceMessageId: "answer",
      evidenceQuote: "The language and operating system",
    },
  ],
};
function completion(value: unknown, cost: number | undefined = 0.001) {
  return {
    output: value,
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

test("verifies grounded drafts and accounts for both provider calls", async () => {
  jest
    .mocked(generateText)
    .mockResolvedValueOnce(completion(output))
    .mockResolvedValueOnce(completion({ safe_indices: [0] }, 0.0002));
  const result = await generateNextActions(
    sources,
    new AbortController().signal,
  );
  expect(result).toEqual(
    expect.objectContaining({
      suggestions: [draft],
      providerCalls: 2,
      pricedProviderCalls: 2,
      unknownProviderCalls: 0,
      inputTokens: 200,
      outputTokens: 40,
      unavailable: false,
    }),
  );
  expect(result.cost).toBeCloseTo(0.0012, 12);
  expect(result.knownCost).toBeCloseTo(0.0012, 12);
  const options = jest.mocked(generateText).mock.calls[1][0];
  expect(options.abortSignal).toBe(
    jest.mocked(generateText).mock.calls[0][0].abortSignal,
  );
  expect(JSON.parse(options.prompt as string)).toEqual({
    sources,
    latest_user_message: sources[0],
    drafts: [draft],
  });
  expect(options).toEqual(
    expect.objectContaining({
      maxRetries: 0,
      maxOutputTokens: 80,
      timeout: 4000,
      providerOptions: {
        openrouter: {
          reasoning: { enabled: false },
          provider: { require_parameters: true, sort: "latency" },
        },
      },
    }),
  );
});

test("fails closed when verification rejects every draft", async () => {
  jest
    .mocked(generateText)
    .mockResolvedValueOnce(completion(output))
    .mockResolvedValueOnce(completion({ safe_indices: [] }));
  const result = await generateNextActions(
    sources,
    new AbortController().signal,
  );
  expect(result.suggestions).toEqual([]);
  expect(result.unavailable).toBe(false);
  expect(result.providerCalls).toBe(2);
});

test("never reports a partly priced batch as fully priced after verifier failure", async () => {
  jest
    .mocked(generateText)
    .mockResolvedValueOnce(completion(output))
    .mockRejectedValueOnce(new Error("private provider payload"));
  const result = await generateNextActions(
    sources,
    new AbortController().signal,
  );
  expect(result).toEqual(
    expect.objectContaining({
      suggestions: [],
      unavailable: true,
      providerCalls: 2,
      pricedProviderCalls: 1,
      unknownProviderCalls: 1,
      knownCost: 0.001,
      cost: undefined,
    }),
  );
  expect(JSON.stringify(result)).not.toContain("private provider payload");
});

test("keeps successful suggestions but marks missing provider cost as unknown", async () => {
  // Explicitly omit cost rather than invoke the fixture's default argument.
  const withoutCost = completion({ safe_indices: [0] });
  (withoutCost as { usage: { raw: object } }).usage.raw = {};
  jest
    .mocked(generateText)
    .mockReset()
    .mockResolvedValueOnce(completion(output))
    .mockResolvedValueOnce(withoutCost);
  const result = await generateNextActions(
    sources,
    new AbortController().signal,
  );
  expect(result).toEqual(
    expect.objectContaining({
      suggestions: [draft],
      providerCalls: 2,
      pricedProviderCalls: 1,
      unknownProviderCalls: 1,
      knownCost: 0.001,
      cost: undefined,
    }),
  );
});

test("empty or ungrounded generation makes no verifier call", async () => {
  jest.mocked(generateText).mockResolvedValueOnce(
    completion({
      suggestions: [
        {
          text: draft,
          sourceMessageId: "absent",
          evidenceQuote: "The language and operating system",
        },
      ],
    }),
  );
  const result = await generateNextActions(
    sources,
    new AbortController().signal,
  );
  expect(result.suggestions).toEqual([]);
  expect(result.providerCalls).toBe(1);
  expect(generateText).toHaveBeenCalledTimes(1);
});

test("does not begin model work for an already aborted caller", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await generateNextActions(sources, controller.signal);
  expect(result.suggestions).toEqual([]);
  expect(result.providerCalls).toBe(0);
  expect(generateText).not.toHaveBeenCalled();
});

test("does not begin verification after the caller aborts generation", async () => {
  const controller = new AbortController();
  jest.mocked(generateText).mockImplementationOnce(async () => {
    controller.abort();
    return completion(output);
  });
  const result = await generateNextActions(sources, controller.signal);
  expect(result).toEqual(
    expect.objectContaining({
      suggestions: [],
      unavailable: true,
      providerCalls: 1,
      pricedProviderCalls: 1,
      knownCost: 0.001,
    }),
  );
  expect(generateText).toHaveBeenCalledTimes(1);
});

test("unavailable generation records an attempted call with unknown cost", async () => {
  jest.mocked(generateText).mockRejectedValueOnce(new Error("private"));
  const result = await generateNextActions(
    sources,
    new AbortController().signal,
  );
  expect(result).toEqual(
    expect.objectContaining({
      suggestions: [],
      unavailable: true,
      providerCalls: 1,
      pricedProviderCalls: 0,
      unknownProviderCalls: 1,
      cost: undefined,
    }),
  );
});

test("verification selects existing drafts without reordering or fabricating them", async () => {
  const second = "Explain how to choose the minimum debugging evidence.";
  jest
    .mocked(generateText)
    .mockResolvedValueOnce(
      completion({
        suggestions: [
          ...output.suggestions,
          { ...output.suggestions[0], text: second },
        ],
      }),
    )
    .mockResolvedValueOnce(completion({ safe_indices: [1, 0, 1] }));
  expect(
    (await generateNextActions(sources, new AbortController().signal))
      .suggestions,
  ).toEqual([draft, second]);
});

test("an index outside the actual draft list cannot expose a suggestion", async () => {
  jest
    .mocked(generateText)
    .mockResolvedValueOnce(completion(output))
    .mockResolvedValueOnce(completion({ safe_indices: [2] }));
  expect(
    (await generateNextActions(sources, new AbortController().signal))
      .suggestions,
  ).toEqual([]);
});
