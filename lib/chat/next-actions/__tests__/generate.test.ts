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
  { id: "u", role: "user" as const, text: "Help me plan a scoped review." },
  {
    id: "a",
    role: "assistant" as const,
    text: "Do you have written permission, and which system is approved?",
  },
];
const draft =
  "I have written permission for the training portal; keep the review within that scope.";
function completion(output: unknown, cost: number | undefined = 0.001) {
  return {
    output,
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
  expect(result.providerCalls).toBe(1);
  expect(generateText).toHaveBeenCalledTimes(1);
});

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
    }),
  );
  expect(generateText).not.toHaveBeenCalled();
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
  expect((await generateNextActions(sources, c.signal)).providerCalls).toBe(0);
  expect(generateText).not.toHaveBeenCalled();
});

test("cancellation after provider completion hides the reply without losing priced spend", async () => {
  const c = new AbortController();
  jest.mocked(generateText).mockImplementationOnce(async () => {
    c.abort();
    return completion({ suggestion: draft });
  });
  expect(await generateNextActions(sources, c.signal)).toEqual(
    expect.objectContaining({
      suggestions: [],
      unavailable: true,
      providerCalls: 1,
      pricedProviderCalls: 1,
      unknownProviderCalls: 0,
      cost: 0.001,
    }),
  );
});

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
      providerCalls: 1,
      pricedProviderCalls: 0,
      unknownProviderCalls: 1,
      cost: undefined,
    }),
  );
  expect(JSON.stringify(result)).not.toContain("private provider payload");
});
