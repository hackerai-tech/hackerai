import {
  applyVisionProgress,
  INITIAL_VISION_PROGRESS,
  parseVisionProgressReport,
  type VisionProgress,
  type VisionProgressReport,
} from "../vision-progress";

const apply = (
  reports: (VisionProgressReport | undefined)[],
  state: VisionProgress = INITIAL_VISION_PROGRESS,
) => reports.reduce(applyVisionProgress, state);

it("stops after two rejected verifications even when a stage was accepted between them", () => {
  const partial = apply([
    { attempt: 1, outcome: "rejected" },
    { attempt: 2, outcome: "advanced" },
  ]);
  expect(partial).toMatchObject({ rejected: 1, nextAttempt: 3 });
  expect(partial.stopped).toBeUndefined();
  expect(
    applyVisionProgress(partial, { attempt: 3, outcome: "rejected" }),
  ).toMatchObject({ rejected: 2, stopped: "vision_verification_rejected" });
});

it("never limits accepted stages", () => {
  const state = apply(
    Array.from({ length: 50 }, (_, i) => ({
      attempt: i + 1,
      outcome: "advanced" as const,
    })),
  );
  expect(state).toMatchObject({ rejected: 0, nextAttempt: 51 });
  expect(state.stopped).toBeUndefined();
});

it("ignores a repeated or older report without counting or resetting", () => {
  const state = apply([
    { attempt: 1, outcome: "rejected" },
    { attempt: 2, outcome: "advanced" },
  ]);
  for (const report of [
    { attempt: 2, outcome: "advanced" },
    { attempt: 1, outcome: "rejected" },
    { attempt: 1, outcome: "advanced" },
  ] as const)
    expect(applyVisionProgress(state, report)).toBe(state);
});

it.each<[string, VisionProgressReport | undefined]>([
  ["conflicting", { attempt: 2, outcome: "rejected" }],
  ["skipped", { attempt: 4, outcome: "advanced" }],
  ["uncertain", { attempt: 3, outcome: "uncertain" }],
  ["malformed", undefined],
])("stops on %s feedback instead of guessing", (_name, report) => {
  const state = apply([
    { attempt: 1, outcome: "advanced" },
    { attempt: 2, outcome: "advanced" },
  ]);
  expect(applyVisionProgress(state, report)).toMatchObject({
    rejected: 0,
    stopped: "vision_feedback_uncertain",
  });
});

it("keeps a stop sticky for every later report", () => {
  const stopped = apply([
    { attempt: 1, outcome: "rejected" },
    { attempt: 2, outcome: "rejected" },
  ]);
  for (const report of [
    { attempt: 3, outcome: "advanced" },
    { attempt: 1, outcome: "advanced" },
    { attempt: 2, outcome: "uncertain" },
  ] as const)
    expect(applyVisionProgress(stopped, report)).toBe(stopped);
});

it.each([
  ["1", "advanced", { attempt: 1, outcome: "advanced" }],
  ["12", "rejected", { attempt: 12, outcome: "rejected" }],
  ["3", "uncertain", { attempt: 3, outcome: "uncertain" }],
  ["0", "advanced", undefined],
  ["01", "advanced", undefined],
  ["1.5", "advanced", undefined],
  ["-1", "rejected", undefined],
  ["two", "rejected", undefined],
  ["2", "advance", undefined],
  ["2", "Rejected", undefined],
])(
  "parses attempt %s and outcome %s strictly",
  (attempt, outcome, expected) => {
    expect(parseVisionProgressReport(attempt, outcome)).toEqual(expected);
  },
);
