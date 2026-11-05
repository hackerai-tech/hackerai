import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  ComposerStateProvider,
  useComposerActions,
  useComposerInput,
} from "@/app/contexts/ComposerState";
import { useNextActions } from "@/app/hooks/useNextActions";
import { ChatInputTextarea } from "../ChatInputTextarea";
import { captureQueuedAuthenticatedEvent } from "@/lib/analytics/client";
import { getComposerChangeDiagnostics } from "@/lib/posthog/composer-change-diagnostics";

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
  getIdentifiedAnalyticsUserId: () => "u",
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
    chatMode: "ask",
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
        onPredictionTyping={controller.recordTyping}
        composerFocused
        onDismissPrediction={controller.dismiss}
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

test("change diagnostics preserve editing and IME, including malformed native metadata", async () => {
  const textarea = await setup(true);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(5001);
  });
  getComposerChangeDiagnostics();
  fireEvent.input(textarea, {
    target: { value: "Synthetic composing edit" },
    inputType: "insertCompositionText",
    isComposing: true,
  });
  expect(textarea).toHaveValue("Synthetic composing edit");
  expect(getComposerChangeDiagnostics()).toMatchObject({
    hackerai_composer_change_recent_count: 1,
    hackerai_composer_change_last_input_type: "insertCompositionText",
    hackerai_composer_change_composing_count: 1,
  });
  fireEvent.keyDown(textarea, {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  expect(send).not.toHaveBeenCalled();

  const malformed = createEvent.change(textarea, {
    target: { value: "Synthetic ordinary edit" },
  });
  Object.defineProperty(malformed, "inputType", {
    get: () => {
      throw new Error("Diagnostic getter failed");
    },
  });
  fireEvent(textarea, malformed);
  expect(textarea).toHaveValue("Synthetic ordinary edit");
});

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

test("Escape dismisses permanently without sending", async () => {
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

test("typing hides the suggestion and clearing the draft restores it", async () => {
  const textarea = await setup();
  fireEvent.change(textarea, { target: { value: "My own request" } });
  expect(textarea).toHaveValue("My own request");
  expect(textarea).toHaveAttribute("placeholder", "Ask, learn, brainstorm");
  fireEvent.change(textarea, { target: { value: "" } });
  expect(textarea).toHaveAttribute("placeholder", suggestions[0]);
  expect(screen.getByText("Tab")).toBeInTheDocument();
  expect(
    jest.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
  expect(
    jest
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "DELETE"),
  ).toHaveLength(0);
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
  observe(0.5);
  observe(0.99);
  expect(
    jest
      .mocked(captureQueuedAuthenticatedEvent)
      .mock.calls.map(([event]) => event.event),
  ).toEqual(["contextual_next_actions_settled"]);
  observe(1);
  observe(1);
  expect(
    jest
      .mocked(captureQueuedAuthenticatedEvent)
      .mock.calls.filter(
        ([event]) => event.event === "contextual_next_actions_exposed",
      ),
  ).toHaveLength(1);
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

test("typing then erasing in one update is observed while a prediction is pending", async () => {
  let resolve!: (value: Response) => void;
  jest.mocked(fetch).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  render(
    <ComposerStateProvider>
      <Harness />
    </ComposerStateProvider>,
  );
  await act(async () => jest.advanceTimersByTimeAsync(500));
  const textarea = screen.getByTestId("chat-input");
  act(() => {
    fireEvent.change(textarea, { target: { value: "An independent thought" } });
    fireEvent.change(textarea, { target: { value: "" } });
  });
  await act(async () =>
    resolve({
      ok: true,
      status: 200,
      json: async () => ({
        batchId: "batch",
        messageId: "answer",
        mode: "ask",
        suggestions,
      }),
    } as Response),
  );
  const event = jest
    .mocked(captureQueuedAuthenticatedEvent)
    .mock.calls.find(
      ([event]) => event.event === "contextual_next_actions_settled",
    )?.[0];
  expect(event?.properties).toMatchObject({
    outcome: "ready",
    typed_before_settle: true,
    draft_nonempty_at_settle: false,
  });
  expect(textarea).toHaveValue("");
  expect(JSON.stringify(event)).not.toContain("An independent thought");
});
