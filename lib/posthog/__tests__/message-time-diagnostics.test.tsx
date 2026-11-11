import { render } from "@testing-library/react";
import { format } from "date-fns";
import { MessageActions } from "@/app/components/MessageActions";
import {
  enrichFrontendExceptionEvent,
  shouldDropExpectedFrontendException,
} from "../expected-frontend-exceptions";
import {
  recordMessageTimestampFailure,
  getRecentMessageTimestampDiagnostics,
} from "../message-time-diagnostics";
import type { MessageTimestampPhase } from "@/lib/utils/message-time";

let mockOwner: string | null = "owned-user-a";
let mockResetObservation: (() => void) | undefined;
let now = 1000;
jest.mock("@/lib/analytics/client", () => ({
  getIdentifiedAnalyticsUserId: () => mockOwner,
  subscribeAuthenticatedAnalytics: (listener: () => void) => {
    mockResetObservation = listener;
    return () => {};
  },
}));
jest.mock("date-fns", () => {
  const actual = jest.requireActual<typeof import("date-fns")>("date-fns");
  return { ...actual, format: jest.fn(actual.format) };
});
jest.mock("@/components/ui/with-tooltip", () => ({
  WithTooltip: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}));

beforeEach(() => {
  mockOwner = null;
  getRecentMessageTimestampDiagnostics();
  mockResetObservation?.();
  mockOwner = "owned-user-a";
  now = 1000;
  jest.spyOn(performance, "now").mockImplementation(() => now);
  jest
    .mocked(format)
    .mockReset()
    .mockImplementation(
      jest.requireActual<typeof import("date-fns")>("date-fns").format,
    );
});
afterEach(() => jest.restoreAllMocks());

const stackEvent = () => ({
  event: "$exception",
  properties: {
    $exception_list: [
      {
        type: "InternalError",
        value: "too much recursion",
        mechanism: { type: "generic", synthetic: false },
        stacktrace: {
          frames: Array.from({ length: 19 }, () => ({
            filename: "https://hackerai.co/_next/static/chunks/owned.js",
          })),
        },
      },
    ],
  } as Record<string, unknown>,
});

it("does not retain a phase for later identification or consent", () => {
  mockOwner = null;
  recordMessageTimestampFailure("format_date");
  mockOwner = "owned-user-a";
  expect(getRecentMessageTimestampDiagnostics()).toEqual({});
});

it("keeps only the latest allowlisted phase and a bounded age", () => {
  recordMessageTimestampFailure("day_compare");
  recordMessageTimestampFailure("year_compare");
  now += 150;
  expect(getRecentMessageTimestampDiagnostics()).toEqual({
    hackerai_recent_formatter_version: 1,
    hackerai_recent_formatter_phase: "year_compare",
    hackerai_recent_formatter_age: "lt_1s",
  });
});

it.each([6000, 999, Number.NaN])(
  "expires or discards an invalid observation age: %s",
  (next) => {
    recordMessageTimestampFailure("format_time");
    now = next;
    expect(getRecentMessageTimestampDiagnostics()).toEqual({});
    now = 1001;
    expect(getRecentMessageTimestampDiagnostics()).toEqual({});
  },
);

it("clears facts on account changes and same-account re-identification", () => {
  recordMessageTimestampFailure("format_weekday");
  mockOwner = "owned-user-b";
  expect(getRecentMessageTimestampDiagnostics()).toEqual({});
  mockOwner = "owned-user-a";
  expect(getRecentMessageTimestampDiagnostics()).toEqual({});
  recordMessageTimestampFailure("format_date");
  expect(mockResetObservation).toEqual(expect.any(Function));
  mockResetObservation!();
  expect(getRecentMessageTimestampDiagnostics()).toEqual({});
});

it("rejects arbitrary phase content without reading an object", () => {
  const getter = jest.fn(() => {
    throw new Error("PRIVATE_CONTENT");
  });
  const value = Object.defineProperty({}, "phase", { get: getter });
  recordMessageTimestampFailure(value as MessageTimestampPhase);
  recordMessageTimestampFailure(
    "PRIVATE_DATE_AND_TARGET" as MessageTimestampPhase,
  );
  expect(getRecentMessageTimestampDiagnostics()).toEqual({});
  expect(getter).not.toHaveBeenCalled();
});

it("removes stale attached facts on reprocessing and retains the original exception", () => {
  recordMessageTimestampFailure("days_diff");
  const original = stackEvent();
  const list = original.properties.$exception_list;
  expect(shouldDropExpectedFrontendException(original)).toBe(false);
  expect(enrichFrontendExceptionEvent(original).properties).toMatchObject({
    hackerai_recent_formatter_phase: "days_diff",
    hackerai_exception_category: "stack_overflow",
  });
  mockResetObservation!();
  const reprocessed = enrichFrontendExceptionEvent(original);
  expect(reprocessed.properties).not.toHaveProperty(
    "hackerai_recent_formatter_phase",
  );
  expect(reprocessed.properties.$exception_list).toBe(list);
  expect(shouldDropExpectedFrontendException(reprocessed)).toBe(false);
});

it("does not annotate non-stack errors or emit a separate event", () => {
  recordMessageTimestampFailure("day_compare");
  const result = enrichFrontendExceptionEvent({
    event: "$exception",
    properties: { message: "unrelated failure" },
  });
  expect(
    Object.keys(result.properties).some((key) =>
      key.startsWith("hackerai_recent_formatter_"),
    ),
  ).toBe(false);
  expect(result.event).toBe("$exception");
});

it("observes the actual MessageActions formatter throw on the retained native error path", () => {
  const original = Object.freeze(
    Object.assign(new Error("too much recursion"), { name: "InternalError" }),
  );
  jest.mocked(format).mockImplementation(() => {
    throw original;
  });
  jest.spyOn(console, "error").mockImplementation(() => {});
  let caught: unknown;
  try {
    render(
      <MessageActions
        messageText="PRIVATE_MESSAGE"
        messageCreatedAt={Date.now()}
        isUser={false}
        isLastAssistantMessage={false}
        canRegenerate={false}
        onRegenerate={jest.fn()}
        onEdit={jest.fn()}
        canEdit={false}
        isHovered
        isEditing={false}
        status="ready"
      />,
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(original);
  const event = stackEvent();
  expect(shouldDropExpectedFrontendException(event)).toBe(false);
  const properties = enrichFrontendExceptionEvent(event).properties;
  expect(properties).toMatchObject({
    hackerai_recent_formatter_version: 1,
    hackerai_recent_formatter_phase: "format_time",
    hackerai_recent_formatter_age: "lt_100ms",
  });
  expect(JSON.stringify(properties)).not.toContain("PRIVATE_MESSAGE");
});
