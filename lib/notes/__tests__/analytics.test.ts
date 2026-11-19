import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { RelevantNotesSection } from "../recall";

const mockEvent = jest.fn();
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: (...args: unknown[]) => mockEvent(...args) },
}));

const analytics = require("../analytics") as typeof import("../analytics");
const { RECALL_TOKEN_BUDGET } =
  require("../policy") as typeof import("../policy");

const NOW = 1_000_000;
const STARTED = NOW - 250;
const attribution = {
  userId: "u",
  feature_flag: "notes_relevant_recall_v1",
};

const section = (
  overrides: Partial<RelevantNotesSection> = {},
): RelevantNotesSection => ({
  section: "<notes>SECRET-BODY alpha.example [NOTE-ID]</notes>",
  noteCount: 2,
  targetedCount: 1,
  tokenCount: 300,
  candidateCount: 4,
  recheckDueCount: 1,
  observationDateUnknownCount: 0,
  ...overrides,
});
const empty = section({
  section: "",
  noteCount: 0,
  targetedCount: 0,
  tokenCount: 0,
  recheckDueCount: 0,
});
const counts = (result: RelevantNotesSection) => ({
  note_count: result.noteCount,
  targeted_note_count: result.targetedCount,
  candidate_count: result.candidateCount,
  token_count: result.tokenCount,
  recheck_due_count: result.recheckDueCount,
  observation_date_unknown_count: result.observationDateUnknownCount,
});

/** Routine successes, each with the exact event it emits when sampled in. */
const routine: [string, () => void, string, Record<string, unknown>][] = [
  [
    "recall hit",
    () => analytics.recordRelevantRecallResult("u", STARTED, section()),
    "notes_recall_result",
    { outcome: "hit", duration_ms: 250, ...counts(section()) },
  ],
  [
    "recall no_match",
    () => analytics.recordRelevantRecallResult("u", STARTED, empty),
    "notes_recall_result",
    { outcome: "no_match", duration_ms: 250, ...counts(empty) },
  ],
  [
    "non-empty exposure",
    () => analytics.recordRelevantRecallExposure("u", section()),
    "notes_recall_exposed",
    counts(section()),
  ],
  [
    "successful read",
    () =>
      analytics.recordNoteReadResult("u", STARTED, {
        outcome: "success",
        continuation: true,
        hasMore: false,
      }),
    "notes_read_result",
    {
      outcome: "success",
      duration_ms: 250,
      continuation: true,
      has_more: false,
    },
  ],
];

const overBudget = section({ tokenCount: RECALL_TOKEN_BUDGET + 1 });

/** Failures and budget violations, which must never depend on the draw. */
const forced: [string, () => void, string, Record<string, unknown>][] = [
  [
    "recall timeout",
    () => analytics.recordRelevantRecallResult("u", STARTED, "timeout"),
    "notes_recall_result",
    { outcome: "timeout", duration_ms: 250 },
  ],
  [
    "recall error",
    () => analytics.recordRelevantRecallResult("u", STARTED, "error"),
    "notes_recall_result",
    { outcome: "error", duration_ms: 250 },
  ],
  [
    "read error",
    () =>
      analytics.recordNoteReadResult("u", STARTED, {
        outcome: "error",
        continuation: false,
      }),
    "notes_read_result",
    { outcome: "error", duration_ms: 250, continuation: false },
  ],
  [
    "over-budget recall hit",
    () => analytics.recordRelevantRecallResult("u", STARTED, overBudget),
    "notes_recall_result",
    { outcome: "hit", duration_ms: 250, ...counts(overBudget) },
  ],
  [
    "over-budget exposure",
    () => analytics.recordRelevantRecallExposure("u", overBudget),
    "notes_recall_exposed",
    counts(overBudget),
  ],
];

let random: jest.SpiedFunction<typeof Math.random>;

beforeEach(() => {
  mockEvent.mockReset();
  jest.useFakeTimers({ now: NOW });
  random = jest.spyOn(Math, "random");
});

afterEach(() => {
  random.mockRestore();
  jest.useRealTimers();
});

describe("routine Notes successes", () => {
  it.each(routine)("%s is dropped for draws at or above 5%%", (_, record) => {
    for (const draw of [0.05, 0.5, 0.999_999]) {
      random.mockReturnValueOnce(draw);
      record();
    }
    expect(random).toHaveBeenCalledTimes(3);
    expect(mockEvent).not.toHaveBeenCalled();
  });

  it.each(routine)(
    "%s is kept below 5%% with sample_rate 0.05 and only counts",
    (_, record, name, properties) => {
      random.mockReturnValueOnce(0.049_999);
      record();
      expect(mockEvent.mock.calls).toEqual([
        [name, { ...attribution, ...properties, sample_rate: 0.05 }],
      ]);
      expect(JSON.stringify(mockEvent.mock.calls)).not.toMatch(
        /SECRET|alpha|NOTE-ID/,
      );
    },
  );

  it("treats a block exactly at the shared budget as routine", () => {
    const atBudget = section({ tokenCount: RECALL_TOKEN_BUDGET });
    random.mockReturnValue(0.999);
    analytics.recordRelevantRecallResult("u", STARTED, atBudget);
    analytics.recordRelevantRecallExposure("u", atBudget);
    expect(mockEvent).not.toHaveBeenCalled();

    random.mockReturnValue(0);
    analytics.recordRelevantRecallExposure("u", atBudget);
    expect(mockEvent).toHaveBeenCalledWith(
      "notes_recall_exposed",
      expect.objectContaining({
        token_count: RECALL_TOKEN_BUDGET,
        sample_rate: 0.05,
      }),
    );
  });

  it("records nothing and draws nothing for an empty exposure", () => {
    analytics.recordRelevantRecallExposure("u", empty);
    expect(random).not.toHaveBeenCalled();
    expect(mockEvent).not.toHaveBeenCalled();
  });
});

describe("forced Notes events", () => {
  it.each(forced)(
    "%s is always captured with sample_rate 1 without a draw",
    (_, record, name, properties) => {
      random.mockReturnValue(0.999_999);
      record();
      expect(random).not.toHaveBeenCalled();
      expect(mockEvent.mock.calls).toEqual([
        [name, { ...attribution, ...properties, sample_rate: 1 }],
      ]);
    },
  );
});

describe("telemetry failure isolation", () => {
  it("never throws when sampling, building properties or capture fails", () => {
    random.mockImplementation(() => {
      throw new Error("rng down");
    });
    for (const [, record] of routine) expect(record).not.toThrow();
    expect(mockEvent).not.toHaveBeenCalled();

    mockEvent.mockImplementation(() => {
      throw new Error("analytics down");
    });
    for (const [, record] of forced) expect(record).not.toThrow();
    expect(mockEvent).toHaveBeenCalledTimes(forced.length);

    const broken = section();
    Object.defineProperty(broken, "tokenCount", {
      get: () => {
        throw new Error("bad result");
      },
    });
    expect(() =>
      analytics.recordRelevantRecallResult("u", STARTED, broken),
    ).not.toThrow();
    expect(() =>
      analytics.recordRelevantRecallExposure("u", broken),
    ).not.toThrow();
  });
});
