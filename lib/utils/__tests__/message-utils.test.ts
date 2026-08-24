import { describe, it, expect } from "@jest/globals";
import {
  findLastUserMessageIndex,
  getAutoContinueChainAssistantIds,
  getMessagesUpToLastRealUser,
  joinContinuationText,
  mergeAskContinuationMessages,
} from "../message-utils";
import type { ChatMessage } from "@/types";

const msg = (
  id: string,
  role: "user" | "assistant" | "system",
  isAutoContinue?: boolean,
) => ({
  id,
  role,
  metadata: isAutoContinue ? { isAutoContinue: true } : undefined,
  parts: [
    { type: "text" as const, text: role === "user" ? "test" : "response" },
  ],
});

describe("message-utils", () => {
  describe("joinContinuationText", () => {
    it("continues an open code fence as one downloadable code block", () => {
      expect(
        joinContinuationText(
          "```ts\nconst first = 1;\n",
          "const second = 2;\n```",
        ),
      ).toBe("```ts\nconst first = 1;\nconst second = 2;\n```");
    });

    it("removes a redundant opening fence from an in-progress code block", () => {
      expect(
        joinContinuationText(
          "```python\nprint('first')\n",
          "```python\nprint('second')\n```",
        ),
      ).toBe("```python\nprint('first')\nprint('second')\n```");
    });

    it("deduplicates a substantial exact overlap", () => {
      expect(
        joinContinuationText(
          "The generated value is abcdefghijklmnopqrstuvwxyz",
          "abcdefghijklmnopqrstuvwxyz\nand then it finishes.",
        ),
      ).toBe(
        "The generated value is abcdefghijklmnopqrstuvwxyz\nand then it finishes.",
      );
    });
  });

  describe("mergeAskContinuationMessages", () => {
    const askMessage = (
      id: string,
      role: "user" | "assistant",
      text: string,
      isAutoContinue = false,
    ) =>
      ({
        id,
        role,
        parts: [{ type: "text", text }],
        metadata: {
          mode: "ask",
          ...(isAutoContinue ? { isAutoContinue: true } : {}),
        },
      }) as ChatMessage;

    it("renders a live Ask continuation as one assistant response", () => {
      const visible = mergeAskContinuationMessages([
        askMessage("user-1", "user", "Write code"),
        askMessage("assistant-1", "assistant", "```ts\nconst a = 1;\n"),
        askMessage("continue-1", "user", "Continue", true),
        askMessage("assistant-2", "assistant", "const b = 2;\n```"),
      ]);

      expect(visible).toHaveLength(2);
      expect(visible[1]).toMatchObject({
        id: "assistant-2",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "```ts\nconst a = 1;\nconst b = 2;\n```",
          },
        ],
      });
    });

    it("merges restored consecutive Ask assistant segments", () => {
      const visible = mergeAskContinuationMessages([
        askMessage("user-1", "user", "Write code"),
        askMessage("assistant-1", "assistant", "first"),
        askMessage("assistant-2", "assistant", " second"),
      ]);

      expect(visible.map((message) => message.id)).toEqual([
        "user-1",
        "assistant-2",
      ]);
      expect(visible[1].parts).toEqual([
        { type: "text", text: "first second" },
      ]);
    });

    it("does not merge Ask responses separated by a real user message", () => {
      const visible = mergeAskContinuationMessages([
        askMessage("user-1", "user", "First question"),
        askMessage("assistant-1", "assistant", "First answer"),
        askMessage("user-2", "user", "Second question"),
        askMessage("assistant-2", "assistant", "Second answer"),
      ]);

      expect(visible).toHaveLength(4);
    });

    it("leaves Agent continuation messages separate", () => {
      const messages = [
        {
          ...askMessage("assistant-1", "assistant", "first"),
          metadata: { mode: "agent" as const },
        },
        {
          ...askMessage("assistant-2", "assistant", "second"),
          metadata: { mode: "agent" as const },
        },
      ];

      expect(mergeAskContinuationMessages(messages)).toEqual(messages);
    });

    it("places continuation reasoning before the combined final text", () => {
      const first = askMessage(
        "assistant-1",
        "assistant",
        "```ts\nconst a = 1;\n",
      );
      const continuation = {
        ...askMessage("assistant-2", "assistant", "const b = 2;\n```"),
        parts: [
          { type: "reasoning", text: "Continue the function" },
          { type: "text", text: "const b = 2;\n```" },
        ],
      } as ChatMessage;

      expect(
        mergeAskContinuationMessages([first, continuation])[0].parts,
      ).toEqual([
        { type: "reasoning", text: "Continue the function" },
        {
          type: "text",
          text: "```ts\nconst a = 1;\nconst b = 2;\n```",
        },
      ]);
    });
  });

  describe("findLastUserMessageIndex", () => {
    it("returns the latest user-authored message before an assistant response", () => {
      expect(
        findLastUserMessageIndex([
          msg("u1", "user"),
          msg("a1", "assistant"),
          msg("u2", "user"),
          msg("a2", "assistant"),
        ]),
      ).toBe(2);
    });

    it("ignores auto-continue prompts after the latest user message", () => {
      expect(
        findLastUserMessageIndex([
          msg("u1", "user"),
          msg("a1", "assistant"),
          msg("ac1", "user", true),
          msg("a2", "assistant"),
        ]),
      ).toBe(0);
    });

    it("returns undefined when no user-authored message exists", () => {
      expect(
        findLastUserMessageIndex([
          msg("a1", "assistant"),
          msg("sys1", "system"),
        ]),
      ).toBeUndefined();
    });
  });

  describe("getAutoContinueChainAssistantIds", () => {
    it.each([
      {
        name: "simple case: [User, Asst] returns [Asst.id]",
        messages: [msg("u1", "user"), msg("a1", "assistant")],
        expected: ["a1"],
      },
      {
        name: "one auto-continue cycle",
        messages: [
          msg("u1", "user"),
          msg("a1", "assistant"),
          msg("ac1", "user", true),
          msg("a2", "assistant"),
        ],
        expected: ["a2", "a1"],
      },
      {
        name: "two auto-continue cycles",
        messages: [
          msg("u1", "user"),
          msg("a1", "assistant"),
          msg("ac1", "user", true),
          msg("a2", "assistant"),
          msg("ac2", "user", true),
          msg("a3", "assistant"),
        ],
        expected: ["a3", "a2", "a1"],
      },
      {
        name: "multi-turn with auto-continue at end stops at real user",
        messages: [
          msg("u1", "user"),
          msg("a1", "assistant"),
          msg("u2", "user"),
          msg("a2", "assistant"),
          msg("ac1", "user", true),
          msg("a3", "assistant"),
        ],
        expected: ["a3", "a2"],
      },
      {
        name: "DB-loaded: consecutive assistants without AC users",
        messages: [
          msg("u1", "user"),
          msg("a1", "assistant"),
          msg("a2", "assistant"),
          msg("a3", "assistant"),
        ],
        expected: ["a3", "a2", "a1"],
      },
      {
        name: "empty messages",
        messages: [],
        expected: [],
      },
      {
        name: "only user messages",
        messages: [msg("u1", "user")],
        expected: [],
      },
      {
        name: "only assistant messages",
        messages: [msg("a1", "assistant"), msg("a2", "assistant")],
        expected: ["a2", "a1"],
      },
    ])("$name", ({ messages, expected }) => {
      expect(getAutoContinueChainAssistantIds(messages)).toEqual(expected);
    });

    // BUG: system message causes break but does NOT distinguish between
    // assistants before/after the system message. The walk-back from
    // the end collects Asst2 and Asst1, then hits System and breaks.
    // This means Asst1 (which belongs to the turn before the system
    // message) is incorrectly included in the chain.
    it("system message breaks chain (documents known bug: assistants before system are included)", () => {
      const messages = [
        msg("u1", "user"),
        msg("sys1", "system"),
        msg("a1", "assistant"),
        msg("a2", "assistant"),
      ];
      // Current behavior: system breaks the walk-back, so [a2, a1] returned.
      // Both a1 and a2 are included even though they follow a system message
      // not an auto-continue user. This is arguably correct for DB-loaded
      // consecutive assistants but would be a bug if the system message was
      // meant to separate turns.
      expect(getAutoContinueChainAssistantIds(messages)).toEqual(["a2", "a1"]);
    });
  });

  describe("getMessagesUpToLastRealUser", () => {
    it.each([
      {
        name: "simple case: [User, Asst] returns [User]",
        messages: [msg("u1", "user"), msg("a1", "assistant")],
        expected: [msg("u1", "user")],
      },
      {
        name: "one auto-continue: returns up to real user",
        messages: [
          msg("u1", "user"),
          msg("a1", "assistant"),
          msg("ac1", "user", true),
          msg("a2", "assistant"),
        ],
        expected: [msg("u1", "user")],
      },
      {
        name: "two auto-continue: returns up to real user",
        messages: [
          msg("u1", "user"),
          msg("a1", "assistant"),
          msg("ac1", "user", true),
          msg("a2", "assistant"),
          msg("ac2", "user", true),
          msg("a3", "assistant"),
        ],
        expected: [msg("u1", "user")],
      },
      {
        name: "multi-turn with auto-continue: returns up to last real user",
        messages: [
          msg("u1", "user"),
          msg("a1", "assistant"),
          msg("u2", "user"),
          msg("a2", "assistant"),
          msg("ac1", "user", true),
          msg("a3", "assistant"),
        ],
        expected: [
          msg("u1", "user"),
          msg("a1", "assistant"),
          msg("u2", "user"),
        ],
      },
      {
        name: "DB-loaded: consecutive assistants, last real user is first",
        messages: [
          msg("u1", "user"),
          msg("a1", "assistant"),
          msg("a2", "assistant"),
          msg("a3", "assistant"),
        ],
        expected: [msg("u1", "user")],
      },
      {
        name: "empty messages",
        messages: [],
        expected: [],
      },
      {
        name: "only assistants: no real user found",
        messages: [msg("a1", "assistant"), msg("a2", "assistant")],
        expected: [],
      },
      {
        name: "only auto-continue users: no real user found",
        messages: [
          msg("ac1", "user", true),
          msg("a1", "assistant"),
          msg("ac2", "user", true),
          msg("a2", "assistant"),
        ],
        expected: [],
      },
    ])("$name", ({ messages, expected }) => {
      expect(getMessagesUpToLastRealUser(messages)).toEqual(expected);
    });

    it("real user message typed 'continue' manually (no isAutoContinue flag) is found as real user", () => {
      const messages = [
        msg("u1", "user"),
        msg("a1", "assistant"),
        {
          id: "u2",
          role: "user" as const,
          metadata: undefined,
          parts: [{ type: "text" as const, text: "continue" }],
        },
        msg("a2", "assistant"),
      ];
      // u2 has no isAutoContinue flag so it should be treated as a real user
      expect(getMessagesUpToLastRealUser(messages)).toEqual([
        msg("u1", "user"),
        msg("a1", "assistant"),
        {
          id: "u2",
          role: "user",
          metadata: undefined,
          parts: [{ type: "text" as const, text: "continue" }],
        },
      ]);
    });
  });
});
