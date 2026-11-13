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
