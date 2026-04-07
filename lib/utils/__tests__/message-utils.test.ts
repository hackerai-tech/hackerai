import { describe, it, expect } from "@jest/globals";
import {
  getAutoContinueChainAssistantIds,
  getMessagesUpToLastRealUser,
} from "../message-utils";

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
