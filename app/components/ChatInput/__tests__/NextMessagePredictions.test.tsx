import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  ComposerStateProvider,
  useComposerActions,
  useComposerInput,
} from "@/app/contexts/ComposerState";
import { useNextActions } from "@/app/hooks/useNextActions";
import { ChatInputTextarea } from "../ChatInputTextarea";
import { NextMessagePredictions } from "../NextMessagePredictions";

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
function Harness() {
  const input = useComposerInput();
  const { getInput, setInput } = useComposerActions();
  const controller = useNextActions({
    userId: "u",
    chatId: "chat",
    completedTurn: { chatId: "chat", messageId: "answer" },
    latestMessageId: "answer",
    status: "ready",
    blocked: false,
    input,
    getInput,
    setInput,
    hasAttachments: () => false,
  });
  return (
    <>
      <NextMessagePredictions
        controller={controller}
        onFocusComposer={() => screen.getByTestId("chat-input").focus()}
      />
      <ChatInputTextarea
        draftId="chat"
        chatMode="ask"
        autoFocus={false}
        onEnterSubmit={send}
        prediction={controller.batch?.suggestions[0]}
        onAcceptPrediction={() => controller.accept(0, "keyboard")}
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
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof IntersectionObserver;
});
afterEach(() => jest.useRealTimers());
async function setup() {
  render(
    <ComposerStateProvider>
      <Harness />
    </ComposerStateProvider>,
  );
  await act(async () => {
    await jest.advanceTimersByTimeAsync(500);
  });
  return screen.getByTestId("chat-input");
}

test("Tab only accepts into the empty focused composer; explicit Enter sends", async () => {
  const textarea = await setup();
  textarea.focus();
  fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });
  expect(textarea).toHaveValue("");
  fireEvent.keyDown(textarea, { key: "Tab", isComposing: true });
  expect(textarea).toHaveValue("");
  fireEvent.keyDown(textarea, { key: "Tab" });
  expect(textarea).toHaveValue(suggestions[0]);
  expect(textarea).toHaveFocus();
  expect(send).not.toHaveBeenCalled();
  fireEvent.change(textarea, { target: { value: "My edited follow-up" } });
  expect(textarea).toHaveValue("My edited follow-up");
  fireEvent.keyDown(textarea, { key: "Enter" });
  expect(send).toHaveBeenCalledTimes(1);
});

test("touch acceptance of an alternative preserves focus and never submits", async () => {
  const textarea = await setup();
  const other = screen.getByRole("button", { name: "Next control" });
  other.focus();
  fireEvent.click(
    screen.getByRole("button", { name: "Show alternative suggestions" }),
  );
  const alternative = screen.getByRole("button", { name: suggestions[1] });
  const touch = new Event("pointerdown", { bubbles: true });
  Object.defineProperty(touch, "pointerType", { value: "touch" });
  fireEvent(alternative, touch);
  fireEvent.click(alternative, {
    detail: 1,
  });
  expect(textarea).toHaveValue(suggestions[1]);
  expect(other).toHaveFocus();
  expect(send).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("keyboard dismissal returns focus from the disappearing strip to the composer", async () => {
  const textarea = await setup();
  const dismiss = screen.getByRole("button", { name: "Dismiss suggestions" });
  dismiss.focus();
  fireEvent.keyDown(dismiss, { key: "Escape" });
  expect(textarea).toHaveFocus();
  expect(
    screen.queryByRole("group", { name: "Suggested next messages" }),
  ).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

test("Escape and typing dismiss permanently without sending", async () => {
  const textarea = await setup();
  fireEvent.keyDown(textarea, { key: "Escape" });
  expect(
    screen.queryByRole("group", { name: "Suggested next messages" }),
  ).not.toBeInTheDocument();
  fireEvent.change(textarea, { target: { value: "x" } });
  fireEvent.change(textarea, { target: { value: "" } });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(2000);
  });
  expect(
    screen.queryByRole("group", { name: "Suggested next messages" }),
  ).not.toBeInTheDocument();
  expect(send).not.toHaveBeenCalled();
});
