/**
 * @jest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "@jest/globals";
import {
  ATTRIBUTION_STORAGE_KEY,
  ATTRIBUTION_TTL_MS,
  classifyTerminalState,
  clearAttributionsOfOtherUsers,
  findSelectionForDraft,
  finishAttribution,
  getStarterPersistedTurn,
  outcomeEvent,
  readAttributions,
  resolveStarterTurn,
  saveAttribution,
  submittedEvent,
  type StarterAttribution,
} from "../chat-starters";

const SELECTION = "11111111-1111-4111-8111-111111111111";
const USER_MESSAGE = "22222222-2222-4222-8222-222222222222";
const ASSISTANT_MESSAGE = "33333333-3333-4333-8333-333333333333";
const CHAT = "44444444-4444-4444-8444-444444444444";
const SUBMITTED_AT = 1_800_000_000_000;

const submitted: Extract<StarterAttribution, { state: "submitted" }> = {
  selectionId: SELECTION,
  exampleId: "fix_tool_error",
  definitionVersion: 2,
  mode: "agent",
  presentation: "expanded",
  draftId: "new",
  selectedAt: SUBMITTED_AT - 5_000,
  state: "submitted",
  chatId: CHAT,
  userMessageId: USER_MESSAGE,
  submittedAt: SUBMITTED_AT,
};

const settledChat = {
  id: CHAT,
  finish_reason: "stop" as string | undefined,
  last_run_finished_at: (SUBMITTED_AT + 60_000) as number | undefined,
};
const userOnly = [{ id: USER_MESSAGE, role: "user" }];
const turnMessages = [
  ...userOnly,
  { id: ASSISTANT_MESSAGE, role: "assistant" },
];
const resolve = (
  chat: Parameters<typeof getStarterPersistedTurn>[1],
  messages = turnMessages,
) =>
  resolveStarterTurn(submitted, getStarterPersistedTurn(CHAT, chat, messages));

describe("resolveStarterTurn", () => {
  it("links the submitted user message to its persisted natural completion", () => {
    expect(resolve(settledChat)).toEqual({
      status: "terminal",
      assistantMessageId: ASSISTANT_MESSAGE,
      outcome: "completed",
      reason: "stop",
    });
  });

  it.each([
    ["an active Ask stream", { active_stream_id: "stream-1" }],
    ["an active Agent run", { active_trigger_run_id: "run-1" }],
    ["a pending approval", { active_agent_approval_pending: true }],
    ["an Agent waiting for the user", { active_agent_user_wait: {} }],
  ])("stays pending during %s", (_label, active) => {
    expect(resolve({ ...settledChat, ...active })).toEqual({
      status: "pending",
    });
  });

  it("requires a persisted reply before calling a turn completed", () => {
    expect(resolve(settledChat, [])).toEqual({ status: "pending" });
    expect(resolve(settledChat, userOnly)).toEqual({ status: "pending" });
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["not finite", Number.NaN],
    ["from an earlier run", SUBMITTED_AT - 3_600_000],
  ])("stays pending when the finish time is %s", (_label, finishedAt) => {
    expect(
      resolve({ ...settledChat, last_run_finished_at: finishedAt }),
    ).toEqual({ status: "pending" });
  });

  it("never counts another chat", () => {
    const other = "55555555-5555-4555-8555-555555555555";
    expect(
      resolveStarterTurn(
        submitted,
        getStarterPersistedTurn(
          other,
          { ...settledChat, id: other },
          turnMessages,
        ),
      ),
    ).toEqual({ status: "pending" });
  });

  it("reports a later user turn as superseded instead of using its state", () => {
    expect(
      resolve(settledChat, [
        ...turnMessages,
        { id: "66666666-6666-4666-8666-666666666666", role: "user" },
        { id: "77777777-7777-4777-8777-777777777777", role: "assistant" },
      ]),
    ).toEqual({ status: "superseded" });
  });

  it("records an explicit recent Stop as canceled even before a reply saves", () => {
    // Stop clears the finish reason and sets canceled_at in one write.
    expect(
      resolve(
        {
          ...settledChat,
          finish_reason: undefined,
          last_run_finished_at: undefined,
          canceled_at: SUBMITTED_AT + 2_000,
        },
        userOnly,
      ),
    ).toEqual({ status: "terminal", outcome: "canceled", reason: "user_stop" });
    // An old cancellation from before this submission is not this turn's.
    expect(
      resolve(
        {
          ...settledChat,
          finish_reason: undefined,
          last_run_finished_at: undefined,
          canceled_at: SUBMITTED_AT - 3_600_000,
        },
        userOnly,
      ),
    ).toEqual({ status: "pending" });
  });

  it("does not call a missing finish reason canceled without a cancellation", () => {
    expect(resolve({ ...settledChat, finish_reason: undefined })).toEqual({
      status: "terminal",
      assistantMessageId: ASSISTANT_MESSAGE,
      outcome: "unknown",
      reason: "no_finish_reason",
    });
  });

  it("records a persisted failure without a saved reply", () => {
    expect(
      resolve({ ...settledChat, finish_reason: "error" }, userOnly),
    ).toEqual({ status: "terminal", outcome: "failed", reason: "error" });
  });
});

describe("classifyTerminalState", () => {
  it.each([
    ["stop", "completed", "stop"],
    ["error", "failed", "error"],
    ["local-connection-lost", "failed", "connection_lost"],
    ["length", "incomplete", "output_limit"],
    ["tool-calls", "incomplete", "step_limit"],
    ["agent-run-spend-cap", "incomplete", "usage_limit"],
  ])("maps %p to %s/%s", (finishReason, outcome, reason) => {
    expect(classifyTerminalState(finishReason, false)).toEqual({
      outcome,
      reason,
    });
  });

  it("keeps unrecognized reasons unknown and never forwards their text", () => {
    for (const raw of ["length; prompt=secret", "constructor"])
      expect(classifyTerminalState(raw, false)).toEqual({
        outcome: "unknown",
        reason: "unrecognized_finish_reason",
      });
  });
});

describe("outcome event", () => {
  it("omits a missing reply and bounds the observation latency", () => {
    const { properties } = outcomeEvent(
      submitted,
      { status: "terminal", outcome: "canceled", reason: "user_stop" },
      SUBMITTED_AT + 10 * ATTRIBUTION_TTL_MS,
    );
    expect(properties).not.toHaveProperty("assistant_message_id");
    expect(properties).toMatchObject({
      outcome: "canceled",
      submission_to_observation_ms: ATTRIBUTION_TTL_MS,
      outcome_source: "persisted_chat_state",
    });
  });
});

describe("attribution storage", () => {
  beforeEach(() => window.sessionStorage.clear());

  const selected: StarterAttribution = {
    ...submitted,
    state: "selected",
    selectedAt: Date.now(),
  };

  it("is owned by one account and cleared for another", () => {
    saveAttribution("user-a", selected);
    expect(findSelectionForDraft("user-b", "new")).toBeUndefined();
    expect(findSelectionForDraft("user-a", "new")?.selectionId).toBe(SELECTION);
    clearAttributionsOfOtherUsers("user-b");
    expect(window.sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY)).toBeNull();
  });

  it("never revives a finished selection", () => {
    saveAttribution("user-a", selected);
    finishAttribution("user-a", SELECTION);
    expect(saveAttribution("user-a", selected)).toBe(false);
    expect(readAttributions("user-a").entries).toEqual([]);
  });

  it("drops expired and malformed entries", () => {
    saveAttribution("user-a", {
      ...selected,
      selectedAt: Date.now() - ATTRIBUTION_TTL_MS - 1,
    });
    expect(readAttributions("user-a").entries).toEqual([]);
    window.sessionStorage.setItem(
      ATTRIBUTION_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        userId: "user-a",
        finished: [],
        entries: [{ ...selected, selectionId: "<script>" }],
      }),
    );
    expect(readAttributions("user-a").entries).toEqual([]);
  });

  it("stores only IDs, categories and timestamps", () => {
    saveAttribution("user-a", selected);
    expect(window.sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY)).not.toMatch(
      /\[tool\]|Help me/,
    );
  });
});

describe("submitted event", () => {
  it("bounds the elapsed time and labels the client handoff", () => {
    const { properties } = submittedEvent(
      { ...submitted, selectedAt: SUBMITTED_AT - 10 * ATTRIBUTION_TTL_MS },
      "attempt-0001",
      false,
    );
    expect(properties).toMatchObject({
      selection_id: SELECTION,
      attempt_id: "attempt-0001",
      user_message_id: USER_MESSAGE,
      selection_to_submission_ms: ATTRIBUTION_TTL_MS,
      submission_source: "client_transport_handoff",
    });
  });
});
