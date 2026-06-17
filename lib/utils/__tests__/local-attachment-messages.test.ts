import {
  getEmptyProcessedMessagesCause,
  getEmptyProcessedMessagesMetadata,
  hasRestageableLocalDesktopAttachments,
  hasUnrestageableLocalDesktopAttachments,
} from "../local-attachment-messages";

describe("local attachment message helpers", () => {
  it("detects local desktop attachments that still have a source path", () => {
    const messages = [
      {
        parts: [
          { type: "text", text: "inspect this" },
          {
            type: "file",
            storage: "local-desktop",
            localPath: "/Users/alice/report.pdf",
          },
        ],
      },
    ];

    expect(hasRestageableLocalDesktopAttachments(messages)).toBe(true);
    expect(hasUnrestageableLocalDesktopAttachments(messages)).toBe(false);
  });

  it("detects persisted local desktop attachments that lost their source path", () => {
    const messages = [
      {
        parts: [
          {
            type: "file",
            storage: "local-desktop",
            localAttachmentId: "local-1",
            name: "report.pdf",
          },
        ],
      },
    ];

    expect(hasRestageableLocalDesktopAttachments(messages)).toBe(false);
    expect(hasUnrestageableLocalDesktopAttachments(messages)).toBe(true);
  });

  it("uses a reattach-specific error for unstageable local files", () => {
    expect(
      getEmptyProcessedMessagesCause([
        {
          parts: [
            {
              type: "file",
              storage: "local-desktop",
              name: "report.pdf",
            },
          ],
        },
      ]),
    ).toBe(
      "The attached local file is no longer available to this request. Please reattach it and try again.",
    );
  });

  it("uses a preparation error for other attachment-only empty requests", () => {
    expect(
      getEmptyProcessedMessagesCause([
        {
          parts: [{ type: "file", fileId: "file_123", name: "report.pdf" }],
        },
      ]),
    ).toBe(
      "The attached file could not be prepared for this request. Please reattach it or add a short message and try again.",
    );
  });

  it("summarizes empty-after-processing inputs without message contents", () => {
    expect(
      getEmptyProcessedMessagesMetadata(
        [
          {
            role: "user",
            parts: [
              { type: "text", text: "   " },
              { type: "data-summarization", data: { status: "done" } },
              {
                type: "file",
                storage: "local-desktop",
                localPath: "/Users/alice/report.pdf",
                url: "file:///private/report.pdf",
              },
            ],
          },
          {
            role: "assistant",
            parts: [
              { type: "step-start" },
              { type: "reasoning", text: "thinking" },
              { type: "tool-run_terminal_cmd", state: "input-available" },
            ],
          },
          { role: "system", parts: [] },
        ],
        {
          regenerate: true,
          isAutoContinue: false,
          isTemporary: true,
          sandboxPreference: "desktop",
        },
      ),
    ).toEqual({
      empty_after_processing: true,
      processing_input_message_count: 3,
      processing_input_user_message_count: 1,
      processing_input_assistant_message_count: 1,
      processing_input_system_message_count: 1,
      processing_input_other_role_message_count: 0,
      processing_input_empty_parts_message_count: 1,
      processing_input_part_count: 6,
      processing_input_text_part_count: 1,
      processing_input_nonempty_text_part_count: 0,
      processing_input_file_part_count: 1,
      processing_input_file_with_url_count: 1,
      processing_input_file_with_file_id_count: 0,
      processing_input_local_desktop_file_part_count: 1,
      processing_input_local_desktop_file_with_local_path_count: 1,
      processing_input_local_desktop_file_missing_local_path_count: 0,
      processing_input_ui_only_part_count: 1,
      processing_input_step_start_part_count: 1,
      processing_input_reasoning_part_count: 1,
      processing_input_nonempty_reasoning_part_count: 1,
      processing_input_tool_part_count: 1,
      processing_input_data_part_count: 0,
      processing_input_other_part_count: 0,
      processing_input_regenerate: true,
      processing_input_auto_continue: false,
      processing_input_temporary: true,
      processing_input_sandbox_preference: "desktop",
    });
  });
});
