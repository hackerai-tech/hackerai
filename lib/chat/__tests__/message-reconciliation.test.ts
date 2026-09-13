import {
  areMessagesEquivalentForConvexSync,
  arePersistedMessagesAtLeastAsComplete,
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

describe("areMessagesEquivalentForConvexSync", () => {
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
