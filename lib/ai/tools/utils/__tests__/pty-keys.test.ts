/**
 * Tests for pty-keys translation helpers.
 *
 * Covers:
 *  - translateInput: whole-input key-name matching
 *  - translateInput: trailing real newline normalization to Enter (\r)
 *  - translateInputSequence: array form concatenates per-token results
 */

import {
  translateInput,
  translateInputSequence,
  SPECIAL_KEYS,
} from "../pty-keys";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("translateInput", () => {
  it("translates exact tmux key names to their byte sequences", () => {
    expect(decode(translateInput("Enter"))).toBe("\r");
    expect(decode(translateInput("Tab"))).toBe("\t");
    expect(decode(translateInput("C-c"))).toBe("\x03");
    expect(decode(translateInput("C-d"))).toBe("\x04");
    expect(decode(translateInput("Up"))).toBe(SPECIAL_KEYS.Up);
  });

  it("translates M- (Alt) prefixes", () => {
    expect(decode(translateInput("M-x"))).toBe("\x1bx");
  });

  it("translates C-S- (Ctrl+Shift) prefixes", () => {
    expect(decode(translateInput("C-S-A"))).toBe("\x01");
  });

  it("sends plain text verbatim when it does not match a key name", () => {
    expect(decode(translateInput("hello"))).toBe("hello");
  });

  it("does NOT interpret literal backslash-n as a newline", () => {
    // Model over-escapes in JSON → the two characters "\\n" reach the tool.
    expect(decode(translateInput("foo\\n"))).toBe("foo\\n");
  });

  it("normalizes a trailing real LF to \\r (Enter)", () => {
    expect(decode(translateInput("my answer\n"))).toBe("my answer\r");
  });

  it("normalizes a trailing real CR to \\r (Enter)", () => {
    expect(decode(translateInput("my answer\r"))).toBe("my answer\r");
  });

  it("normalizes a trailing CRLF to a single \\r (Enter)", () => {
    expect(decode(translateInput("my answer\r\n"))).toBe("my answer\r");
  });

  it("leaves embedded (non-trailing) newlines untouched", () => {
    expect(decode(translateInput("line1\nline2"))).toBe("line1\nline2");
  });

  it("treats a lone real newline as Enter", () => {
    expect(decode(translateInput("\n"))).toBe("\r");
  });
});

describe("translateInputSequence", () => {
  it("concatenates tokens so typing + Enter fits one send", () => {
    const out = decode(
      translateInputSequence(["hackerai-test-project", "Enter"]),
    );
    expect(out).toBe("hackerai-test-project\r");
  });

  it("mixes literal text with control keys in order", () => {
    const out = decode(translateInputSequence(["cd /tmp", "Enter", "C-c"]));
    expect(out).toBe("cd /tmp\r\x03");
  });

  it("handles a single-element array (key or text)", () => {
    expect(decode(translateInputSequence(["Enter"]))).toBe("\r");
    expect(decode(translateInputSequence(["abc"]))).toBe("abc");
  });

  it("returns empty bytes for an empty token list", () => {
    expect(translateInputSequence([]).byteLength).toBe(0);
  });
});
