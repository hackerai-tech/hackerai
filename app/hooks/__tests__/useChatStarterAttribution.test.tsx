import { act, renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  getPermittedAnalyticsUserId,
  setAuthenticatedAnalyticsUserId,
} from "@/lib/analytics/client";
import {
  readAttributions,
  type StarterPersistedTurn,
} from "@/lib/analytics/chat-starters";
import {
  getChatStarterById,
  type ChatStarter,
} from "@/lib/chat/starter-prompts";

type Captured = {
  event: string;
  properties?: Record<string, unknown>;
  dedupeKey: string;
  /** The account the real queue would attribute this event to. */
  owner?: string | null;
};
const captured: Captured[] = [];
jest.mock("@/lib/analytics/client", () => {
  const actual = jest.requireActual<typeof import("@/lib/analytics/client")>(
    "@/lib/analytics/client",
  );
  return {
    ...actual,
    // Mirrors the real queue: accepted only while consent permits a user,
    // and attributed to whichever account is permitted at capture time.
    captureQueuedAuthenticatedEvent: (event: Captured) => {
      const owner = actual.getPermittedAnalyticsUserId();
      if (!owner) return false;
      captured.push({ ...event, owner });
      return true;
    },
  };
});

const { useChatStarterAttribution } = jest.requireActual<
  typeof import("../useChatStarterAttribution")
>("../useChatStarterAttribution");

const CHAT = "chat-0000-1111";
const ASSISTANT = "assistant-msg-1";
const fixToolError = getChatStarterById("fix_tool_error") as ChatStarter;

type Props = {
  userId: string | undefined;
  draftId: string;
  chatMode: "ask" | "agent";
  input: string;
  persistedTurn: StarterPersistedTurn | null;
};
let liveInput = "";
const initialProps = (overrides: Partial<Props> = {}): Props => ({
  userId: "user-1",
  draftId: "new",
  chatMode: "agent",
  input: "",
  persistedTurn: null,
  ...overrides,
});
const renderAttribution = (props: Props = initialProps()) =>
  renderHook(
    (current: Props) =>
      useChatStarterAttribution({ ...current, getInput: () => liveInput }),
    { initialProps: props },
  );

const events = (name: string) => captured.filter(({ event }) => event === name);
const turn = (
  userMessageId: string,
  overrides: Partial<StarterPersistedTurn> = {},
): StarterPersistedTurn => ({
  chatId: CHAT,
  settled: true,
  finishReason: "stop",
  // Persisted after the submission; a missing or older clock stays pending.
  lastRunFinishedAt: Date.now() + 1_000,
  userMessageIds: [userMessageId],
  replyAssistantMessageId: ASSISTANT,
  ...overrides,
});

/** Select an example, then submit through the ordinary transport path. */
const selectAndSubmit = (
  hook: ReturnType<typeof renderAttribution>,
  props: Props,
  text = fixToolError.prompt,
  {
    result = "accepted" as "accepted" | "refused" | "error",
    handedOff = true,
    ordinary = true,
  } = {},
) => {
  act(() => hook.result.current.recordSelection(fixToolError, "expanded"));
  liveInput = text;
  hook.rerender({ ...props, input: text });
  const submission = hook.result.current.prepareSubmission({ ordinary, text });
  if (handedOff && submission.attribution)
    submission.attribution.onUserMessageSent?.({
      chatId: CHAT,
      userMessageId: submission.attribution.userMessageId,
    });
  act(() => submission.settle(result));
  return submission.attribution?.userMessageId;
};

describe("useChatStarterAttribution", () => {
  beforeEach(() => {
    captured.length = 0;
    liveInput = "";
    window.sessionStorage.clear();
    setAuthenticatedAnalyticsUserId("user-1");
  });
  afterEach(() => act(() => setAuthenticatedAnalyticsUserId(null)));

  it.each(["agent", "ask"] as const)(
    "links a %s selection to its message and persisted natural completion once",
    (chatMode) => {
      const props = initialProps({ chatMode });
      const hook = renderAttribution(props);
      const userMessageId = selectAndSubmit(hook, props);

      const [selected] = events("chat_starter_selected");
      const selectionId = selected.properties?.selection_id;
      expect(selected.properties).toEqual({
        selection_id: expect.any(String),
        definition_version: 2,
        example_id: "fix_tool_error",
        mode: chatMode,
        presentation: "expanded",
      });
      expect(events("chat_starter_submitted")).toEqual([
        {
          event: "chat_starter_submitted",
          dedupeKey: `${selectionId}:submitted`,
          owner: "user-1",
          properties: expect.objectContaining({
            selection_id: selectionId,
            chat_id: CHAT,
            user_message_id: userMessageId,
            edited: false,
            selection_to_submission_ms: expect.any(Number),
            submission_source: "client_transport_handoff",
          }),
        },
      ]);

      // Accepted by the transport is not completion; active work stays pending.
      hook.rerender({
        ...props,
        persistedTurn: turn(userMessageId!, { settled: false }),
      });
      expect(events("chat_starter_turn_outcome")).toEqual([]);

      hook.rerender({ ...props, persistedTurn: turn(userMessageId!) });
      hook.rerender({
        ...props,
        persistedTurn: { ...turn(userMessageId!) },
      });
      expect(events("chat_starter_turn_outcome")).toEqual([
        expect.objectContaining({
          dedupeKey: `${selectionId}:outcome`,
          properties: expect.objectContaining({
            selection_id: selectionId,
            user_message_id: userMessageId,
            assistant_message_id: ASSISTANT,
            outcome: "completed",
            terminal_reason: "stop",
          }),
        }),
      ]);
      expect(JSON.stringify(captured)).not.toContain("[tool]");
    },
  );

  it("records edits and a cancellation separately from completion", () => {
    const props = initialProps({ chatMode: "ask" });
    const hook = renderAttribution(props);
    const userMessageId = selectAndSubmit(
      hook,
      props,
      "Help me fix this nmap error on Kali",
    );

    expect(events("chat_starter_submitted")[0].properties).toMatchObject({
      edited: true,
    });
    // Stop persisted canceled_at before any reply was saved.
    hook.rerender({
      ...props,
      persistedTurn: turn(userMessageId!, {
        finishReason: undefined,
        lastRunFinishedAt: undefined,
        canceledAt: Date.now(),
        replyAssistantMessageId: undefined,
      }),
    });
    const [outcome] = events("chat_starter_turn_outcome");
    expect(outcome.properties).toMatchObject({
      outcome: "canceled",
      terminal_reason: "user_stop",
      submission_to_observation_ms: expect.any(Number),
    });
    expect(outcome.properties).not.toHaveProperty("assistant_message_id");
    expect(JSON.stringify(captured)).not.toContain("Kali");
  });

  it("records a missing finish reason without a cancellation as unknown", () => {
    const props = initialProps();
    const hook = renderAttribution(props);
    const userMessageId = selectAndSubmit(hook, props);
    hook.rerender({
      ...props,
      persistedTurn: turn(userMessageId!, { finishReason: undefined }),
    });
    expect(events("chat_starter_turn_outcome")[0].properties).toMatchObject({
      outcome: "unknown",
      terminal_reason: "no_finish_reason",
    });
  });

  it("keeps the selection after refused or thrown attempts and records each", () => {
    const props = initialProps();
    const hook = renderAttribution(props);
    selectAndSubmit(hook, props, fixToolError.prompt, { result: "refused" });
    const error = hook.result.current.prepareSubmission({
      ordinary: true,
      text: fixToolError.prompt,
    });
    act(() => error.settle("error"));
    expect(events("chat_starter_submitted")).toEqual([]);
    const attempts = events("chat_starter_submit_not_handed_off");
    expect(attempts.map(({ properties }) => properties?.reason)).toEqual([
      "client_refused",
      "client_error",
    ]);
    const [refusedId, errorId] = attempts.map(
      ({ properties }) => properties?.attempt_id,
    );
    expect(refusedId).not.toBe(errorId);

    // The retained selection attributes the next accepted send.
    const retry = hook.result.current.prepareSubmission({
      ordinary: true,
      text: fixToolError.prompt,
    });
    expect(retry.attribution).toBeDefined();
    retry.attribution!.onUserMessageSent?.({
      chatId: CHAT,
      userMessageId: retry.attribution!.userMessageId,
    });
    act(() => retry.settle("accepted"));
    const [submitted] = events("chat_starter_submitted");
    expect(submitted.properties?.selection_id).toBe(
      events("chat_starter_selected")[0].properties?.selection_id,
    );
    expect([refusedId, errorId]).not.toContain(
      submitted.properties?.attempt_id,
    );
  });

  it("never records a late settle from an earlier account under the new one", () => {
    const props = initialProps();
    const hook = renderAttribution(props);
    act(() => hook.result.current.recordSelection(fixToolError, "expanded"));
    const late = hook.result.current.prepareSubmission({
      ordinary: true,
      text: fixToolError.prompt,
    });
    late.attribution!.onUserMessageSent?.({
      chatId: CHAT,
      userMessageId: late.attribution!.userMessageId,
    });
    const lateRefusal = hook.result.current.prepareSubmission({
      ordinary: true,
      text: fixToolError.prompt,
    });

    // Account B signs in while A's submission is still awaiting its handler.
    act(() => setAuthenticatedAnalyticsUserId("user-2"));
    const other = renderAttribution(initialProps({ userId: "user-2" }));
    act(() => other.result.current.recordSelection(fixToolError, "collapsed"));
    const ownStore = window.sessionStorage.getItem(
      "hackerai:chat-starters:attribution:v1",
    );

    act(() => late.settle("accepted"));
    act(() => lateRefusal.settle("refused"));
    expect(events("chat_starter_submitted")).toEqual([]);
    expect(events("chat_starter_submit_not_handed_off")).toEqual([]);
    expect(captured.filter(({ owner }) => owner === "user-2")).toEqual([
      expect.objectContaining({ event: "chat_starter_selected" }),
    ]);
    // B's store is untouched by A's late work.
    expect(
      window.sessionStorage.getItem("hackerai:chat-starters:attribution:v1"),
    ).toBe(ownStore);
    expect(readAttributions("user-2").entries).toEqual([
      expect.objectContaining({ state: "selected", presentation: "collapsed" }),
    ]);
  });

  it("resumes a pending outcome after reload without storing draft text", () => {
    const props = initialProps();
    const first = renderAttribution(props);
    const userMessageId = selectAndSubmit(first, props);
    first.unmount();
    expect(JSON.stringify(window.sessionStorage)).not.toContain("[tool]");

    const reloaded = renderAttribution(
      initialProps({ draftId: CHAT, persistedTurn: turn(userMessageId!) }),
    );
    expect(events("chat_starter_turn_outcome")).toHaveLength(1);
    reloaded.rerender(
      initialProps({ draftId: CHAT, persistedTurn: turn(userMessageId!) }),
    );
    expect(events("chat_starter_turn_outcome")).toHaveLength(1);
  });

  it("retains an unsent selection across a draft reload", () => {
    const props = initialProps();
    const first = renderAttribution(props);
    act(() => first.result.current.recordSelection(fixToolError, "collapsed"));
    first.unmount();

    liveInput = fixToolError.prompt;
    const reloaded = renderAttribution({ ...props, input: liveInput });
    const submission = reloaded.result.current.prepareSubmission({
      ordinary: true,
      text: liveInput,
    });
    expect(submission.attribution?.userMessageId).toEqual(expect.any(String));
  });

  it("ends the selection when the user clears the draft, without leaking to a fresh chat", () => {
    const props = initialProps();
    const hook = renderAttribution(props);
    act(() => hook.result.current.recordSelection(fixToolError, "expanded"));
    liveInput = fixToolError.prompt;
    hook.rerender({ ...props, input: liveInput });
    liveInput = "";
    hook.rerender({ ...props, input: "" });

    expect(events("chat_starter_selection_discarded")).toEqual([
      expect.objectContaining({
        properties: expect.objectContaining({ reason: "draft_cleared" }),
      }),
    ]);
    expect(
      hook.result.current.prepareSubmission({ ordinary: true, text: "hello" })
        .attribution,
    ).toBeUndefined();
  });

  it("does not treat a restored draft's stale empty render as a clear", () => {
    const props = initialProps();
    const hook = renderAttribution(props);
    act(() => hook.result.current.recordSelection(fixToolError, "expanded"));
    liveInput = fixToolError.prompt;
    hook.rerender({ ...props, input: liveInput });
    // A chat switch renders the previous value before restoring its draft.
    hook.rerender({ ...props, draftId: "chat-other-1", input: liveInput });
    hook.rerender({ ...props, draftId: "chat-other-1", input: "" });
    hook.rerender({ ...props, input: "" });
    expect(events("chat_starter_selection_discarded")).toEqual([]);
  });

  it.each([
    ["a goal, queued or reply submission", "agent", { ordinary: false }],
    ["a mode switch after selection", "ask", {}],
  ] as const)("does not attribute %s", (_label, submitMode, options) => {
    const props = initialProps();
    const hook = renderAttribution(props);
    act(() => hook.result.current.recordSelection(fixToolError, "expanded"));
    hook.rerender({ ...props, chatMode: submitMode });
    const submission = hook.result.current.prepareSubmission({
      ordinary: true,
      text: fixToolError.prompt,
      ...options,
    });
    expect(submission.attribution).toBeUndefined();
    act(() => submission.settle("accepted"));

    expect(events("chat_starter_submitted")).toEqual([]);
    expect(events("chat_starter_selection_discarded")[0].properties).toEqual(
      expect.objectContaining({
        reason: submitMode === "ask" ? "mode_changed" : "ineligible_submission",
      }),
    );
  });

  it("never counts a later turn or a waiting Agent as the starter outcome", () => {
    const props = initialProps();
    const hook = renderAttribution(props);
    const userMessageId = selectAndSubmit(hook, props);

    hook.rerender({
      ...props,
      persistedTurn: turn(userMessageId!, { settled: false }),
    });
    hook.rerender({
      ...props,
      persistedTurn: turn(userMessageId!, {
        userMessageIds: [userMessageId!, "later-user-msg"],
      }),
    });
    // Superseded turns end silently; their state belongs to the later turn.
    hook.rerender({ ...props, persistedTurn: turn(userMessageId!) });
    expect(events("chat_starter_turn_outcome")).toEqual([]);
  });

  it("drops attribution on consent loss and ignores another account", () => {
    const props = initialProps();
    const hook = renderAttribution(props);
    const userMessageId = selectAndSubmit(hook, props);

    act(() => setAuthenticatedAnalyticsUserId(null));
    act(() => setAuthenticatedAnalyticsUserId("user-1"));
    hook.rerender({ ...props, persistedTurn: turn(userMessageId!) });
    expect(events("chat_starter_turn_outcome")).toEqual([]);

    // A selection by user-1 is never attributed to user-2.
    act(() => hook.result.current.recordSelection(fixToolError, "expanded"));
    act(() => setAuthenticatedAnalyticsUserId("user-2"));
    const other = renderAttribution(initialProps({ userId: "user-2" }));
    expect(
      other.result.current.prepareSubmission({
        ordinary: true,
        text: fixToolError.prompt,
      }).attribution,
    ).toBeUndefined();
  });

  it("stores nothing when analytics consent is unavailable", () => {
    act(() => setAuthenticatedAnalyticsUserId(null));
    expect(getPermittedAnalyticsUserId()).toBeNull();
    const hook = renderAttribution();
    act(() => hook.result.current.recordSelection(fixToolError, "expanded"));
    expect(window.sessionStorage.length).toBe(0);
    expect(
      hook.result.current.prepareSubmission({
        ordinary: true,
        text: fixToolError.prompt,
      }).attribution,
    ).toBeUndefined();
  });
});
