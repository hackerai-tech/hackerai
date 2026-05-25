import {
  getEmptyProcessedMessagesCause,
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
});
