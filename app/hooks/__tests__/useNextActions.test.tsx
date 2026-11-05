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
const generationCalls = () =>
  jest.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
const response = () => ({ ok: true, status: 200, json: async () => batch });
const settledEvents = () =>
  jest
    .mocked(captureQueuedAuthenticatedEvent)
    .mock.calls.map(([event]) => event)
    .filter((event) => event.event === "contextual_next_actions_settled");
let input = "";
let attachments = false;
const setInput = jest.fn((value: string) => {
  input = value;
});
const base = () => ({
  userId: "u",
  chatId: "chat",
  chatMode: "ask" as "ask" | "agent",
  completedTurn: { chatId: "chat", messageId: "answer" },
  interruptedTurn: null as { chatId: string } | null,
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

test("readiness records scheduled-to-result time once and remains separate from exposure", async () => {
  let resolve!: (value: ReturnType<typeof response>) => void;
  jest.mocked(fetch).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const { result } = renderHook(() => useNextActions(base()));
  await settle();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1200);
    resolve(response());
  });
  expect(settledEvents()).toHaveLength(1);
  expect(settledEvents()[0].properties).toEqual({
    definition_version: 1,
    timing_version: 1,
    attempt_id: expect.any(String),
    chat_id: "chat",
    message_id: "answer",
    mode: "ask",
    presentation: "inline_composer",
    request_kind: "generate",
    outcome: "ready",
    elapsed_ms: 1700,
    typed_before_settle: false,
    draft_nonempty_at_settle: false,
    page_visible: true,
    batch_id: "batch",
    suggestion_count: 2,
  });
  expect(result.current.batch).toEqual(batch);
  await act(async () => jest.advanceTimersByTimeAsync(20_000));
  expect(settledEvents()).toHaveLength(1);
});

test.each([false, true])(
  "readiness remembers typing even after clearing=%s and never writes the draft",
  async (cleared) => {
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
    // The textarea callback observes even type+erase inside one React batch.
    act(() => {
      input = "Independent draft";
      result.current.recordTyping();
      if (cleared) input = "";
    });
    rerender(base());
    await act(async () => resolve(response()));
    expect(settledEvents()[0].properties).toMatchObject({
      outcome: "ready",
      typed_before_settle: true,
      draft_nonempty_at_settle: !cleared,
    });
    expect(setInput).not.toHaveBeenCalled();
    expect(JSON.stringify(settledEvents())).not.toMatch(
      /Independent draft|missing evidence/,
    );
    if (!cleared) {
      expect(result.current.batch).toBeNull();
      input = "";
      rerender(base());
    }
    expect(result.current.batch).toEqual(batch);
    expect(settledEvents()).toHaveLength(1);
  },
);

test("restoration has its own request kind and never claims a new generation", async () => {
  renderHook(() =>
    useNextActions({
      ...base(),
      completedTurn: null,
      latestMessageIsAssistant: true,
    }),
  );
  await settle();
  expect(settledEvents()[0].properties).toMatchObject({
    request_kind: "restore",
    outcome: "ready",
  });
});

test("a retry revoked by the synchronous attachment guard settles as aborted", async () => {
  jest.mocked(fetch).mockResolvedValue({ ok: false, status: 409 } as Response);
  renderHook(() => useNextActions(base()));
  await settle();
  // Attachment state can change before React commits the next render.
  attachments = true;
  await act(async () => jest.advanceTimersByTimeAsync(1000));
  expect(generationCalls()).toHaveLength(1);
  expect(settledEvents()).toHaveLength(1);
  expect(settledEvents()[0].properties).toMatchObject({
    outcome: "aborted",
    elapsed_ms: 1500,
  });
  await act(async () => jest.advanceTimersByTimeAsync(20_000));
  expect(settledEvents()).toHaveLength(1);
});

test.each(["empty", "failed", "timeout"])(
  "reports %s independently of a ready batch",
  async (outcome) => {
    if (outcome === "empty")
      jest.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ suggestions: [] }),
      } as Response);
    if (outcome === "failed")
      jest
        .mocked(fetch)
        .mockRejectedValue(new Error("synthetic network failure"));
    if (outcome === "timeout")
      jest.mocked(fetch).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useNextActions(base()));
    await settle();
    if (outcome === "timeout")
      await act(async () => jest.advanceTimersByTimeAsync(18_000));
    expect(settledEvents()).toHaveLength(1);
    expect(settledEvents()[0].properties).toMatchObject({
      request_kind: "generate",
      outcome,
    });
    expect(settledEvents()[0].properties).not.toHaveProperty("batch_id");
    expect(result.current.batch).toBeNull();
  },
);

test("navigation reports the source attempt without inspecting the destination draft", async () => {
  jest.mocked(fetch).mockReturnValue(new Promise(() => {}));
  const { rerender } = renderHook((props) => useNextActions(props), {
    initialProps: base(),
  });
  await settle();
  input = "Destination draft";
  rerender({ ...base(), chatId: "other", latestMessageId: "other-answer" });
  expect(settledEvents()).toHaveLength(1);
  expect(settledEvents()[0].properties).toMatchObject({
    chat_id: "chat",
    message_id: "answer",
    outcome: "aborted",
    typed_before_settle: false,
  });
  expect(settledEvents()[0].properties).not.toHaveProperty(
    "draft_nonempty_at_settle",
  );
});

test("a telemetry enqueue failure cannot suppress a valid suggestion", async () => {
  jest.mocked(captureQueuedAuthenticatedEvent).mockImplementationOnce(() => {
    throw new Error("telemetry unavailable");
  });
  const { result } = renderHook(() => useNextActions(base()));
  await settle();
  expect(result.current.batch).toEqual(batch);
  expect(setInput).not.toHaveBeenCalled();
});

test("acceptance creates an editable draft; exposure, submission and finish are separate and content-free", async () => {
  const { result, rerender } = renderHook((props) => useNextActions(props), {
    initialProps: base(),
  });
  await settle();
  expect(result.current.batch?.suggestions).toHaveLength(2);
  expect(
    jest
      .mocked(captureQueuedAuthenticatedEvent)
      .mock.calls.map(([event]) => event.event),
  ).toEqual(["contextual_next_actions_settled"]);
  act(() => result.current.exposed());
  act(() => {
    expect(result.current.accept(0, "keyboard")).toBe(true);
  });
  expect(input).toBe(batch.suggestions[0]);
  expect(generationCalls()).toHaveLength(1); // Acceptance never invokes chat/Agent.
  expect(result.current.batch).toBeNull();
  input += " In plain language.";
  rerender({ ...base(), input, chatMode: "agent" });
  expect(input).toBe(`${batch.suggestions[0]} In plain language.`);
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
  expect(generationCalls()).toHaveLength(1);
  second.unmount();
  sessionStorage.clear();
  input = "saved draft";
  const third = renderHook(() => useNextActions(base()));
  await settle();
  expect(generationCalls()).toHaveLength(1);
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

test("an aborted accepted follow-up cannot be credited to a later regenerate", async () => {
  const { result, rerender } = renderHook((props) => useNextActions(props), {
    initialProps: base(),
  });
  await settle();
  act(() => {
    result.current.accept(0, "keyboard");
    const finish = result.current.prepareSubmission();
    input = "";
    finish(true);
  });
  rerender({
    ...base(),
    interruptedTurn: { chatId: "chat" },
  });
  rerender({
    ...base(),
    completedTurn: { chatId: "chat", messageId: "regenerated" },
    latestMessageId: "regenerated",
  });
  expect(
    jest
      .mocked(captureQueuedAuthenticatedEvent)
      .mock.calls.map(([e]) => e.event),
  ).not.toContain("contextual_next_actions_followup_finished");
});

test.each(["pending", "visible"])(
  "losing large-screen eligibility revokes a %s suggestion without reviving it",
  async (phase) => {
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
    const signal = jest.mocked(fetch).mock.calls[0][1]?.signal;
    if (phase === "visible") {
      await act(async () => resolve(response()));
      expect(result.current.batch).not.toBeNull();
    }
    rerender({ ...base(), blocked: true });
    expect(signal?.aborted).toBe(true);
    if (phase === "pending") await act(async () => resolve(response()));
    expect(result.current.batch).toBeNull();
    act(() => {
      result.current.exposed();
      expect(result.current.accept(0, "keyboard")).toBe(false);
    });
    expect(setInput).not.toHaveBeenCalled();
    expect(
      jest
        .mocked(captureQueuedAuthenticatedEvent)
        .mock.calls.map(([event]) => event.event),
    ).toEqual(["contextual_next_actions_settled"]);
    rerender(base());
    await settle();
    expect(generationCalls()).toHaveLength(1);
    expect(result.current.batch).toBeNull();
  },
);

test.each(["pending", "visible"])(
  "switching mode discards a %s prediction and does not revive it",
  async (phase) => {
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
    const signal = jest.mocked(fetch).mock.calls[0][1]?.signal;
    if (phase === "visible") await act(async () => resolve(response()));
    rerender({ ...base(), chatMode: "agent" });
    expect(signal?.aborted).toBe(true);
    if (phase === "pending") await act(async () => resolve(response()));
    expect(result.current.batch).toBeNull();
    act(() => {
      result.current.exposed();
      expect(result.current.accept(0, "keyboard")).toBe(false);
    });
    expect(setInput).not.toHaveBeenCalled();
    expect(
      jest
        .mocked(captureQueuedAuthenticatedEvent)
        .mock.calls.map(([event]) => event.event),
    ).toEqual(["contextual_next_actions_settled"]);
    rerender(base());
    await settle();
    expect(generationCalls()).toHaveLength(1);
    expect(result.current.batch).toBeNull();
  },
);

test("a mismatched server mode stays silent", async () => {
  const { result } = renderHook(() =>
    useNextActions({ ...base(), chatMode: "agent" }),
  );
  await settle();
  expect(result.current.batch).toBeNull();
  act(() => expect(result.current.accept(0, "keyboard")).toBe(false));
  expect(setInput).not.toHaveBeenCalled();
});

test("returning to a chat restores the saved batch without requiring an in-memory completion", async () => {
  const first = renderHook(() => useNextActions(base()));
  await settle();
  expect(first.result.current.batch?.batchId).toBe("batch");
  first.unmount();
  expect(
    jest
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "DELETE"),
  ).toHaveLength(0);
  const restored = renderHook(() =>
    useNextActions({
      ...base(),
      completedTurn: null,
      latestMessageIsAssistant: true,
    }),
  );
  await settle();
  expect(restored.result.current.batch).toEqual(batch);
  expect(JSON.parse(String(generationCalls().at(-1)?.[1]?.body))).toEqual({
    chatId: "chat",
    messageId: "answer",
    restoreOnly: true,
  });
  expect(setInput).not.toHaveBeenCalled();
});

test("switching chats keeps each saved suggestion private to its source and can restore on return", async () => {
  const { result, rerender } = renderHook((props) => useNextActions(props), {
    initialProps: {
      ...base(),
      latestMessageIsAssistant: true,
      completedTurn: null,
    },
  });
  await settle();
  expect(result.current.batch).toEqual(batch);
  jest.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ suggestions: [] }),
  } as Response);
  rerender({
    ...base(),
    chatId: "other",
    latestMessageId: "other-answer",
    latestMessageIsAssistant: true,
    completedTurn: null,
  });
  expect(result.current.batch).toBeNull();
  await settle();
  rerender({ ...base(), latestMessageIsAssistant: true, completedTurn: null });
  await settle();
  expect(result.current.batch).toEqual(batch);
  expect(
    jest
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "DELETE"),
  ).toHaveLength(0);
});

test("dismissal is persisted separately from generation and no saved content is sent", async () => {
  const { result } = renderHook(() => useNextActions(base()));
  await settle();
  act(() => result.current.dismiss());
  const deletion = jest
    .mocked(fetch)
    .mock.calls.find(([, init]) => init?.method === "DELETE");
  expect(JSON.parse(String(deletion?.[1]?.body))).toEqual({
    chatId: "chat",
    messageId: "answer",
  });
  expect(deletion?.[1]?.keepalive).toBe(true);
  expect(JSON.stringify(deletion)).not.toContain(batch.suggestions[0]);
});

test("a small screen does not fetch or consume a previously saved suggestion", async () => {
  renderHook(() =>
    useNextActions({
      ...base(),
      completedTurn: null,
      latestMessageIsAssistant: true,
      blocked: true,
    }),
  );
  await settle();
  expect(fetch).not.toHaveBeenCalled();
});

test("navigating to a chat with a different mode does not consume its saved batch", async () => {
  const { result, rerender } = renderHook((props) => useNextActions(props), {
    initialProps: {
      ...base(),
      latestMessageIsAssistant: true,
      completedTurn: null,
    },
  });
  await settle();
  jest.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      ...batch,
      batchId: "agent-batch",
      mode: "agent",
      messageId: "agent-answer",
    }),
  } as Response);
  rerender({
    ...base(),
    chatId: "agent-chat",
    chatMode: "agent",
    latestMessageId: "agent-answer",
    latestMessageIsAssistant: true,
    completedTurn: null,
  });
  await settle();
  expect(result.current.batch?.batchId).toBe("agent-batch");
  expect(
    jest
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "DELETE"),
  ).toHaveLength(0);
});

test("saved mode initialization does not consume a batch while Ask resolves to Agent", async () => {
  const initial = {
    ...base(),
    completedTurn: null,
    latestMessageIsAssistant: true,
    modeReady: false,
  };
  jest.mocked(fetch).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ...batch, mode: "agent" }),
  } as Response);
  const { result, rerender } = renderHook((props) => useNextActions(props), {
    initialProps: initial,
  });
  await settle();
  expect(fetch).not.toHaveBeenCalled();
  rerender({ ...initial, chatMode: "agent", modeReady: true });
  await settle();
  expect(result.current.batch?.mode).toBe("agent");
  expect(
    jest
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "DELETE"),
  ).toHaveLength(0);
  expect(JSON.parse(String(generationCalls()[0][1]?.body)).restoreOnly).toBe(
    true,
  );
  rerender({ ...initial, chatMode: "ask", modeReady: true });
  expect(result.current.batch).toBeNull();
  expect(
    jest
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "DELETE"),
  ).toHaveLength(1);
});

test("destination messages arriving before its saved mode do not consume the destination batch", async () => {
  const { result, rerender } = renderHook((props) => useNextActions(props), {
    initialProps: {
      ...base(),
      completedTurn: null,
      latestMessageIsAssistant: true,
      modeReady: true,
    },
  });
  await settle();
  const target = {
    ...base(),
    chatId: "target",
    latestMessageId: "target-answer",
    completedTurn: null,
    latestMessageIsAssistant: true,
    modeReady: false,
  };
  rerender(target);
  await settle();
  expect(generationCalls()).toHaveLength(1);
  jest.mocked(fetch).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      ...batch,
      mode: "agent",
      messageId: "target-answer",
    }),
  } as Response);
  rerender({ ...target, chatMode: "agent", modeReady: true });
  await settle();
  expect(result.current.batch?.messageId).toBe("target-answer");
  expect(
    jest
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "DELETE"),
  ).toHaveLength(0);
});

test("clearing ordinary typing restores the same batch without another request or consumption", async () => {
  const { result, rerender } = renderHook((props) => useNextActions(props), {
    initialProps: base(),
  });
  await settle();
  input = "A different draft";
  rerender(base());
  expect(result.current.batch).toBeNull();
  await act(async () => jest.advanceTimersByTimeAsync(20_000));
  input = "";
  rerender(base());
  await settle();
  expect(result.current.batch).toEqual(batch);
  expect(generationCalls()).toHaveLength(1);
  expect(
    jest
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "DELETE"),
  ).toHaveLength(0);
  expect(setInput).not.toHaveBeenCalled();
});

test("an in-flight prediction stays hidden while typing and appears only after the draft is cleared", async () => {
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
  const signal = generationCalls()[0][1]?.signal;
  input = "Keep my work";
  rerender(base());
  await act(async () => resolve(response()));
  expect(signal?.aborted).toBe(false);
  expect(result.current.batch).toBeNull();
  expect(input).toBe("Keep my work");
  expect(setInput).not.toHaveBeenCalled();
  input = "";
  rerender(base());
  expect(result.current.batch).toEqual(batch);
  expect(generationCalls()).toHaveLength(1);
});

test("clearing a restored draft can start the first prediction without disturbing the draft", async () => {
  input = "Saved unfinished draft";
  const { result, rerender } = renderHook((props) => useNextActions(props), {
    initialProps: base(),
  });
  await settle();
  expect(fetch).not.toHaveBeenCalled();
  input = "";
  rerender(base());
  await settle();
  expect(result.current.batch).toEqual(batch);
  expect(setInput).not.toHaveBeenCalled();
});
