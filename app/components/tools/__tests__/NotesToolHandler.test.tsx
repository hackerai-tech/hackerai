import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import type { SidebarNotes } from "@/types/chat";

let sidebarContent: SidebarNotes | null = null;
jest.mock("@/app/hooks/useToolSidebar", () => ({
  useToolSidebar: ({ content }: { content: SidebarNotes }) => {
    sidebarContent = content;
    return { handleOpenInSidebar: jest.fn(), handleKeyDown: jest.fn() };
  },
}));

const { NotesToolHandler } =
  require("../NotesToolHandler") as typeof import("../NotesToolHandler");
const { getNoteMetaSegments } =
  require("../notes-tool-utils") as typeof import("../notes-tool-utils");
const { extractSidebarContentFromMessage } =
  require("@/lib/utils/sidebar-utils") as typeof import("@/lib/utils/sidebar-utils");

const observed = Date.UTC(2026, 10, 3, 12);

describe("NotesToolHandler", () => {
  beforeEach(() => {
    sidebarContent = null;
  });

  it("shows a read note by title and opens its full content", () => {
    render(
      <NotesToolHandler
        status="ready"
        toolName="get_note"
        part={{
          toolCallId: "call-1",
          state: "output-available",
          input: { note_id: "abc12" },
          output: {
            success: true,
            note: {
              note_id: "abc12",
              title: "IDOR on invoice export",
              category: "findings",
              tags: ["idor"],
              target: "alpha.example",
              observed_at: observed,
              updated_at: observed,
              content: "Full first page",
              content_offset: 0,
              content_length: 9000,
              next_cursor: "4000",
            },
          },
        }}
      />,
    );

    expect(screen.getByText("Read note")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Open IDOR on invoice export in sidebar",
      }),
    ).toBeInTheDocument();
    expect(sidebarContent).toMatchObject({
      action: "get",
      affectedTitle: "IDOR on invoice export",
      notes: [
        {
          content: "Full first page",
          target: "alpha.example",
          partial_content: true,
        },
      ],
    });
  });

  it("shows a failed read without a sidebar action", () => {
    render(
      <NotesToolHandler
        status="ready"
        toolName="get_note"
        part={{
          toolCallId: "call-2",
          state: "output-available",
          input: { note_id: "zz" },
          output: { success: false, error: "Note 'zz' not found" },
        }}
      />,
    );

    expect(screen.getByText("Failed to read note")).toBeInTheDocument();
    expect(screen.getByText("Note 'zz' not found")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders compact previews from new list output and full content from old saved output", () => {
    render(
      <NotesToolHandler
        status="ready"
        toolName="list_notes"
        part={{
          toolCallId: "call-3",
          state: "output-available",
          input: { target: "alpha.example" },
          output: {
            success: true,
            has_more: false,
            notes: [
              {
                note_id: "a",
                title: "IDOR",
                category: "findings",
                tags: [],
                target: "alpha.example",
                updated_at: observed,
                recheck: "observation_date_unknown",
                preview: "GET /api/…",
                preview_truncated: true,
              },
            ],
          },
        }}
      />,
    );
    expect(screen.getByText("alpha.example")).toBeInTheDocument();
    const [note] = sidebarContent!.notes;
    expect(note).toMatchObject({
      content: "GET /api/…",
      preview_truncated: true,
    });
    // Unknown observation dates are stated, never inferred from the edit date.
    expect(getNoteMetaSegments(note)).toEqual([
      "alpha.example",
      "Observed date unknown",
      expect.stringMatching(/^Edited /),
    ]);

    const legacy = {
      note_id: "old",
      title: "Old note",
      content: "Complete legacy content",
      category: "general" as const,
      tags: [],
      updated_at: observed,
    };
    expect(getNoteMetaSegments(legacy)).toEqual([]);
  });

  it("keeps a bounded list page's continuation status", () => {
    render(
      <NotesToolHandler
        status="ready"
        toolName="list_notes"
        part={{
          toolCallId: "call-4",
          state: "output-available",
          input: {},
          output: {
            success: true,
            has_more: true,
            next_cursor: "page-2",
            notes: [
              {
                note_id: "a",
                title: "First",
                category: "general",
                tags: [],
                updated_at: observed,
                preview: "x",
                preview_truncated: false,
              },
            ],
          },
        }}
      />,
    );
    expect(sidebarContent).toMatchObject({ hasMore: true, totalCount: 1 });
  });

  it("shows the observation date and target a created note was saved with", () => {
    render(
      <NotesToolHandler
        status="ready"
        toolName="create_note"
        part={{
          toolCallId: "call-5",
          state: "output-available",
          input: {
            title: "IDOR",
            content: "Invoice export",
            category: "findings",
            target: "HTTPS://Alpha.Example/",
            observed_at: "2026-11-03",
          },
          output: { success: true, note_id: "n1" },
        }}
      />,
    );
    const [note] = sidebarContent!.notes;
    expect(note).toMatchObject({
      target: "https://alpha.example",
      observed_at: Date.UTC(2026, 10, 3),
    });
    expect(getNoteMetaSegments(note)).toEqual([
      "https://alpha.example",
      "Observed 2026-11-03",
    ]);

    // Legacy create outputs carry no recall fields and gain no metadata.
    render(
      <NotesToolHandler
        status="ready"
        toolName="create_note"
        part={{
          toolCallId: "call-6",
          state: "output-available",
          input: { title: "Old", content: "x", category: "findings" },
          output: { success: true, note_id: "n2" },
        }}
      />,
    );
    expect(getNoteMetaSegments(sidebarContent!.notes[0])).toEqual([]);
  });

  it("treats a failed read as finished in the sidebar timeline", () => {
    const [content] = extractSidebarContentFromMessage({
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-get_note",
          toolCallId: "call-7",
          state: "output-error",
          input: { note_id: "zz" },
          errorText: "Convex unavailable",
        },
      ],
    } as never) as SidebarNotes[];
    expect(content).toMatchObject({
      action: "get",
      isExecuting: false,
      error: "Convex unavailable",
    });
  });

  it("omits the edit date when it matches the observation", () => {
    expect(
      getNoteMetaSegments({
        note_id: "a",
        title: "t",
        content: "c",
        category: "findings",
        tags: [],
        target: "alpha.example",
        observed_at: observed,
        updated_at: observed + 1_000,
      }),
    ).toEqual(["alpha.example", expect.stringMatching(/^Observed /)]);
  });

  it("preserves date-only observations and UTC day boundaries in every timezone", () => {
    expect(
      getNoteMetaSegments({
        note_id: "date-only",
        title: "Historical observation",
        content: "Recheck before relying on this.",
        category: "findings",
        tags: [],
        observed_at: Date.parse("2026-11-01"),
        updated_at: Date.parse("2026-11-02T00:01:00Z"),
      }),
    ).toEqual(["Observed 2026-11-01", "Edited 2026-11-02"]);
  });
});
