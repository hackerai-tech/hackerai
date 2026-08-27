import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { asSchema } from "ai";

import type { ToolContext } from "@/types";

jest.mock("@/lib/db/actions", () => ({
  createNote: jest.fn(),
  listNotes: jest.fn(),
  updateNote: jest.fn(),
  deleteNote: jest.fn(),
}));

const {
  createNote: mockCreateNote,
  listNotes: mockListNotes,
  updateNote: mockUpdateNote,
} = jest.requireMock<{
  createNote: jest.Mock;
  listNotes: jest.Mock;
  updateNote: jest.Mock;
}>("@/lib/db/actions");
const { createCreateNote, createListNotes, createUpdateNote } =
  require("../notes") as typeof import("../notes");
const { listNotesToolInputSchema } =
  require("../schemas") as typeof import("../schemas");

const context = { userID: "user-1" } as ToolContext;

async function runTool(
  tool:
    | ReturnType<typeof createCreateNote>
    | ReturnType<typeof createListNotes>
    | ReturnType<typeof createUpdateNote>,
  input: Record<string, unknown>,
) {
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
