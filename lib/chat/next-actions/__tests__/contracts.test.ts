import {
  buildPredictionSources,
  validateGroundedSuggestions,
} from "../contracts";

const message = (
  id: string,
  text: string,
  role: "user" | "assistant" = "assistant",
) => ({
  id,
  role,
  parts: [{ type: "text", text }],
});

test("retains opening scope and final corrections from a long answer and request", () => {
  const sources = buildPredictionSources([
    message(
      "answer",
      "Initial observation only. " +
        "details ".repeat(2000) +
        "Final correction: the alleged finding is a false positive; do not draft a report.",
    ),
    message(
      "user",
      "Review my offline lab only. " +
        "context ".repeat(2000) +
        "Latest constraint: do not execute commands or contact any host.",
      "user",
    ),
  ]);
  expect(sources.map((s) => s.id)).toEqual(["user", "answer"]);
  expect(sources[0].text).toContain("Review my offline lab only.");
  expect(sources[0].text).toContain(
    "Latest constraint: do not execute commands or contact any host.",
  );
  expect(sources[1].text).toContain("Initial observation only.");
  expect(sources[1].text).toContain(
    "Final correction: the alleged finding is a false positive",
  );
  expect(sources.every((s) => s.text.length <= 4000)).toBe(true);
});

test("reserves room for older user intent across six long recent messages", () => {
  const sources = buildPredictionSources(
    Array.from({ length: 8 }, (_, i) =>
      message(
        `m${i}`,
        `Scope ${i}: offline only. ` +
          "detail ".repeat(2000) +
          `Final constraint ${i}: explain only.`,
        i === 5 ? "user" : "assistant",
      ),
    ),
  );
  expect(sources.map((s) => s.id)).toEqual([
    "m5",
    "m4",
    "m3",
    "m2",
    "m1",
    "m0",
  ]);
  expect(sources[0].text).toContain("Final constraint 5: explain only.");
  expect(
    sources.reduce((sum, s) => sum + s.text.length, 0),
  ).toBeLessThanOrEqual(12000);
});

test("a large early finding output cannot hide the final assistant text", () => {
  const sources = buildPredictionSources([
    {
      id: "answer",
      role: "assistant",
      parts: [
        {
          type: "tool-get_report",
          state: "output-available",
          output: { finding_id: "F-42", details: "data ".repeat(5000) },
        },
        {
          type: "text",
          text: "Final conclusion: F-42 is unverified. The missing evidence must be explained before any report.",
        },
      ],
    },
  ]);
  expect(sources[0].text).toContain("Final conclusion: F-42 is unverified.");
  expect(sources[0].text).toContain('"finding_id":"F-42"');
  expect(sources[0].text.length).toBeLessThanOrEqual(4000);
});

test("preserves final text across multiple text parts and keeps short conversations unchanged", () => {
  const short = [
    message("answer", "The explanation is complete."),
    message("user", "Explain this only.", "user"),
  ];
  expect(buildPredictionSources(short)).toEqual([
    { id: "user", role: "user", text: "Explain this only." },
    { id: "answer", role: "assistant", text: "The explanation is complete." },
  ]);
  const source = buildPredictionSources([
    {
      ...message("answer", "x".repeat(8000)),
      parts: [
        { type: "text", text: "x".repeat(8000) },
        {
          type: "text",
          text: "The checklist is complete; no more work is needed.",
        },
      ],
    },
  ])[0];
  expect(source.text).toContain(
    "The checklist is complete; no more work is needed.",
  );
});

test("older finding output still leaves room for the answer's final correction", () => {
  const sources = buildPredictionSources([
    ...Array.from({ length: 3 }, (_, i) =>
      message(`recent${i}`, "detail ".repeat(2000)),
    ),
    {
      id: "older",
      role: "assistant",
      parts: [
        {
          type: "text",
          text:
            "Initial observation. " +
            "detail ".repeat(2000) +
            "Final correction: no finding is supported.",
        },
        {
          type: "tool-get_report",
          state: "output-available",
          output: { finding_id: "F-42", details: "data ".repeat(5000) },
        },
      ],
    },
  ]);
  expect(sources[0].id).toBe("older");
  expect(sources[0].text).toContain(
    "Final correction: no finding is supported.",
  );
  expect(sources[0].text).toContain('"finding_id":"F-42"');
  expect(
    sources.reduce((sum, s) => sum + s.text.length, 0),
  ).toBeLessThanOrEqual(12000);
});

test("shortens Unicode without broken surrogate pairs", () => {
  const source = buildPredictionSources([
    message("answer", "😀".repeat(4000) + "La revisión está completa."),
  ])[0];
  expect(source.text).toContain("La revisión está completa.");
  expect(source.text).not.toMatch(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
  );
});

test("never treats omitted text or an omission boundary as supporting evidence", () => {
  const sources = buildPredictionSources([
    message(
      "answer",
      "Start of response. " +
        "x".repeat(5000) +
        "HIDDEN_MIDDLE_EVIDENCE" +
        "y".repeat(5000) +
        "Final conclusion needs a careful explanation.",
    ),
  ]);
  const suggest = (evidenceQuote: string) => ({
    text: "Explain the final conclusion.",
    sourceMessageId: "answer",
    evidenceQuote,
  });
  expect(sources[0].text).not.toContain("HIDDEN_MIDDLE_EVIDENCE");
  const boundary = sources[0].text.indexOf("[... middle");
  expect(
    validateGroundedSuggestions(
      {
        suggestions: [
          suggest("HIDDEN_MIDDLE_EVIDENCE"),
          suggest(sources[0].text.slice(boundary - 8, boundary + 16)),
          suggest("Final conclusion needs a careful explanation."),
        ],
      },
      sources,
    ),
  ).toEqual(["Explain the final conclusion."]);
});

test("ignores empty, system, attachment, pending finding and malformed parts", () => {
  expect(
    buildPredictionSources([
      {
        id: "sys",
        role: "system",
        parts: [{ type: "text", text: "SYSTEM_SECRET" }],
      },
      {
        id: "answer",
        role: "assistant",
        parts: [
          null,
          5,
          { type: "text", text: "  " },
          { type: "file", url: "PRIVATE_ATTACHMENT" },
          {
            type: "tool-get_report",
            state: "output-error",
            output: "FAILED_FINDING",
          },
        ],
      },
    ]),
  ).toEqual([]);
});

test("rejects drafts that pretend the user supplied new evidence and keeps a usable alternative", () => {
  const sources = [
    {
      id: "answer",
      role: "assistant" as const,
      text: "There is no browser execution evidence. The exact output context is still missing.",
    },
  ];
  const item = (text: string) => ({
    text,
    sourceMessageId: "answer",
    evidenceQuote: "The exact output context is still missing.",
  });
  expect(
    validateGroundedSuggestions(
      {
        suggestions: [
          item(
            "Here is the exact output context; assess whether it is exploitable.",
          ),
          item("I've uploaded the missing evidence; verify it now."),
          item(
            "What specific evidence would distinguish reflection from confirmed execution?",
          ),
        ],
      },
      sources,
    ),
  ).toEqual([
    "What specific evidence would distinguish reflection from confirmed execution?",
  ]);
  expect(
    validateGroundedSuggestions(
      { suggestions: [item("I have run the test and attached its output.")] },
      sources,
    ),
  ).toEqual([]);
});

test("rejects composer commands while retaining ordinary path references", () => {
  const sources = [
    {
      id: "answer",
      role: "assistant" as const,
      text: "The existing checklist still needs explanation.",
    },
  ];
  const suggestion = (text: string) => ({
    text,
    sourceMessageId: "answer",
    evidenceQuote: "existing checklist still needs explanation",
  });
  for (const text of [
    "/goal pause",
    "/clear",
    "Explain the checklist /goal",
    "Explain /GOAL the checklist",
  ]) {
    expect(
      validateGroundedSuggestions({ suggestions: [suggestion(text)] }, sources),
    ).toEqual([]);
  }
  const text = "Explain the checklist in /goal/notes.txt.";
  expect(
    validateGroundedSuggestions({ suggestions: [suggestion(text)] }, sources),
  ).toEqual([text]);
});

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
