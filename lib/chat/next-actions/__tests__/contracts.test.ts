import {
  buildPredictionSources,
  parsePredictedNextAction,
  hasExplicitPredictionStop,
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

test.each([
  "I have written permission; the approved scope is the training portal.",
  "Yes, use the shorter version.",
  "I’ll paste the redacted text next.",
  "Prefiero un ejemplo en español.",
])(
  "keeps an editable direct reply rather than requiring another question: %s",
  (text) => {
    expect(
      parsePredictedNextAction({
        suggestion: text,
      }),
    ).toEqual([text]);
  },
);

test.each([
  null,
  {},
  { suggestion: null },
  { suggestion: "" },
  { suggestion: "  " },
  { suggestion: 3 },
  { suggestion: ["one", "two"] },
  { suggestion: "ok", extra: true },
  { suggestion: "x".repeat(241) },
  { suggestion: "one\ntwo" },
  { suggestion: "one\ttwo" },
  { suggestion: "one\u2028two" },
  { suggestion: "/goal inspect" },
  { suggestion: "/approve" },
  { suggestion: "Please /goal inspect" },
])("rejects malformed or composer-control predictions: %p", (output) => {
  expect(parsePredictedNextAction(output)).toEqual([]);
});

test("trims a single bounded prediction and preserves ordinary paths", () => {
  expect(
    parsePredictedNextAction({
      suggestion: "  Explain /goal/notes.txt  ",
    }),
  ).toEqual(["Explain /goal/notes.txt"]);
  expect(
    parsePredictedNextAction({
      suggestion: "x".repeat(240),
    }),
  ).toEqual(["x".repeat(240)]);
});

test.each([
  "Only define the term, then stop.",
  "Cancel the review. Do not continue.",
  "Thanks. No more suggestions.",
  "Explain it without any follow-ups.",
])("suppresses a prediction after a clear conversational stop: %s", (text) => {
  expect(hasExplicitPredictionStop([{ id: "u", role: "user", text }])).toBe(
    true,
  );
});

test("a request about stopping a process is not a conversational stop", () => {
  expect(
    hasExplicitPredictionStop([
      { id: "u", role: "user", text: "Explain how to stop a local service." },
    ]),
  ).toBe(false);
  expect(
    hasExplicitPredictionStop([
      { id: "u", role: "user", text: "Which stop signal should I send?" },
    ]),
  ).toBe(false);
});

test("finishing one step while asking for another is not a conversational stop", () => {
  expect(
    hasExplicitPredictionStop([
      {
        id: "u",
        role: "user",
        text: "I'm done with setup. Explain the next step.",
      },
    ]),
  ).toBe(false);
  expect(
    hasExplicitPredictionStop([
      { id: "u", role: "user", text: "Thanks, I'm done." },
    ]),
  ).toBe(true);
});
