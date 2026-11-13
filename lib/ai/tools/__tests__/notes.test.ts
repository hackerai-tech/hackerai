import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { asSchema } from "ai";

import type { ToolContext } from "@/types";

jest.mock("@/lib/db/actions", () => ({
  createNote: jest.fn(),
  listNotes: jest.fn(),
  listNoteSummaries: jest.fn(),
  getNoteContent: jest.fn(),
  updateNote: jest.fn(),
  deleteNote: jest.fn(),
}));

const {
  createNote: mockCreateNote,
  listNotes: mockListNotes,
  getNoteContent: mockGetNoteContent,
  updateNote: mockUpdateNote,
} = jest.requireMock<{
  createNote: jest.Mock;
  listNotes: jest.Mock;
  getNoteContent: jest.Mock<any>;
  updateNote: jest.Mock;
}>("@/lib/db/actions");
const {
  createCreateNote,
  createGetNote,
  createListNotes,
  createUpdateNote,
  NOTE_TOOL_RESPONSE_TOKENS,
} = require("../notes") as typeof import("../notes");
const { listNotesToolInputSchema } =
  require("../schemas") as typeof import("../schemas");
const { safeCountTokens } =
  require("@/lib/token-utils") as typeof import("@/lib/token-utils");
const { safeCutIndex } =
  require("@/lib/notes/policy") as typeof import("@/lib/notes/policy");

const context = { userID: "user-1", chatId: "chat-1" } as ToolContext;

/** The exact text the model receives for a tool result. */
function modelText(tool: unknown, output: unknown): string {
  return (
    tool as {
      toModelOutput: (options: { output: unknown }) => { value: string };
    }
  ).toModelOutput({ output }).value;
}

async function runTool(tool: unknown, input: Record<string, unknown>) {
  const execute = (
    tool as unknown as {
      execute: (value: unknown, options: unknown) => Promise<unknown>;
    }
  ).execute;

  return await execute(input, {
    toolCallId: "call-1",
    abortSignal: undefined,
    messages: [],
  });
}

describe("note tools", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateNote.mockResolvedValue({ success: true, note_id: "note-1" });
    mockListNotes.mockResolvedValue({
      success: true,
      notes: [],
      total_count: 0,
    });
    mockUpdateNote.mockResolvedValue({
      success: true,
      original: { title: "Original" },
      modified: { title: "Updated" },
    });
  });

  it("normalizes nullish list filters while preserving free-form tags", async () => {
    const parsedInput = listNotesToolInputSchema.parse({
      category: " NONE ",
      search: " Undefined ",
      tags: ["none", "null", "nil", "undefined"],
    });
    expect(parsedInput.category).toBe("none");

    await runTool(createListNotes(context), parsedInput);

    expect(mockListNotes).toHaveBeenCalledWith({
      userId: "user-1",
      category: undefined,
      search: undefined,
      tags: ["none", "null", "nil", "undefined"],
    });
  });

  it("serializes the normalized list schema for model tool calls", () => {
    expect(asSchema(listNotesToolInputSchema).jsonSchema).toMatchObject({
      type: "object",
      properties: {
        category: expect.any(Object),
      },
    });
  });

  it("treats explicit null list filters as omitted", async () => {
    await runTool(createListNotes(context), {
      category: null,
      search: null,
    });

    expect(mockListNotes).toHaveBeenCalledWith({
      userId: "user-1",
      category: undefined,
      search: undefined,
      tags: undefined,
    });
  });

  it("preserves ordinary list filters", async () => {
    await runTool(createListNotes(context), {
      category: "findings",
      search: "none found in authorization flow",
      tags: ["auth"],
    });

    expect(mockListNotes).toHaveBeenCalledWith({
      userId: "user-1",
      category: "findings",
      search: "none found in authorization flow",
      tags: ["auth"],
    });
  });

  it("preserves literal values in note write tools", async () => {
    const tags = ["none", "null", "nil", "undefined"];

    await runTool(createCreateNote(context), {
      title: "none",
      content: "null",
      category: "general",
      tags,
    });
    await runTool(createUpdateNote(context), {
      note_id: "note-1",
      title: "undefined",
      content: "nil",
      tags,
    });

    expect(mockCreateNote).toHaveBeenCalledWith({
      userId: "user-1",
      title: "none",
      content: "null",
      category: "general",
      tags,
    });
    expect(mockUpdateNote).toHaveBeenCalledWith({
      userId: "user-1",
      noteId: "note-1",
      title: "undefined",
      content: "nil",
      tags,
    });
  });
});

describe("relevant-recall note tools", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateNote.mockResolvedValue({ success: true, note_id: "note-1" });
    mockUpdateNote.mockResolvedValue({
      success: true,
      modified: { title: "T" },
    });
  });

  it("scopes new notes to the server chat and records a supplied observation", async () => {
    await runTool(createCreateNote(context, true), {
      title: "IDOR",
      content: "x",
      category: "findings",
      target: "alpha.example",
      observed_at: "2026-11-03",
    });
    expect(mockCreateNote).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        chatId: "chat-1",
        target: "alpha.example",
        observedAt: Date.UTC(2026, 10, 3),
      }),
    );
  });

  it("rejects a future observation without writing", async () => {
    const result = await runTool(createCreateNote(context, true), {
      title: "IDOR",
      content: "x",
      observed_at: "2999-01-01",
    });
    expect(result).toMatchObject({ success: false });
    expect(mockCreateNote).not.toHaveBeenCalled();
  });

  it("does not advance the observation date on a plain edit", async () => {
    await runTool(createUpdateNote(context, true), {
      note_id: "note-1",
      content: "edited",
    });
    expect(mockUpdateNote.mock.calls[0][0]).toMatchObject({
      noteId: "note-1",
      content: "edited",
      observedAt: undefined,
    });
  });

  it("reads a large Unicode note in capped responses with no loss or overlap", async () => {
    const content = Array.from(
      { length: 6_000 },
      (_, i) => `${i} 漏洞🔐 payload-${i}`,
    ).join("\n");
    // Mirrors the Convex page read: a bounded, surrogate-safe character slice
    // with metadata already bounded (200-char title, 12 x 64-char tags).
    mockGetNoteContent.mockImplementation(
      async ({ offset = 0 }: { offset?: number }) => {
        const start = safeCutIndex(content, offset);
        const end = safeCutIndex(content, start + 24_000);
        return {
          success: true,
          note: {
            note_id: "big",
            title: "題🔐".repeat(66),
            category: "findings",
            tags: Array.from({ length: 12 }, () => "漏洞🔐".repeat(21)),
            target: "alpha.example",
            updated_at: 1,
            content: content.slice(start, end),
            content_offset: start,
            content_length: content.length,
          },
        };
      },
    );
    const tool = createGetNote(context);
    let cursor: string | undefined;
    let rebuilt = "";
    let pages = 0;
    do {
      const result = (await runTool(tool, { note_id: "big", cursor })) as {
        note: { content: string; next_cursor?: string };
      };
      // The whole model-facing response, header and cursor footer included.
      const text = modelText(tool, result);
      expect(safeCountTokens(text)).toBeLessThanOrEqual(
        NOTE_TOOL_RESPONSE_TOKENS,
      );
      if (result.note.next_cursor)
        expect(text).toContain(`cursor "${result.note.next_cursor}"`);
      rebuilt += result.note.content;
      cursor = result.note.next_cursor;
      pages++;
    } while (cursor && pages < 100);
    expect(pages).toBeGreaterThan(1);
    expect(rebuilt).toBe(content);
  });

  it("caps a list page of pathological legacy metadata without losing IDs or the cursor", () => {
    const notes = Array.from({ length: 50 }, (_, i) => ({
      note_id: `id${i}`,
      title: "題🔐".repeat(66),
      category: "findings",
      tags: Array.from({ length: 12 }, () => "漏洞🔐".repeat(21)),
      target: "alpha.example",
      updated_at: 1,
      preview: "🔐payload漏洞".repeat(28),
      preview_truncated: true,
    }));
    const cursor = "opaque-cursor-".repeat(10);
    const text = modelText(createListNotes(context, true), {
      success: true,
      notes,
      has_more: true,
      next_cursor: cursor,
    });
    expect(safeCountTokens(text)).toBeLessThanOrEqual(
      NOTE_TOOL_RESPONSE_TOKENS,
    );
    for (const note of notes) expect(text).toContain(`- [${note.note_id}] `);
    expect(text).toContain(`cursor "${cursor}"`);
  });

  it("reports a missing or foreign note as a failure", async () => {
    mockGetNoteContent.mockResolvedValue({
      success: false,
      error: "Note 'x' not found",
    });
    expect(await runTool(createGetNote(context), { note_id: "x" })).toEqual({
      success: false,
      error: "Note 'x' not found",
    });
  });
});
