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
});

describe("Platform Shell Detection", () => {
  it("should return cmd.exe for Windows", () => {
    const result = getDefaultShell("win32");
    expect(result.shell).toBe("cmd.exe");
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
