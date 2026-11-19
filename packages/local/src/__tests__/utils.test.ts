/**
 * Tests for local sandbox utility functions.
 *
 * These tests verify:
 * - Output truncation (25% head + 75% tail strategy)
 * - Platform shell detection
 */

import {
  truncateOutput,
  TRUNCATION_MARKER,
  MAX_OUTPUT_SIZE,
  getDefaultShell,
} from "../utils";

describe("Output Truncation", () => {
  it("should not truncate content under max size", () => {
    const content = "short content";
    const result = truncateOutput(content);
    expect(result).toBe(content);
  });

  it("should truncate content over max size with 25% head + 75% tail", () => {
    // Create content larger than MAX_OUTPUT_SIZE
    const content = "A".repeat(MAX_OUTPUT_SIZE + 1000);
    const result = truncateOutput(content);

    expect(result.length).toBeLessThanOrEqual(MAX_OUTPUT_SIZE);
    expect(result).toContain(TRUNCATION_MARKER);
  });

  it("should preserve head content (25%)", () => {
    const head = "HEAD_CONTENT_";
    const middle = "M".repeat(MAX_OUTPUT_SIZE);
    const tail = "_TAIL_CONTENT";
    const content = head + middle + tail;

    const result = truncateOutput(content);

    expect(result.startsWith(head)).toBe(true);
  });

  it("should preserve tail content (75%)", () => {
    const head = "HEAD_CONTENT_";
    const middle = "M".repeat(MAX_OUTPUT_SIZE);
    const tail = "_TAIL_CONTENT";
    const content = head + middle + tail;

    const result = truncateOutput(content);

    expect(result.endsWith(tail)).toBe(true);
  });

  it("should use custom max size", () => {
    const content = "A".repeat(200);
    const result = truncateOutput(content, 100);

    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain(TRUNCATION_MARKER);
  });

  describe("surrogate pairs at the cut", () => {
    // 200 content units: the head keeps 50 and the tail keeps 150.
    const maxSize = TRUNCATION_MARKER.length + 200;
    const hasLoneSurrogate = (text: string) =>
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        text,
      );

    it("keeps exact ASCII head and tail sizes", () => {
      const content = "h".repeat(300) + "t".repeat(300);

      expect(truncateOutput(content, maxSize)).toBe(
        "h".repeat(50) + TRUNCATION_MARKER + "t".repeat(150),
      );
    });

    it("omits a pair the head cut would split", () => {
      const content = "a".repeat(49) + "😀" + "b".repeat(500);
      const result = truncateOutput(content, maxSize);

      expect(hasLoneSurrogate(result)).toBe(false);
      expect(result).toBe("a".repeat(49) + TRUNCATION_MARKER + "b".repeat(150));
    });

    it("omits a pair the tail cut would split", () => {
      const content = "a".repeat(500) + "😀" + "b".repeat(149);
      const result = truncateOutput(content, maxSize);

      expect(hasLoneSurrogate(result)).toBe(false);
      expect(result).toBe("a".repeat(50) + TRUNCATION_MARKER + "b".repeat(149));
    });

    it("keeps whole pairs that fit and leaves existing lone surrogates as-is", () => {
      const head = "a".repeat(47) + "😀\uDC00";
      const content = head + "x".repeat(500) + "\uD800" + "z".repeat(149);

      expect(truncateOutput(content, maxSize)).toBe(
        head + TRUNCATION_MARKER + "\uD800" + "z".repeat(149),
      );
    });
  });
});

describe("Platform Shell Detection", () => {
  it("should return the system cmd.exe for Windows", () => {
    const result = getDefaultShell("win32");
    expect(result.shell).toBe(
      `${process.env.SystemRoot || "C:\\Windows"}\\System32\\cmd.exe`,
    );
    expect(result.shellFlag).toBe("/C");
  });

  it("should return bash for Linux", () => {
    const result = getDefaultShell("linux");
    expect(result.shell).toBe("/bin/bash");
    expect(result.shellFlag).toBe("-c");
  });

  it("should return bash for macOS (darwin)", () => {
    const result = getDefaultShell("darwin");
    expect(result.shell).toBe("/bin/bash");
    expect(result.shellFlag).toBe("-c");
  });

  it("should return bash for unknown platforms", () => {
    const result = getDefaultShell("freebsd");
    expect(result.shell).toBe("/bin/bash");
    expect(result.shellFlag).toBe("-c");
  });
});
