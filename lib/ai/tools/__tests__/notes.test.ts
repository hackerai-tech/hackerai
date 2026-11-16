import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { asSchema, convertToModelMessages, type UIMessage } from "ai";

import type { ToolContext } from "@/types";

jest.mock("@/lib/db/actions", () => ({
  createNote: jest.fn(),
  listNotes: jest.fn(),
  listNoteSummaries: jest.fn(),
  getNoteContent: jest.fn(),
  updateNote: jest.fn(),
  deleteNote: jest.fn(),
}));
const mockEvent = jest.fn();
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: (...args: unknown[]) => mockEvent(...args) },
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
  encodeNoteCursor,
  NOTE_TOOL_RESPONSE_TOKENS,
} = require("../notes") as typeof import("../notes");
const { listNotesToolInputSchema } =
  require("../schemas") as typeof import("../schemas");
const { safeCountTokens } =
  require("@/lib/token-utils") as typeof import("@/lib/token-utils");
const { safeCutIndex } =
  require("@/lib/notes/policy") as typeof import("@/lib/notes/policy");
const { createPromptSerializationTools } =
  require("../prompt-serialization") as typeof import("../prompt-serialization");
const { pruneToolOutputs } =
  require("@/lib/chat/compaction/prune-tool-outputs") as typeof import("@/lib/chat/compaction/prune-tool-outputs");

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
            content_revision: "0123456789abcdef",
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
    // Every continuation was bound to the note and the revision it started from.
    for (const [args] of mockGetNoteContent.mock.calls.slice(1))
      expect(args).toMatchObject({
        userId: "user-1",
        noteId: "big",
        revision: "0123456789abcdef",
      });
  });

  it("rejects stale, foreign and legacy continuation cursors with restart guidance", async () => {
    const tool = createGetNote(context);
    const cursor = encodeNoteCursor("abc12", "0123456789abcdef", 40);
    mockGetNoteContent.mockResolvedValue({
      success: false,
      error:
        "Note 'abc12' changed since the previous page. Restart get_note without a cursor to read the current version.",
    });
    expect(await runTool(tool, { note_id: "abc12", cursor })).toEqual({
      success: false,
      error: expect.stringContaining("Restart get_note without a cursor"),
    });
    expect(mockGetNoteContent).toHaveBeenLastCalledWith({
      userId: "user-1",
      noteId: "abc12",
      offset: 40,
      revision: "0123456789abcdef",
    });

    mockGetNoteContent.mockClear();
    for (const bad of [cursor.replace("abc12", "other"), "4000", "n2:abc12"]) {
      const result = (await runTool(tool, {
        note_id: "abc12",
        cursor: bad,
      })) as {
        success: boolean;
        error: string;
      };
      expect(result.success).toBe(false);
      expect(result.error).toContain("Restart get_note without a cursor");
    }
    expect(mockGetNoteContent).not.toHaveBeenCalled();
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
    const tool = createGetNote(context);
    const result = await runTool(tool, { note_id: "x" });
    expect(result).toEqual({
      success: false,
      error: "Note 'x' not found",
    });
    expect(modelText(tool, result)).toBe("Error: Note 'x' not found");
  });

  it("serializes a pruned get_note result from saved history without reading the note", async () => {
    const content = "synthetic note evidence ".repeat(40);
    mockGetNoteContent.mockResolvedValue({
      success: true,
      note: {
        note_id: "note-1",
        title: "Recon",
        category: "findings",
        tags: [],
        updated_at: 1,
        content,
        content_offset: 0,
        content_length: content.length,
        content_revision: "0123456789abcdef",
      },
    });
    const liveTool = createGetNote(context);
    const output = await runTool(liveTool, { note_id: "note-1" });
    const history = [
      { id: "user", role: "user", parts: [{ type: "text", text: "Recall" }] },
      {
        id: "assistant",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-get_note",
            toolCallId: "call-1",
            state: "output-available",
            input: { note_id: "note-1" },
            output,
          },
        ],
      },
    ] as UIMessage[];

    // get_note is not a protected tool, so pruning replaces its output with
    // the app's text placeholder, which is then saved as chat history.
    const pruned = pruneToolOutputs(history, 0, 0);
    const placeholder = (
      pruned.messages[1].parts[1] as unknown as { output: unknown }
    ).output;
    expect(placeholder).toBe("[Tool: get_note completed]");
    const saved = JSON.parse(JSON.stringify(pruned.messages)) as UIMessage[];

    mockGetNoteContent.mockClear();
    mockEvent.mockClear();
    const onFormatterFailure = jest.fn();
    const modelMessages = await convertToModelMessages(saved, {
      tools: createPromptSerializationTools(
        { get_note: createGetNote(context) },
        { onFormatterFailure },
      ),
    });

    expect(modelMessages.at(-1)).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "get_note",
          output: { type: "text", value: placeholder },
        },
      ],
    });
    expect(onFormatterFailure).not.toHaveBeenCalled();
    expect(mockGetNoteContent).not.toHaveBeenCalled();
    // Replaying history is not a read.
    expect(mockEvent).not.toHaveBeenCalled();
  });

  it("bounds historical get_note text to the response cap at a safe character", () => {
    const tool = createGetNote(context);
    const short = "[Tool: get_note completed] 漏洞🔐";
    expect(modelText(tool, short)).toBe(short);

    const long = Array.from(
      { length: 6_000 },
      (_, i) => `${i} 漏洞🔐 payload-${i}`,
    ).join("\n");
    const text = modelText(tool, long);
    expect(safeCountTokens(text)).toBeLessThanOrEqual(
      NOTE_TOOL_RESPONSE_TOKENS,
    );
    expect(text.endsWith("…")).toBe(true);
    const kept = text.slice(0, -1);
    expect(kept.length).toBeGreaterThan(1_000);
    expect(long.startsWith(kept)).toBe(true);
    // No lone surrogate halves from cutting inside an emoji.
    expect(kept).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });
});

describe("get_note read telemetry", () => {
  const revision = "0123456789abcdef";
  const page = (content: string, offset = 0, length = content.length) => ({
    success: true,
    note: {
      note_id: "SECRET-ID",
      title: "SECRET-TITLE",
      category: "findings",
      tags: ["SECRET-TAG"],
      target: "secret.example",
      updated_at: 1,
      content,
      content_offset: offset,
      content_length: length,
      content_revision: revision,
    },
  });
  /** Properties of each notes_read_result, without the stable attribution. */
  const reads = () =>
    mockEvent.mock.calls.map(([name, properties]) => {
      expect(name).toBe("notes_read_result");
      const { userId, feature_flag, duration_ms, ...rest } = properties as {
        [key: string]: unknown;
      };
      expect([userId, feature_flag]).toEqual([
        "user-1",
        "notes_relevant_recall_v1",
      ]);
      expect(Number.isInteger(duration_ms)).toBe(true);
      return rest;
    });

  let random: jest.SpiedFunction<typeof Math.random>;

  beforeEach(() => {
    mockGetNoteContent.mockReset();
    mockEvent.mockReset();
    // Keep every sampled successful read so recorded reads are deterministic.
    random = jest.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    random.mockRestore();
  });

  it("records each executed read, its continuation and whether more remains", async () => {
    const tool = createGetNote(context);
    mockGetNoteContent.mockResolvedValueOnce(page("SECRET-BODY"));
    await runTool(tool, { note_id: "SECRET-ID" });
    // A later page of a longer note, read through its continuation cursor.
    mockGetNoteContent.mockResolvedValueOnce(
      page("x".repeat(40_000), 40, 80_000),
    );
    const cursor = encodeNoteCursor("SECRET-ID", revision, 40);
    const result = (await runTool(tool, { note_id: "SECRET-ID", cursor })) as {
      note: { next_cursor?: string };
    };
    expect(result.note.next_cursor).toBeDefined();

    expect(reads()).toEqual([
      {
        outcome: "success",
        continuation: false,
        has_more: false,
        sample_rate: 0.05,
      },
      {
        outcome: "success",
        continuation: true,
        has_more: true,
        sample_rate: 0.05,
      },
    ]);
    // Rendering the output for the model is not another read.
    modelText(tool, result);
    expect(mockEvent).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mockEvent.mock.calls)).not.toMatch(/SECRET|n2:|xxxx/);
  });

  it("records failed and retried cursor reads without cursors or error text", async () => {
    const tool = createGetNote(context);
    const stale = encodeNoteCursor("SECRET-ID", revision, 40);
    mockGetNoteContent.mockResolvedValueOnce({
      success: false,
      error:
        "Note 'SECRET-ID' changed since the previous page. Restart get_note without a cursor to read the current version.",
    });
    await runTool(tool, { note_id: "SECRET-ID", cursor: stale });
    // A malformed cursor fails before any lookup.
    await runTool(tool, { note_id: "SECRET-ID", cursor: "n2:SECRET" });
    mockGetNoteContent.mockRejectedValueOnce(new Error("SECRET-ERROR"));
    await runTool(tool, { note_id: "SECRET-ID" });
    // The model restarts without a cursor, as the error instructs.
    mockGetNoteContent.mockResolvedValueOnce(page("SECRET-BODY"));
    await runTool(tool, { note_id: "SECRET-ID", cursor: null });

    expect(mockGetNoteContent).toHaveBeenCalledTimes(3);
    expect(reads()).toEqual([
      { outcome: "error", continuation: true, sample_rate: 1 },
      { outcome: "error", continuation: true, sample_rate: 1 },
      { outcome: "error", continuation: false, sample_rate: 1 },
      {
        outcome: "success",
        continuation: false,
        has_more: false,
        sample_rate: 0.05,
      },
    ]);
    expect(JSON.stringify(mockEvent.mock.calls)).not.toMatch(
      /SECRET|n2:|Restart/,
    );
  });

  it("returns the same read result when telemetry throws", async () => {
    mockEvent.mockImplementation(() => {
      throw new Error("analytics down");
    });
    const tool = createGetNote(context);
    mockGetNoteContent.mockResolvedValueOnce(page("body"));
    expect(await runTool(tool, { note_id: "SECRET-ID" })).toEqual({
      success: true,
      note: page("body").note,
    });
    mockGetNoteContent.mockResolvedValueOnce({
      success: false,
      error: "Note 'x' not found",
    });
    expect(await runTool(tool, { note_id: "x" })).toEqual({
      success: false,
      error: "Note 'x' not found",
    });
    expect(mockEvent).toHaveBeenCalledTimes(2);

    // A failing sampler is also swallowed.
    random.mockImplementation(() => {
      throw new Error("rng down");
    });
    mockGetNoteContent.mockResolvedValueOnce(page("body"));
    expect(await runTool(tool, { note_id: "SECRET-ID" })).toEqual({
      success: true,
      note: page("body").note,
    });
  });

  it("samples out successful reads but always records failed ones", async () => {
    random.mockReturnValue(0.999);
    const tool = createGetNote(context);
    mockGetNoteContent.mockResolvedValueOnce(page("body"));
    await runTool(tool, { note_id: "SECRET-ID" });
    expect(mockEvent).not.toHaveBeenCalled();
    mockGetNoteContent.mockRejectedValueOnce(new Error("down"));
    await runTool(tool, { note_id: "SECRET-ID" });
    expect(reads()).toEqual([
      { outcome: "error", continuation: false, sample_rate: 1 },
    ]);
  });
});
