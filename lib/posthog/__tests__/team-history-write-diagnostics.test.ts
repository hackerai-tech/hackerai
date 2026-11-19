import { getIdentifiedAnalyticsUserId } from "@/lib/analytics/client";
import {
  enrichFrontendExceptionEvent,
  shouldDropExpectedFrontendException,
} from "../expected-frontend-exceptions";
import {
  getTeamHistoryWriteDiagnostics,
  recordTeamHistoryWrite,
} from "../team-history-write-diagnostics";

const mockAnalyticsListeners = new Set<() => void>();
jest.mock("@/lib/analytics/client", () => ({
  getIdentifiedAnalyticsUserId: jest.fn(),
  subscribeAuthenticatedAnalytics: jest.fn((listener: () => void) => {
    mockAnalyticsListeners.add(listener);
    return () => mockAnalyticsListeners.delete(listener);
  }),
}));
const identity = jest.mocked(getIdentifiedAnalyticsUserId);
let now = 10000;
beforeEach(() => {
  identity.mockReturnValue(null);
  getTeamHistoryWriteDiagnostics();
  identity.mockReturnValue("synthetic-user");
  now = 10000;
  jest.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

const RATE_LIMIT_MESSAGE =
  "SecurityError: Attempt to use history.replaceState() more than 100 times per 10 seconds";
const PRIVATE_URL =
  "https://hackerai.co/?numSeats=37&selectedPlan=yearly#team-pricing-seat-selection";

function historyException(type: string, value: string) {
  return {
    event: "$exception",
    properties: {
      $current_url: PRIVATE_URL,
      $exception_list: [
        {
          type,
          value,
          mechanism: { handled: false, synthetic: false, type: "generic" },
          stacktrace: { frames: [{ filename: "app/TeamPricingDialog.tsx" }] },
        },
      ],
    },
  };
}

const teamFields = (properties: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(properties).filter(([key]) =>
      key.startsWith("hackerai_team_history_write_"),
    ),
  );

test("attaches own Team write counts to a retained History rate-limit error", () => {
  for (let i = 0; i < 40; i++) recordTeamHistoryWrite("team_seat_sync", true);
  recordTeamHistoryWrite("team_seat_sync", false);
  recordTeamHistoryWrite("pricing_team_open", false);
  recordTeamHistoryWrite("team_close_cleanup", false);
  now += 500;

  const event = enrichFrontendExceptionEvent(
    historyException("DOMException", RATE_LIMIT_MESSAGE),
  );

  expect(shouldDropExpectedFrontendException(event)).toBe(false);
  expect(event.properties.$exception_list).toEqual(
    historyException("DOMException", RATE_LIMIT_MESSAGE).properties
      .$exception_list,
  );
  const fields = teamFields(event.properties);
  expect(fields).toEqual({
    hackerai_team_history_write_version: 1,
    hackerai_team_history_write_scope: "instrumented_team_sites",
    hackerai_team_history_write_unit: "attempts",
    hackerai_team_history_write_window_ms: 30000,
    hackerai_team_history_write_count: 43,
    hackerai_team_history_write_capped: false,
    hackerai_team_history_write_same_url_count: 40,
    hackerai_team_history_write_seat_sync_count: 41,
    hackerai_team_history_write_close_cleanup_count: 1,
    hackerai_team_history_write_pricing_open_count: 1,
  });
  const serialized = JSON.stringify(fields);
  for (const secret of [
    "numSeats",
    "37",
    "yearly",
    "synthetic-user",
    "SecurityError",
    "replaceState",
  ])
    expect(serialized).not.toContain(secret);
});

test("reports zero own writes so exhaustion elsewhere is distinguishable", () => {
  const event = enrichFrontendExceptionEvent(
    historyException("DOMException", RATE_LIMIT_MESSAGE),
  );
  expect(event.properties).toMatchObject({
    hackerai_team_history_write_count: 0,
    hackerai_team_history_write_same_url_count: 0,
  });
});

test("does not attach Team writes to unrelated or near-miss exceptions", () => {
  recordTeamHistoryWrite("team_seat_sync", true);
  for (const [type, value] of [
    ["DOMException", "SecurityError: The operation is insecure."],
    [
      "DOMException",
      "SecurityError: Attempt to use history.pushState() more than 100 times per 10 seconds",
    ],
    [
      "DOMException",
      "SecurityError: Too many calls to Location or History APIs within a short timeframe.",
    ],
    [
      "DOMException",
      "SecurityError: Attempt to use history.replaceState() more than 1000 times per 10 seconds",
    ],
    [
      "DOMException",
      "QuotaExceededError: Attempt to use history.replaceState() more than 100 times per 10 seconds",
    ],
    ["Error", RATE_LIMIT_MESSAGE],
    ["DOMException", `${RATE_LIMIT_MESSAGE} ${"x".repeat(300)}`],
  ]) {
    const event = enrichFrontendExceptionEvent(historyException(type, value));
    expect(teamFields(event.properties)).toEqual({});
  }
  const ordinary = { event: "team_plan_viewed", properties: {} };
  expect(enrichFrontendExceptionEvent(ordinary)).toBe(ordinary);
  expect(ordinary.properties).toEqual({});
});

test("caps a write storm and expires writes outside the window", () => {
  for (let i = 0; i < 1000; i++)
    recordTeamHistoryWrite("team_seat_sync", i % 2 === 0);
  recordTeamHistoryWrite("team_close_cleanup", false);
  expect(getTeamHistoryWriteDiagnostics()).toMatchObject({
    hackerai_team_history_write_count: 128,
    hackerai_team_history_write_capped: true,
    hackerai_team_history_write_same_url_count: 63,
    hackerai_team_history_write_seat_sync_count: 127,
    hackerai_team_history_write_close_cleanup_count: 1,
  });
  now += 29999;
  recordTeamHistoryWrite("pricing_team_open", false);
  expect(getTeamHistoryWriteDiagnostics()).toMatchObject({
    hackerai_team_history_write_count: 128,
    hackerai_team_history_write_pricing_open_count: 1,
  });
  now += 1;
  expect(getTeamHistoryWriteDiagnostics()).toMatchObject({
    hackerai_team_history_write_count: 1,
    hackerai_team_history_write_capped: false,
    hackerai_team_history_write_seat_sync_count: 0,
    hackerai_team_history_write_pricing_open_count: 1,
  });
});

test("drops writes the clock cannot place before the snapshot", () => {
  now = 20000;
  recordTeamHistoryWrite("team_seat_sync", false);
  now = 15000;
  recordTeamHistoryWrite("team_close_cleanup", false);
  expect(getTeamHistoryWriteDiagnostics()).toMatchObject({
    hackerai_team_history_write_count: 1,
    hackerai_team_history_write_seat_sync_count: 0,
    hackerai_team_history_write_close_cleanup_count: 1,
  });
  now = 20000;
  expect(getTeamHistoryWriteDiagnostics()).toMatchObject({
    hackerai_team_history_write_count: 1,
  });
});

test("omits writes across account changes and without identified consent", () => {
  recordTeamHistoryWrite("team_seat_sync", true);
  identity.mockReturnValue("another-synthetic-user");
  expect(
    getTeamHistoryWriteDiagnostics().hackerai_team_history_write_count,
  ).toBe(0);
  identity.mockReturnValue("synthetic-user");
  recordTeamHistoryWrite("team_seat_sync", true);
  identity.mockReturnValue(null);
  recordTeamHistoryWrite("team_seat_sync", true);
  expect(getTeamHistoryWriteDiagnostics()).toEqual({});
  expect(
    teamFields(
      enrichFrontendExceptionEvent(
        historyException("DOMException", RATE_LIMIT_MESSAGE),
      ).properties,
    ),
  ).toEqual({});
  identity.mockReturnValue("synthetic-user");
  expect(
    getTeamHistoryWriteDiagnostics().hackerai_team_history_write_count,
  ).toBe(0);
});

test("reprocessing as another account does not carry the earlier owner's counts", () => {
  recordTeamHistoryWrite("team_seat_sync", true);
  const event = enrichFrontendExceptionEvent(
    historyException("DOMException", RATE_LIMIT_MESSAGE),
  );
  expect(event.properties).toMatchObject({
    hackerai_team_history_write_count: 1,
  });
  identity.mockReturnValue(null);
  expect(teamFields(enrichFrontendExceptionEvent(event).properties)).toEqual(
    {},
  );
});

test("clears counts across unobserved consent revocation and same-user restoration", () => {
  recordTeamHistoryWrite("team_seat_sync", true);
  identity.mockReturnValue(null);
  mockAnalyticsListeners.forEach((listener) => listener());
  identity.mockReturnValue("synthetic-user");
  mockAnalyticsListeners.forEach((listener) => listener());
  // No recorder or diagnostic getter ran between these notifications.
  expect(
    getTeamHistoryWriteDiagnostics().hackerai_team_history_write_count,
  ).toBe(0);
});

test("a failing diagnostic never replaces the original History failure", () => {
  const original = new DOMException(
    "Attempt to use history.replaceState() more than 100 times per 10 seconds",
    "SecurityError",
  );
  const replaceState = jest
    .spyOn(window.history, "replaceState")
    .mockImplementation(() => {
      throw original;
    });
  const instrumentedWrite = () => {
    recordTeamHistoryWrite("team_seat_sync", false);
    window.history.replaceState({}, "", "/");
  };

  for (const hostile of [
    () =>
      identity.mockImplementation(() => {
        throw new Error("owner lookup failed");
      }),
    () =>
      jest.mocked(performance.now).mockImplementation(() => {
        throw new Error("clock failed");
      }),
    () => jest.mocked(performance.now).mockReturnValue(NaN),
    () => jest.mocked(performance.now).mockReturnValue(-1),
  ]) {
    hostile();
    let thrown: unknown;
    try {
      instrumentedWrite();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(original);
    expect(() => getTeamHistoryWriteDiagnostics()).not.toThrow();
    identity.mockReturnValue("synthetic-user");
    jest.mocked(performance.now).mockImplementation(() => now);
  }
  expect(replaceState).toHaveBeenCalledTimes(4);
  expect(
    getTeamHistoryWriteDiagnostics().hackerai_team_history_write_count,
  ).toBe(0);

  expect(() =>
    recordTeamHistoryWrite(
      "unlisted_site" as unknown as "team_seat_sync",
      "yes" as unknown as boolean,
    ),
  ).not.toThrow();
  expect(
    getTeamHistoryWriteDiagnostics().hackerai_team_history_write_count,
  ).toBe(0);
});

test("a hostile exception shape never prevents enrichment of the original event", () => {
  recordTeamHistoryWrite("team_seat_sync", true);
  const exception = Object.defineProperty({ type: "DOMException" }, "value", {
    get: () => {
      throw new Error("hostile value getter");
    },
  });
  const event = enrichFrontendExceptionEvent({
    event: "$exception",
    properties: { $exception_list: [exception] },
  });
  expect(event.properties.$exception_list).toEqual([exception]);
  expect(teamFields(event.properties)).toEqual({});
});
