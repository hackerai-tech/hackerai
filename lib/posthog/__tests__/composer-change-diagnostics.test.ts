import { getIdentifiedAnalyticsUserId } from "@/lib/analytics/client";
import {
  getComposerChangeDiagnostics,
  recordComposerChange,
} from "../composer-change-diagnostics";

jest.mock("@/lib/analytics/client", () => ({
  getIdentifiedAnalyticsUserId: jest.fn(),
}));
const identity = jest.mocked(getIdentifiedAnalyticsUserId);
let now = 10000;
beforeEach(() => {
  identity.mockReturnValue(null);
  getComposerChangeDiagnostics();
  identity.mockReturnValue("synthetic-user");
  now = 10000;
  jest.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

test("retains only allowlisted metadata and never reads input material", () => {
  const forbidden = jest.fn(() => {
    throw new Error("Input content must not be read");
  });
  const event = Object.create(null);
  for (const key of [
    "data",
    "target",
    "value",
    "dataTransfer",
    "getTargetRanges",
  ])
    Object.defineProperty(event, key, { get: forbidden });
  Object.assign(event, {
    inputType: "synthetic-private-input",
    isTrusted: false,
    isComposing: true,
  });
  recordComposerChange(event);
  const snapshot = getComposerChangeDiagnostics();
  expect(snapshot).toEqual({
    hackerai_composer_change_recent_count: 1,
    hackerai_composer_change_burst_count: 1,
    hackerai_composer_change_untrusted_count: 1,
    hackerai_composer_change_composing_count: 1,
    hackerai_composer_change_last_input_type: "other",
    hackerai_composer_change_last_age: "lt_100ms",
  });
  expect(forbidden).not.toHaveBeenCalled();
  expect(JSON.stringify(snapshot)).not.toContain("synthetic-private-input");
});

test("distinguishes a synchronous burst from changes spread over time", () => {
  for (let i = 0; i < 50; i++)
    recordComposerChange({
      inputType: "insertCompositionText",
      isTrusted: true,
    });
  now += 300;
  expect(getComposerChangeDiagnostics()).toMatchObject({
    hackerai_composer_change_recent_count: 50,
    hackerai_composer_change_burst_count: 50,
    hackerai_composer_change_last_age: "lt_1s",
  });
  now += 6000;
  getComposerChangeDiagnostics();
  for (let i = 0; i < 10; i++) {
    now += 200;
    recordComposerChange({ inputType: "insertText", isTrusted: true });
  }
  expect(getComposerChangeDiagnostics()).toMatchObject({
    hackerai_composer_change_recent_count: 10,
    hackerai_composer_change_burst_count: 1,
  });
});

test("expires old samples and bounds a large event storm", () => {
  for (let i = 0; i < 1000; i++)
    recordComposerChange({ inputType: "insertText", isTrusted: true });
  recordComposerChange({ inputType: "historyUndo", isTrusted: true });
  now += 4999;
  expect(getComposerChangeDiagnostics()).toMatchObject({
    hackerai_composer_change_recent_count: 64,
    hackerai_composer_change_burst_count: 64,
    hackerai_composer_change_last_age: "lt_5s",
    hackerai_composer_change_last_input_type: "historyUndo",
  });
  now += 1;
  const expired = getComposerChangeDiagnostics();
  expect(expired.hackerai_composer_change_recent_count).toBe(0);
  expect(expired).not.toHaveProperty(
    "hackerai_composer_change_last_input_type",
  );
  expect(expired).not.toHaveProperty("hackerai_composer_change_last_age");
});

test("drops context across account changes and without identified consent", () => {
  recordComposerChange({ inputType: "insertText", isTrusted: true });
  identity.mockReturnValue("another-synthetic-user");
  expect(
    getComposerChangeDiagnostics().hackerai_composer_change_recent_count,
  ).toBe(0);
  identity.mockReturnValue(null);
  recordComposerChange({ inputType: "insertText", isTrusted: true });
  expect(getComposerChangeDiagnostics()).toEqual({});
  identity.mockReturnValue("synthetic-user");
  expect(
    getComposerChangeDiagnostics().hackerai_composer_change_recent_count,
  ).toBe(0);
});

test("malformed events and diagnostic failures never throw or record content", () => {
  for (const event of [
    null,
    "private text",
    42,
    Object.defineProperty({}, "inputType", {
      get: () => {
        throw new Error("bad metadata getter");
      },
    }),
  ])
    expect(() => recordComposerChange(event)).not.toThrow();
  expect(
    getComposerChangeDiagnostics().hackerai_composer_change_recent_count,
  ).toBe(0);
  jest.mocked(performance.now).mockImplementation(() => {
    throw new Error("clock failed");
  });
  expect(() => recordComposerChange({ inputType: "insertText" })).not.toThrow();
  expect(getComposerChangeDiagnostics()).toEqual({});
  jest.mocked(performance.now).mockReturnValue(NaN);
  expect(() => recordComposerChange({ inputType: "insertText" })).not.toThrow();
  expect(getComposerChangeDiagnostics()).toEqual({});
});
