import {
  isGeneratedPastedTextAttachment,
  isPastedTextAttachmentAvailableInMode,
  PASTED_TEXT_ATTACHMENT_MIN_CHARS,
  PASTED_TEXT_INLINE_RESTORE_MAX_CHARS,
} from "../pasted-text-attachments";
import type { UploadedFileState } from "@/types/file";

const generatedTextFile: UploadedFileState = {
  file: new File(["source"], "Pasted text.txt", { type: "text/plain" }),
  uploading: false,
  uploaded: true,
  storage: "s3",
  fileId: "file_123",
  generatedSource: "pasted-text",
};

describe("pasted text attachment behavior", () => {
  it("uses the Codex Desktop character boundaries", () => {
    expect(PASTED_TEXT_ATTACHMENT_MIN_CHARS).toBe(5_000);
    expect(PASTED_TEXT_INLINE_RESTORE_MAX_CHARS).toBe(25_000);
  });

  it("recognizes generated pasted text across hydrated and draft states", () => {
    expect(isGeneratedPastedTextAttachment(generatedTextFile)).toBe(true);
    expect(
      isGeneratedPastedTextAttachment({
        ...generatedTextFile,
        generatedSource: undefined,
        generatedTextAttachmentId: "paste_123",
      }),
    ).toBe(true);
    expect(
      isGeneratedPastedTextAttachment({
        file: {
          name: "report.txt",
          type: "text/plain",
          size: 100,
          lastModified: 123,
        },
        uploading: false,
        uploaded: true,
        storage: "local-desktop",
        localAttachmentId: "local_123",
        localPath: "/Users/alice/report.txt",
      }),
    ).toBe(false);
  });

  it("makes generated pasted text available only in Agent mode", () => {
    expect(
      isPastedTextAttachmentAvailableInMode(generatedTextFile, "agent"),
    ).toBe(true);
    expect(
      isPastedTextAttachmentAvailableInMode(generatedTextFile, "ask"),
    ).toBe(false);
  });
});
