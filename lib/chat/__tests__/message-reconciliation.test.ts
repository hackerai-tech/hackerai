import {
  areMessagesEquivalentForConvexSync,
  mergePersistedGoalMessages,
  arePersistedMessagesAtLeastAsComplete,
  normalizeStreamedRecoveryMessages,
  markLoopRecoveryCheckpoint,
} from "../message-reconciliation";
import type { ChatMessage } from "@/types";

const createAssistantMessage = (
  text: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage => ({
  id: "assistant-1",
  role: "assistant",
  parts: [{ type: "text", text }],
  ...overrides,
});

describe("loop recovery boundaries", () => {
  const tool = {
    type: "tool-file",
    toolCallId: "read-once",
    state: "output-available",
    input: { action: "read", path: "/tmp/result.txt" },
    output: "saved result",
  } as ChatMessage["parts"][number];
  const primary = createAssistantMessage("", {
    id: "primary",
    parts: [{ type: "text", text: "Discarded looping prose." }, tool],
  });
  const fallback = createAssistantMessage("", {
    id: "fallback",
    metadata: { recoverySourceMessageId: primary.id },
    parts: [...primary.parts, { type: "text", text: "Current answer" }],
  });
  const checkpoint = markLoopRecoveryCheckpoint(
    { ...primary, parts: [tool] },
    fallback.id,
  );
  const savedFallback = {
    ...fallback,
    parts: [{ type: "text" as const, text: "Current answer" }],
  };

  it("preserves newer fallback content when a saved suffix is stale", () => {
    expect(
      arePersistedMessagesAtLeastAsComplete(
        [primary, fallback],
        [
          checkpoint,
          { ...savedFallback, parts: [{ type: "text", text: "Current" }] },
        ],
      ),
    ).toBe(false);
    expect(
      arePersistedMessagesAtLeastAsComplete([primary, fallback], [checkpoint]),
    ).toBe(false);
  });

  it("does not discard prose without a matching saved recovery checkpoint", () => {
    expect(
      arePersistedMessagesAtLeastAsComplete(
        [primary, fallback],
        [{ ...primary, parts: [tool] }, savedFallback],
      ),
    ).toBe(false);
    expect(
      arePersistedMessagesAtLeastAsComplete(
        [primary, fallback],
        [
          markLoopRecoveryCheckpoint(
            { ...primary, parts: [tool] },
            "different-retry",
          ),
          savedFallback,
        ],
      ),
    ).toBe(false);
    expect(arePersistedMessagesAtLeastAsComplete([primary], [checkpoint])).toBe(
      false,
    );
  });

  it("keeps tools whose progress is missing or stale in the checkpoint", () => {
    const pending = {
      ...tool,
      state: "input-available",
      output: undefined,
    } as ChatMessage["parts"][number];
    expect(
      arePersistedMessagesAtLeastAsComplete(
        [primary, fallback],
        [
          markLoopRecoveryCheckpoint(
            { ...primary, parts: [pending] },
            fallback.id,
          ),
          savedFallback,
        ],
      ),
    ).toBe(false);
    const newer = {
      ...primary,
      parts: [
        ...primary.parts,
        {
          ...tool,
          toolCallId: "unsettled",
          state: "input-available",
          output: undefined,
        } as ChatMessage["parts"][number],
      ],
    };
    expect(
      arePersistedMessagesAtLeastAsComplete(
        [newer, savedFallback],
        [checkpoint, savedFallback],
      ),
    ).toBe(false);
  });

  it("requires an exact prefix and never crosses a user turn", () => {
    const unrelated = { ...fallback, metadata: undefined };
    const changed = {
      ...fallback,
      parts: [{ type: "text" as const, text: "Different content" }, tool],
    };
    expect(normalizeStreamedRecoveryMessages([primary, unrelated])[1]).toBe(
      unrelated,
    );
    expect(normalizeStreamedRecoveryMessages([primary, changed])[1]).toBe(
      changed,
    );
    const nextUser: ChatMessage = {
      id: "next-user",
      role: "user",
      parts: [{ type: "text", text: "New task" }],
    };
    expect(
      normalizeStreamedRecoveryMessages([primary, nextUser, fallback])[2],
    ).toBe(fallback);
    expect(
      arePersistedMessagesAtLeastAsComplete(
        [primary, nextUser, fallback],
        [checkpoint, nextUser, savedFallback],
      ),
    ).toBe(false);
  });

  it("keeps each attempt once through chained replacement and a persisted reload", () => {
    const third = {
      ...fallback,
      id: "third",
      metadata: { recoverySourceMessageId: fallback.id },
      parts: [
        ...fallback.parts,
        { type: "text" as const, text: "Third attempt" },
      ],
    };
    const displayed = normalizeStreamedRecoveryMessages([
      primary,
      fallback,
      third,
    ]);
    expect(displayed[1].parts).toEqual(savedFallback.parts);
    expect(displayed[2].parts).toEqual([
      { type: "text", text: "Third attempt" },
    ]);
    expect(
      normalizeStreamedRecoveryMessages([checkpoint, savedFallback]),
    ).toEqual([checkpoint, savedFallback]);
  });
});

describe("areMessagesEquivalentForConvexSync", () => {
  it("applies a goal completion receipt after the answer already rendered", () => {
    const current = createAssistantMessage("Done");
    const persisted = {
      ...current,
      metadata: { goal: { achievedElapsedMs: 52000 } },
    };
    expect(areMessagesEquivalentForConvexSync([current], [persisted])).toBe(
      false,
    );
    expect(
      areMessagesEquivalentForConvexSync([persisted], [{ ...persisted }]),
    ).toBe(true);
  });
  it("detects completed text when the message ID and part count are unchanged", () => {
    const current = [createAssistantMessage("The latest")];
    const persisted = [
      createAssistantMessage(
        "The latest release includes the complete researched answer.",
      ),
    ];

    expect(areMessagesEquivalentForConvexSync(current, persisted)).toBe(false);
  });

  it("treats structurally identical message parts as equivalent", () => {
    const current = [
      createAssistantMessage("", {
        parts: [
          {
            type: "tool-web_search",
            toolCallId: "tool-1",
            state: "output-available",
            input: { query: "latest release", limit: 5 },
            output: { results: [{ title: "Release notes" }] },
          } as ChatMessage["parts"][number],
        ],
      }),
    ];
    const persisted = [
      createAssistantMessage("", {
        parts: [
          {
            output: { results: [{ title: "Release notes" }] },
            input: { limit: 5, query: "latest release" },
            state: "output-available",
            toolCallId: "tool-1",
            type: "tool-web_search",
          } as ChatMessage["parts"][number],
        ],
      }),
    ];

    expect(areMessagesEquivalentForConvexSync(current, persisted)).toBe(true);
  });

  it("detects tool state changes without a new part", () => {
    const current = [
      createAssistantMessage("", {
        parts: [
          {
            type: "tool-web_search",
            toolCallId: "tool-1",
            state: "input-available",
            input: { query: "latest release" },
          } as ChatMessage["parts"][number],
        ],
      }),
    ];
    const persisted = [
      createAssistantMessage("", {
        parts: [
          {
            type: "tool-web_search",
            toolCallId: "tool-1",
            state: "output-available",
            input: { query: "latest release" },
            output: { results: [] },
          } as ChatMessage["parts"][number],
        ],
      }),
    ];

    expect(areMessagesEquivalentForConvexSync(current, persisted)).toBe(false);
  });
});

describe("arePersistedMessagesAtLeastAsComplete", () => {
  it("accepts completed persisted text that extends the local partial text", () => {
    const current = [createAssistantMessage("The latest")];
    const persisted = [
      createAssistantMessage(
        "The latest release includes the complete researched answer.",
      ),
    ];

    expect(arePersistedMessagesAtLeastAsComplete(current, persisted)).toBe(
      true,
    );
  });

  it("rejects stale persisted text that would truncate the local answer", () => {
    const current = [
      createAssistantMessage(
        "The latest release includes the complete researched answer.",
      ),
    ];
    const persisted = [createAssistantMessage("The latest")];

    expect(arePersistedMessagesAtLeastAsComplete(current, persisted)).toBe(
      false,
    );
  });

  it("accepts a persisted text part transitioning from streaming to done", () => {
    const current = [
      createAssistantMessage("", {
        parts: [
          {
            type: "text",
            text: "The latest",
            state: "streaming",
          } as ChatMessage["parts"][number],
        ],
      }),
    ];
    const persisted = [
      createAssistantMessage("", {
        parts: [
          {
            type: "text",
            text: "The latest",
            state: "done",
          } as ChatMessage["parts"][number],
        ],
      }),
    ];

    expect(arePersistedMessagesAtLeastAsComplete(current, persisted)).toBe(
      true,
    );
  });

  it("rejects persisted tool state that regresses local progress", () => {
    const current = [
      createAssistantMessage("", {
        parts: [
          {
            type: "tool-web_search",
            toolCallId: "tool-1",
            state: "output-available",
            input: { query: "latest release" },
            output: { results: [] },
          } as ChatMessage["parts"][number],
        ],
      }),
    ];
    const persisted = [
      createAssistantMessage("", {
        parts: [
          {
            type: "tool-web_search",
            toolCallId: "tool-1",
            state: "input-available",
            input: { query: "latest release" },
          } as ChatMessage["parts"][number],
        ],
      }),
    ];

    expect(arePersistedMessagesAtLeastAsComplete(current, persisted)).toBe(
      false,
    );
  });

  it("rejects a persisted tool part from a different tool call", () => {
    const current = [
      createAssistantMessage("", {
        parts: [
          {
            type: "tool-web_search",
            toolCallId: "tool-1",
            state: "input-available",
            input: { query: "latest release" },
          } as ChatMessage["parts"][number],
        ],
      }),
    ];
    const persisted = [
      createAssistantMessage("", {
        parts: [
          {
            type: "tool-web_search",
            toolCallId: "tool-2",
            state: "output-available",
            input: { query: "different release" },
            output: { results: [] },
          } as ChatMessage["parts"][number],
        ],
      }),
    ];

    expect(arePersistedMessagesAtLeastAsComplete(current, persisted)).toBe(
      false,
    );
  });
});

it("shows a saved continuation and receipt without regressing earlier streamed text", () => {
  const local = createAssistantMessage("Full first response", {
    metadata: { mode: "agent" },
  });
  const saved = createAssistantMessage("Full first", {
    metadata: { goal: { achievedElapsedMs: 52000 } },
  });
  const continuation = createAssistantMessage("Second work slice", {
    id: "assistant-2",
  });
  const merged = mergePersistedGoalMessages([local], [saved, continuation]);
  expect(merged).toHaveLength(2);
  expect(merged[0].parts).toEqual(local.parts);
  expect(merged[0].metadata).toMatchObject({
    mode: "agent",
    goal: { achievedElapsedMs: 52000 },
  });
  expect(merged[1]).toEqual(continuation);
});

it("places delayed saved continuations before later local user turns", () => {
  const local = createAssistantMessage("Full first response");
  const saved = createAssistantMessage("Full first");
  const user = createAssistantMessage("A later user turn", {
    id: "user-2",
    role: "user",
  });
  const continuation = createAssistantMessage("Second work slice", {
    id: "assistant-2",
  });
  const merged = mergePersistedGoalMessages(
    [local, user],
    [saved, continuation, user],
  );
  expect(merged).toEqual([local, continuation, user]);
});
