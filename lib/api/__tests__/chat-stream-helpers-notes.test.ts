/**
 * Tests for notes injection and refresh helpers in chat-stream-helpers.
 *
 * Covers:
 * - replaceNotesBlock (pure string replacement)
 * - refreshNotesInModelMessages (preserves conversation history)
 */

import {
  replaceNotesBlock,
  refreshNotesInModelMessages,
} from "@/lib/api/chat-stream-helpers";

// ── Mock external dependencies used by refreshNotesInModelMessages ──────────

const mockGetNotes = jest.fn();
jest.mock("@/lib/db/actions", () => ({
  getNotes: (...args: unknown[]) => mockGetNotes(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a notes block exactly as generateNotesSection + appendSystemReminderToLastUserMessage produce. */
function buildNotesReminder(noteTitle: string): string {
  return (
    `<system-reminder>\n` +
    `<notes>\n` +
    `These are the user's general notes for context. Use them to provide more personalized assistance.\n\n` +
    `<user_notes>\n` +
    `- [2024-01-15] **${noteTitle}** [general]: some content (ID: note_1)\n` +
    `</user_notes>\n` +
    `</notes>\n` +
    `</system-reminder>`
  );
}

const RESUME_REMINDER =
  "<system-reminder>\n<resume_context>Your previous response was interrupted.</resume_context>\n</system-reminder>";

// ── replaceNotesBlock ───────────────────────────────────────────────────────

describe("replaceNotesBlock", () => {
  const oldNotes = buildNotesReminder("Old Note");
  const newNotesContent =
    "<notes>\nThese are the user's general notes for context. Use them to provide more personalized assistance.\n\n<user_notes>\n- [2024-01-16] **New Note** [general]: updated content (ID: note_2)\n</user_notes>\n</notes>";

  it("replaces an existing notes block with new content", () => {
    const text = `Hello world\n\n${oldNotes}`;
    const result = replaceNotesBlock(text, newNotesContent);

    expect(result).toContain("New Note");
    expect(result).not.toContain("Old Note");
    expect(result).toContain("<system-reminder>");
    expect(result).toContain("</system-reminder>");
  });

  it("removes the notes block when new content is empty", () => {
    const text = `Hello world\n\n${oldNotes}`;
    const result = replaceNotesBlock(text, "");

    expect(result).not.toContain("<notes>");
    expect(result).not.toContain("Old Note");
    // The surrounding user text is preserved
    expect(result).toContain("Hello world");
  });

  it("returns text unchanged when no notes block exists", () => {
    const text = "Hello world\n\nsome other content";
    const result = replaceNotesBlock(text, newNotesContent);

    expect(result).toBe(text);
  });

  it("preserves other system-reminder blocks (e.g. resume context)", () => {
    const text = `Hello world\n\n${RESUME_REMINDER}\n\n${oldNotes}`;
    const result = replaceNotesBlock(text, newNotesContent);

    expect(result).toContain("<resume_context>");
    expect(result).toContain("New Note");
    expect(result).not.toContain("Old Note");
  });

  it("handles notes with special characters and multiple lines", () => {
    const specialNotes =
      `<system-reminder>\n<notes>\nThese are the user's general notes for context. Use them to provide more personalized assistance.\n\n<user_notes>\n` +
      `- [2024-01-15] **Note with "quotes" & <angles>** [tag1, tag2]: content with $pecial chars (ID: note_1)\n` +
      `- [2024-01-16] **Second Note** [general]: more content (ID: note_2)\n` +
      `</user_notes>\n</notes>\n</system-reminder>`;

    const text = `User message\n\n${specialNotes}`;
    const result = replaceNotesBlock(text, newNotesContent);

    expect(result).toContain("New Note");
    expect(result).not.toContain("$pecial chars");
  });

  it("tolerates extra whitespace around tags", () => {
    // Simulate slightly different formatting (extra spaces/newlines)
    const looseNotes = `<system-reminder>  \n<notes>\nold content\n</notes>  \n</system-reminder>`;
    const text = `User message\n\n${looseNotes}`;
    const result = replaceNotesBlock(text, newNotesContent);

    expect(result).toContain("New Note");
    expect(result).not.toContain("old content");
  });
});

// ── refreshNotesInModelMessages ─────────────────────────────────────────────

describe("refreshNotesInModelMessages", () => {
  const baseOpts = {
    userId: "user_1",
    subscription: "pro" as const,
    shouldIncludeNotes: true,
    isTemporary: false,
  };

  const oldNotesBlock = buildNotesReminder("Old Note");

  // Simulate the CoreMessage[] that prepareStep receives
  function buildConversationMessages(userTextContent: string) {
    return [
      {
        role: "user",
        content: [{ type: "text", text: userTextContent }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Sure, I'll create that note for you." },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "create_note",
            args: { title: "New Note", content: "new content" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "create_note",
            result: { success: true, note_id: "note_2" },
          },
        ],
      },
    ];
  }

  beforeEach(() => {
    mockGetNotes.mockResolvedValue([
      {
        note_id: "note_2",
        title: "New Note",
        content: "new content",
        category: "general",
        tags: ["general"],
        updated_at: 1705449600000,
      },
    ]);
  });

  it("updates notes while preserving assistant and tool messages", async () => {
    const userText = `Save a note please\n\n${oldNotesBlock}`;
    const messages = buildConversationMessages(userText);

    const result = await refreshNotesInModelMessages(messages, baseOpts);

    // All three messages are still present
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("tool");

    // Assistant message is untouched
    const assistantContent = result[1].content as Array<
      Record<string, unknown>
    >;
    expect(assistantContent).toHaveLength(2);
    expect(assistantContent[0]).toEqual({
      type: "text",
      text: "Sure, I'll create that note for you.",
    });
    expect(assistantContent[1]).toMatchObject({
      type: "tool-call",
      toolName: "create_note",
    });

    // Tool result message is untouched
    const toolContent = result[2].content as Array<Record<string, unknown>>;
    expect(toolContent[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call_1",
    });

    // User message has updated notes
    const userContent = result[0].content as Array<Record<string, unknown>>;
    const userTextPart = userContent[0].text as string;
    expect(userTextPart).toContain("New Note");
    expect(userTextPart).not.toContain("Old Note");
    expect(userTextPart).toContain("Save a note please");
  });

  it("handles user message with string content (not array)", async () => {
    const userText = `Save a note please\n\n${oldNotesBlock}`;
    const messages = [
      { role: "user", content: userText },
      { role: "assistant", content: "Done!" },
    ];

    const result = await refreshNotesInModelMessages(messages, baseOpts);

    expect(result).toHaveLength(2);
    const updated = result[0].content as string;
    expect(updated).toContain("New Note");
    expect(updated).not.toContain("Old Note");
    // Assistant untouched
    expect(result[1].content).toBe("Done!");
  });

  it("returns messages unchanged when shouldIncludeNotes is false", async () => {
    const messages = buildConversationMessages(`text\n\n${oldNotesBlock}`);
    const result = await refreshNotesInModelMessages(messages, {
      ...baseOpts,
      shouldIncludeNotes: false,
    });

    expect(result).toBe(messages); // same reference, not modified
    expect(mockGetNotes).not.toHaveBeenCalled();
  });

  it("returns messages unchanged when isTemporary is true", async () => {
    const messages = buildConversationMessages(`text\n\n${oldNotesBlock}`);
    const result = await refreshNotesInModelMessages(messages, {
      ...baseOpts,
      isTemporary: true,
    });

    expect(result).toBe(messages);
    expect(mockGetNotes).not.toHaveBeenCalled();
  });

  it("returns messages unchanged when no notes block exists", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "just a message" }] },
      { role: "assistant", content: [{ type: "text", text: "response" }] },
    ];

    const result = await refreshNotesInModelMessages(messages, baseOpts);

    // Returns original reference since nothing was replaced
    expect(result).toBe(messages);
  });

  it("does not mutate the original messages array", async () => {
    const userText = `text\n\n${oldNotesBlock}`;
    const messages = buildConversationMessages(userText);
    const originalFirstMsg = { ...messages[0] };

    await refreshNotesInModelMessages(messages, baseOpts);

    // Original array and first message object should be unchanged
    expect(messages[0]).toEqual(originalFirstMsg);
  });

  it("preserves resume context system-reminder alongside notes", async () => {
    const userText = `Hello\n\n${RESUME_REMINDER}\n\n${oldNotesBlock}`;
    const messages = buildConversationMessages(userText);

    const result = await refreshNotesInModelMessages(messages, baseOpts);

    const userContent = result[0].content as Array<Record<string, unknown>>;
    const text = userContent[0].text as string;
    expect(text).toContain("<resume_context>");
    expect(text).toContain("New Note");
    expect(text).not.toContain("Old Note");
  });
});
