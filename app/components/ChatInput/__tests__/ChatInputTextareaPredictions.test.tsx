import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  ComposerStateProvider,
  useComposerActions,
  useComposerInput,
} from "@/app/contexts/ComposerState";
import { useNextActions } from "@/app/hooks/useNextActions";
import { ChatInputTextarea } from "../ChatInputTextarea";
import { captureQueuedAuthenticatedEvent } from "@/lib/analytics/client";

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({ subscription: "pro" }),
}));
jest.mock("@/app/hooks/useFileUpload", () => ({
  useFileUpload: () => ({
    handlePasteEvent: async () => false,
    handlePastedTextAttachment: jest.fn(),
  }),
}));
jest.mock("@/lib/analytics/client", () => ({
  captureQueuedAuthenticatedEvent: jest.fn(),
}));
const send = jest.fn();
const suggestions = [
  "Explain the uncertainty in this finding.",
  "Summarize the existing evidence.",
];
function Harness({ blocked = false }: { blocked?: boolean }) {
  const input = useComposerInput();
  const { getInput, setInput } = useComposerActions();
  const controller = useNextActions({
    userId: "u",
    chatId: "chat",
    completedTurn: { chatId: "chat", messageId: "answer" },
    latestMessageId: "answer",
    status: "ready",
    blocked,
    input,
    getInput,
    setInput,
    hasAttachments: () => false,
  });
  return (
    <>
      <ChatInputTextarea
        draftId="chat"
        chatMode="ask"
        autoFocus={false}
        onEnterSubmit={send}
        prediction={controller.batch?.suggestions[0]}
        onAcceptPrediction={() => controller.accept(0, "keyboard")}
        onPredictionExposed={controller.exposed}
        composerFocused
        onDismissPrediction={controller.dismiss}
        onDraftInteraction={controller.invalidate}
      />
      <button type="button">Next control</button>
    </>
  );
}
beforeEach(() => {
  jest.useFakeTimers();
  sessionStorage.clear();
  localStorage.clear();
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      batchId: "batch",
      messageId: "answer",
      mode: "ask",
      suggestions,
    }),
  });
  global.IntersectionObserver = class {
    constructor(callback: IntersectionObserverCallback) {
      visibilityCallback = callback;
    }
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof IntersectionObserver;
});
let visibilityCallback: IntersectionObserverCallback;
afterEach(() => jest.useRealTimers());
async function setup(blocked = false) {
  render(
    <ComposerStateProvider>
      <Harness blocked={blocked} />
    </ComposerStateProvider>,
  );
  await act(async () => {
    await jest.advanceTimersByTimeAsync(500);
  });
  return screen.getByTestId("chat-input");
}

test("Tab only accepts into the empty focused composer; explicit Enter sends", async () => {
  const textarea = await setup();
  expect(textarea).toHaveAttribute("placeholder", suggestions[0]);
  expect(textarea).toHaveAccessibleName("Ask, learn, brainstorm");
  expect(
    screen.queryByRole("group", { name: "Suggested next messages" }),
  ).toBeNull();
  expect(screen.queryByText(suggestions[1])).toBeNull();
  expect(screen.getByText("Tab")).toHaveAttribute("aria-hidden", "true");
  expect(
    screen.queryByRole("button", { name: "Use suggested message" }),
  ).toBeNull();
  textarea.focus();
  fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });
  expect(textarea).toHaveValue("");
  fireEvent.keyDown(textarea, { key: "Tab", isComposing: true });
  expect(textarea).toHaveValue("");
  fireEvent.keyDown(textarea, { key: "Tab" });
  expect(textarea).toHaveValue(suggestions[0]);
  expect(textarea).toHaveAttribute("placeholder", "Ask, learn, brainstorm");
  expect(textarea).toHaveFocus();
  expect(send).not.toHaveBeenCalled();
  fireEvent.change(textarea, { target: { value: "My edited follow-up" } });
  expect(textarea).toHaveValue("My edited follow-up");
  fireEvent.keyDown(textarea, { key: "Enter" });
  expect(send).toHaveBeenCalledTimes(1);
});

test("an ineligible composer keeps its normal placeholder and Tab navigation", async () => {
  const textarea = await setup(true);
  expect(textarea).toHaveAttribute("placeholder", "Ask, learn, brainstorm");
  expect(screen.queryByText("Tab")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Use suggested message" }),
  ).toBeNull();
  expect(fireEvent.keyDown(textarea, { key: "Tab" })).toBe(true);
  expect(textarea).toHaveValue("");
  expect(fetch).not.toHaveBeenCalled();
  expect(captureQueuedAuthenticatedEvent).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test("Escape restores the ordinary placeholder and preserves composer focus", async () => {
  const textarea = await setup();
  textarea.focus();
  fireEvent.keyDown(textarea, { key: "Escape" });
  expect(textarea).toHaveFocus();
  expect(screen.queryByText("Tab")).toBeNull();
  expect(textarea).toHaveAttribute("placeholder", "Ask, learn, brainstorm");
  expect(send).not.toHaveBeenCalled();
});

test("Escape and typing dismiss permanently without sending", async () => {
  const textarea = await setup();
  fireEvent.keyDown(textarea, { key: "Escape" });
  expect(screen.queryByText("Tab")).not.toBeInTheDocument();
  fireEvent.change(textarea, { target: { value: "x" } });
  fireEvent.change(textarea, { target: { value: "" } });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(2000);
  });
  expect(screen.queryByText("Tab")).not.toBeInTheDocument();
  expect(send).not.toHaveBeenCalled();
});

test("typing replaces the suggestion and clearing the draft does not revive it", async () => {
  const textarea = await setup();
  fireEvent.change(textarea, { target: { value: "My own request" } });
  expect(textarea).toHaveValue("My own request");
  expect(textarea).toHaveAttribute("placeholder", "Ask, learn, brainstorm");
  fireEvent.change(textarea, { target: { value: "" } });
  expect(screen.queryByText("Tab")).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

test("exposure waits for the inline placeholder to be visible and is deduplicated", async () => {
  await setup();
  const observe = (ratio: number) =>
    act(() =>
      visibilityCallback(
        [
          {
            isIntersecting: ratio > 0,
            intersectionRatio: ratio,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      ),
    );
  observe(0.2);
  expect(captureQueuedAuthenticatedEvent).not.toHaveBeenCalled();
  observe(1);
  observe(1);
  expect(captureQueuedAuthenticatedEvent).toHaveBeenCalledTimes(1);
  expect(captureQueuedAuthenticatedEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "contextual_next_actions_exposed",
      properties: expect.objectContaining({
        shown_count: 1,
        presentation: "inline_composer",
      }),
    }),
  );
  expect(
    JSON.stringify(jest.mocked(captureQueuedAuthenticatedEvent).mock.calls),
  ).not.toContain(suggestions[0]);
});
