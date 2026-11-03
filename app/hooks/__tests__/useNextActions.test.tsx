import { act, renderHook } from "@testing-library/react";
import { useNextActions } from "../useNextActions";
import { captureQueuedAuthenticatedEvent } from "@/lib/analytics/client";

jest.mock("@/lib/analytics/client", () => ({
  captureQueuedAuthenticatedEvent: jest.fn(() => true),
}));
const batch = {
  batchId: "batch",
  messageId: "answer",
  mode: "ask",
  suggestions: ["Explain the missing evidence.", "Summarize the uncertainty."],
};
const response = () => ({ ok: true, status: 200, json: async () => batch });
let input = "";
let attachments = false;
const setInput = jest.fn((value: string) => {
  input = value;
});
const base = () => ({
  userId: "u",
  chatId: "chat",
  completedTurn: { chatId: "chat", messageId: "answer" },
  latestMessageId: "answer",
  status: "ready",
  blocked: false,
  input,
  getInput: () => input,
  setInput,
  hasAttachments: () => attachments,
});
async function settle() {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(500);
  });
}
beforeEach(() => {
  jest.useFakeTimers();
  sessionStorage.clear();
  input = "";
  attachments = false;
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue(response());
});
afterEach(() => jest.useRealTimers());

test("acceptance creates an editable draft; exposure, submission and finish are separate and content-free", async () => {
  const { result, rerender } = renderHook((props) => useNextActions(props), {
    initialProps: base(),
  });
  await settle();
  expect(result.current.batch?.suggestions).toHaveLength(2);
  expect(captureQueuedAuthenticatedEvent).not.toHaveBeenCalled();
  act(() => result.current.exposed());
  act(() => {
    expect(result.current.accept(0, "keyboard")).toBe(true);
  });
  expect(input).toBe(batch.suggestions[0]);
  expect(fetch).toHaveBeenCalledTimes(1); // Acceptance never invokes chat/Agent.
  expect(result.current.batch).toBeNull();
  input += " In plain language.";
  rerender({ ...base(), input });
  let finish!: (submitted: boolean) => void;
  act(() => {
    finish = result.current.prepareSubmission();
    finish(false);
  });
  expect(
    jest
      .mocked(captureQueuedAuthenticatedEvent)
      .mock.calls.map(([event]) => event.event),
  ).not.toContain("contextual_next_actions_submitted");
  act(() => {
    finish = result.current.prepareSubmission();
    input = "";
    finish(true);
  });
  rerender({
    ...base(),
    input: "",
    completedTurn: { chatId: "chat", messageId: "followup" },
    latestMessageId: "followup",
  });
  const events = jest
    .mocked(captureQueuedAuthenticatedEvent)
    .mock.calls.map(([event]) => event);
  expect(events.map((event) => event.event)).toEqual(
    expect.arrayContaining([
      "contextual_next_actions_exposed",
      "contextual_next_actions_accepted",
      "contextual_next_actions_submitted",
      "contextual_next_actions_followup_finished",
    ]),
  );
  expect(
    events.find((event) => event.event.endsWith("_submitted"))?.properties
      ?.edited,
  ).toBe(true);
  expect(JSON.stringify(events)).not.toContain(batch.suggestions[0]);
});

test.each(["typing", "attachment", "navigation", "new turn", "error"])(
  "late response cannot revive suggestions after %s",
  async (change) => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    jest.mocked(fetch).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { result, rerender } = renderHook((props) => useNextActions(props), {
      initialProps: base(),
    });
    await settle();
    if (change === "typing") {
      input = "my draft";
      act(() => result.current.invalidate());
    }
    if (change === "attachment") attachments = true;
    rerender({
      ...base(),
      ...(change === "navigation" ? { chatId: "other" } : {}),
      ...(change === "new turn"
        ? { status: "submitted", latestMessageId: "new-user" }
        : {}),
      ...(change === "error" ? { status: "error" } : {}),
      blocked: attachments,
    });
    await act(async () => {
      resolve(response());
    });
    expect(result.current.batch).toBeNull();
    expect(setInput).not.toHaveBeenCalled();
  },
);

test("dismissal survives remount, and existing drafts/attachments prevent generation and acceptance", async () => {
  const first = renderHook(() => useNextActions(base()));
  await settle();
  act(() => first.result.current.dismiss());
  first.unmount();
  const second = renderHook(() => useNextActions(base()));
  await settle();
  expect(second.result.current.batch).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  second.unmount();
  sessionStorage.clear();
  input = "saved draft";
  const third = renderHook(() => useNextActions(base()));
  await settle();
  expect(fetch).toHaveBeenCalledTimes(1);
  third.unmount();
  sessionStorage.clear();
  input = "";
  const fourth = renderHook(() => useNextActions(base()));
  await settle();
  attachments = true; // synchronous race before React rerenders
  act(() => {
    expect(fourth.result.current.accept(0, "pointer")).toBe(false);
  });
  expect(setInput).not.toHaveBeenCalled();
});

test("persistence lag retries are bounded and failures stay silent", async () => {
  jest.mocked(fetch).mockResolvedValue({ ok: false, status: 409 } as Response);
  const { result } = renderHook(() => useNextActions(base()));
  await act(async () => {
    await jest.advanceTimersByTimeAsync(20_000);
  });
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(result.current.batch).toBeNull();
  expect(setInput).not.toHaveBeenCalled();
});
