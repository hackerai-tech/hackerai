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

  it("should return messages unchanged when exactly at the limit (30)", () => {
    const parts = Array.from({ length: 30 }, (_, i) => makeFilePart(`f${i}`));
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitFileParts(messages);
    expect(result).toBe(messages);
  });

  it("should remove oldest files when over the limit", () => {
    const parts = Array.from({ length: 35 }, (_, i) => makeFilePart(`f${i}`));
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitFileParts(messages);

    const remainingFiles = result[0].parts.filter(
      (p: any) => p.type === "file",
    );
    expect(remainingFiles).toHaveLength(30);
    // Should keep f5..f34 (the 30 most recent), removing f0..f4
    expect((remainingFiles[0] as any).fileId).toBe("f5");
    expect((remainingFiles[29] as any).fileId).toBe("f34");
  });

  it("should remove oldest files across multiple messages", () => {
    // 3 messages with 12 files each = 36 total, should keep last 30
    const messages = Array.from({ length: 3 }, (_, msgIdx) => {
      const parts = Array.from({ length: 12 }, (_, fileIdx) =>
        makeFilePart(`f${msgIdx * 12 + fileIdx}`),
      );
      return makeMessage(`m${msgIdx}`, "user", parts);
    });

    const result = limitFileParts(messages);

    const allFiles = result.flatMap((msg) =>
      msg.parts.filter((p: any) => p.type === "file"),
    );
    expect(allFiles).toHaveLength(30);
    // Oldest 6 files (f0..f5) from first message should be removed
    expect((allFiles[0] as any).fileId).toBe("f6");
    expect((allFiles[29] as any).fileId).toBe("f35");
  });

  it("should preserve non-file parts when removing files", () => {
    const parts: any[] = [
      { type: "text", text: "check these images" },
      ...Array.from({ length: 32 }, (_, i) => makeFilePart(`f${i}`)),
    ];
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitFileParts(messages);

    const textParts = result[0].parts.filter((p: any) => p.type === "text");
    const fileParts = result[0].parts.filter((p: any) => p.type === "file");

    expect(textParts).toHaveLength(1);
    expect((textParts[0] as any).text).toBe("check these images");
    expect(fileParts).toHaveLength(30);
  });

  it("should handle messages with no parts", () => {
    const messages = [
      { id: "m1", role: "user" } as UIMessage,
      makeMessage("m2", "user", [makeFilePart("f1")]),
    ];
    const result = limitFileParts(messages);
    expect(result).toBe(messages); // under limit, no changes
  });

  it("should limit all file types, not just images", () => {
    const parts = Array.from({ length: 35 }, (_, i) =>
      makeFilePart(`f${i}`, i % 2 === 0 ? "image/png" : "application/pdf"),
    );
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitFileParts(messages);

    const remainingFiles = result[0].parts.filter(
      (p: any) => p.type === "file",
    );
    expect(remainingFiles).toHaveLength(30);
    // Should keep f5..f34
    expect((remainingFiles[0] as any).fileId).toBe("f5");
  });
});
