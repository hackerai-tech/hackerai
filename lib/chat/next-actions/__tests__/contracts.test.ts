import {
  buildPredictionSources,
  validateGroundedSuggestions,
} from "../contracts";

test("bounds history and excludes reasoning, tool inputs, and unrelated tool outputs", () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({
    id: `m${i}`,
    role: "assistant" as const,
    parts: [
      { type: "reasoning", text: "PRIVATE_REASONING" },
      {
        type: "tool-run",
        state: "output-available",
        input: "SECRET_INPUT",
        output: "UNTRUSTED_OUTPUT",
      },
      { type: "text", text: "a".repeat(10_000) },
    ],
  }));
  const sources = buildPredictionSources(messages);
  expect(
    sources.reduce((sum, source) => sum + source.text.length, 0),
  ).toBeLessThanOrEqual(12_000);
  expect(sources.length).toBeLessThanOrEqual(6);
  expect(JSON.stringify(sources)).not.toMatch(
    /PRIVATE_REASONING|SECRET_INPUT|UNTRUSTED_OUTPUT/,
  );
});

test("preserves existing finding output as grounding and rejects invented support, links and duplicates", () => {
  const sources = buildPredictionSources([
    {
      id: "answer",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "The synthetic finding lacks evidence of impact.",
        },
        {
          type: "tool-create_vulnerability_report",
          state: "output-available",
          output: { finding_id: "existing-finding", success: true },
        },
      ],
    },
  ]);
  expect(sources[0].text).toContain("existing-finding");
  const supported = {
    text: "Explain what evidence of impact is missing.",
    sourceMessageId: "answer",
    evidenceQuote: "lacks evidence of impact",
  };
  expect(
    validateGroundedSuggestions(
      { suggestions: [supported, supported] },
      sources,
    ),
  ).toEqual([supported.text]);
  expect(
    validateGroundedSuggestions(
      {
        suggestions: [
          { ...supported, sourceMessageId: "invented" },
          { ...supported, evidenceQuote: "a fully confirmed exploitable bug" },
          { ...supported, text: "Open https://invented.example/report" },
        ],
      },
      sources,
    ),
  ).toEqual([]);
  expect(validateGroundedSuggestions({ suggestions: [] }, sources)).toEqual([]);
});
