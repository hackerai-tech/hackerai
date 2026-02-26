import { describe, it, expect } from "@jest/globals";
import { UIMessage } from "ai";
import { limitFileParts } from "../chat-processor";

function makeFilePart(id: string, mediaType = "image/png") {
  return { type: "file", fileId: id, mediaType, name: `${id}.png`, size: 100 };
}

function makeMessage(
  id: string,
  role: "user" | "assistant",
  parts: any[],
): UIMessage {
  return { id, role, parts } as UIMessage;
}

describe("limitFileParts", () => {
  it("should return messages unchanged when under the limit", () => {
    const messages = [
      makeMessage("m1", "user", [
        { type: "text", text: "hello" },
        makeFilePart("f1"),
      ]),
    ];
    const result = limitFileParts(messages);
    expect(result).toBe(messages); // same reference, no changes
  });

  it("should return messages unchanged when exactly at the limit (10 images)", () => {
    const parts = Array.from({ length: 10 }, (_, i) => makeFilePart(`f${i}`));
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitFileParts(messages);
    expect(result).toBe(messages);
  });

  it("should remove oldest images when over the limit", () => {
    const parts = Array.from({ length: 15 }, (_, i) => makeFilePart(`f${i}`));
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitFileParts(messages);

    const remainingFiles = result[0].parts.filter(
      (p: any) => p.type === "file",
    );
    expect(remainingFiles).toHaveLength(10);
    // Should keep f5..f14 (the 10 most recent), removing f0..f4
    expect((remainingFiles[0] as any).fileId).toBe("f5");
    expect((remainingFiles[9] as any).fileId).toBe("f14");
  });

  it("should remove oldest images across multiple messages", () => {
    // 3 messages with 5 images each = 15 total, should keep last 10
    const messages = Array.from({ length: 3 }, (_, msgIdx) => {
      const parts = Array.from({ length: 5 }, (_, fileIdx) =>
        makeFilePart(`f${msgIdx * 5 + fileIdx}`),
      );
      return makeMessage(`m${msgIdx}`, "user", parts);
    });

    const result = limitFileParts(messages);

    const allFiles = result.flatMap((msg) =>
      msg.parts.filter((p: any) => p.type === "file"),
    );
    expect(allFiles).toHaveLength(10);
    // Oldest 5 images (f0..f4) from first message should be removed
    expect((allFiles[0] as any).fileId).toBe("f5");
    expect((allFiles[9] as any).fileId).toBe("f14");
  });

  it("should preserve non-file parts when removing images", () => {
    const parts: any[] = [
      { type: "text", text: "check these images" },
      ...Array.from({ length: 12 }, (_, i) => makeFilePart(`f${i}`)),
    ];
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitFileParts(messages);

    const textParts = result[0].parts.filter((p: any) => p.type === "text");
    const fileParts = result[0].parts.filter((p: any) => p.type === "file");

    expect(textParts).toHaveLength(1);
    expect((textParts[0] as any).text).toBe("check these images");
    expect(fileParts).toHaveLength(10);
  });

  it("should handle messages with no parts", () => {
    const messages = [
      { id: "m1", role: "user" } as UIMessage,
      makeMessage("m2", "user", [makeFilePart("f1")]),
    ];
    const result = limitFileParts(messages);
    expect(result).toBe(messages); // under limit, no changes
  });

  it("should only limit images, leaving PDFs and other file types untouched", () => {
    const parts = Array.from({ length: 25 }, (_, i) =>
      makeFilePart(`f${i}`, i % 2 === 0 ? "image/png" : "application/pdf"),
    );
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitFileParts(messages);

    const remainingFiles = result[0].parts.filter(
      (p: any) => p.type === "file",
    );
    const images = remainingFiles.filter(
      (p: any) => p.mediaType === "image/png",
    );
    const pdfs = remainingFiles.filter(
      (p: any) => p.mediaType === "application/pdf",
    );

    // All 12 PDFs should remain (odd indices: 1,3,5,...,23 = 12 PDFs)
    expect(pdfs).toHaveLength(12);
    // Only 10 most recent images should remain (even indices: 0,2,4,...,24 = 13 images, keep last 10)
    expect(images).toHaveLength(10);
  });

  it("should not remove any files when all are non-image types", () => {
    const parts = Array.from({ length: 20 }, (_, i) =>
      makeFilePart(`f${i}`, "application/pdf"),
    );
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitFileParts(messages);
    expect(result).toBe(messages); // no images, nothing to limit
  });
});
