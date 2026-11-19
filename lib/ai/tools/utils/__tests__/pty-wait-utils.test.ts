import {
  capOutput,
  peekExited,
  stripAnsi,
  waitForOutput,
} from "../pty-wait-utils";
import type { PtySession } from "../pty-session-manager";

type FakeSession = PtySession & {
  emit: (text: string) => void;
  resolveExit: (exitCode: number | null) => void;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function makeSession(initialOutput = ""): FakeSession {
  const listeners = new Set<(bytes: Uint8Array) => void>();
  let resolveExit!: (value: { exitCode: number | null }) => void;
  const exited = new Promise<{ exitCode: number | null }>((resolve) => {
    resolveExit = resolve;
  });
  const buffer = initialOutput ? [encoder.encode(initialOutput)] : [];

  const session = {
    sessionId: "session-1",
    chatId: "chat-1",
    pid: 123,
    cols: 120,
    rows: 30,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    handle: {
      pid: 123,
      sendInput: jest.fn(),
      resize: jest.fn(),
      kill: jest.fn(),
      exited,
      onData: (cb: (bytes: Uint8Array) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
    buffer,
    readCursor: 0,
    bufferTruncated: false,
    emit: (text: string) => {
      const bytes = encoder.encode(text);
      session.buffer.push(bytes);
      for (const listener of Array.from(listeners)) listener(bytes);
    },
    resolveExit: (exitCode: number | null) => resolveExit({ exitCode }),
  } as FakeSession;

  return session;
}

function consume(session: PtySession): Uint8Array {
  const joined = concat(session.buffer);
  const start = Math.min(session.readCursor, joined.byteLength);
  const out = joined.slice(start);
  session.readCursor = joined.byteLength;
  return out;
}

describe("pty-wait-utils", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("streams and returns output buffered before subscription", async () => {
    jest.useFakeTimers();
    const session = makeSession("already buffered\n");
    const chunks: string[] = [];

    const pending = waitForOutput(
      session,
      50,
      undefined,
      (chunk) => chunks.push(decoder.decode(chunk)),
      consume,
    );

    await jest.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toEqual(
      encoder.encode("already buffered\n"),
    );
    expect(chunks).toEqual(["already buffered\n"]);
  });

  it("resolves on quiet time after the first chunk", async () => {
    jest.useFakeTimers();
    const session = makeSession();
    const chunks: string[] = [];
    let resolved = false;

    const pending = waitForOutput(
      session,
      1_000,
      undefined,
      (chunk) => chunks.push(decoder.decode(chunk)),
      consume,
      { quietMs: 20 },
    ).then((result) => {
      resolved = true;
      return result;
    });

    session.emit("first chunk");
    await jest.advanceTimersByTimeAsync(19);
    expect(resolved).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(encoder.encode("first chunk"));
    expect(chunks).toEqual(["first chunk"]);
  });

  it.each([
    "before waiting",
    "while emitting buffered output",
    "after subscribing",
  ])(
    "settles immediately and preserves output when aborted %s",
    async (timing) => {
      jest.useFakeTimers();
      const session = makeSession("buffered output\n");
      const controller = new AbortController();
      const onChunk = jest.fn(() => {
        if (timing === "while emitting buffered output") controller.abort();
      });
      if (timing === "before waiting") controller.abort();
      let settled = false;
      const pending = waitForOutput(
        session,
        1_000,
        controller.signal,
        onChunk,
        consume,
        { quietMs: 20 },
      ).then((output) => {
        settled = true;
        return output;
      });
      if (timing === "after subscribing") controller.abort();

      try {
        await jest.advanceTimersByTimeAsync(0);
        expect(settled).toBe(true);
        await expect(pending).resolves.toEqual(
          encoder.encode("buffered output\n"),
        );
        expect(jest.getTimerCount()).toBe(0);
        onChunk.mockClear();
        session.emit("later output\n");
        expect(onChunk).not.toHaveBeenCalled();
        expect(consume(session)).toEqual(encoder.encode("later output\n"));
      } finally {
        await jest.runAllTimersAsync();
      }
    },
  );

  it("strips ANSI sequences and caps long output", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m \x1b]0;title\x07plain")).toBe(
      "red plain",
    );

    const capped = capOutput("a".repeat(200) + "b".repeat(200), 256);
    expect(capped).toBe(
      `${"a".repeat(179)}\n...[truncated 208 bytes]...\n${"b".repeat(13)}`,
    );
  });

  // Expected values are the text a terminal displays for the same bytes.
  it.each([
    ["a BEL-terminated title", "ok\x1b]0;title\x07red", "okred"],
    ["an ESC-backslash-terminated title", "ok\x1b]0;title\x1b\\red", "okred"],
    [
      "a title cancelled by repeated ESC before a color",
      "ok\x1b]0;title\x1b\x1b[31mred\x1b[0m",
      "okred",
    ],
    ["a title cancelled by CAN", "ok\x1b]0;title\x18red", "okred"],
    ["a title cancelled by SUB", "ok\x1b]0;title\x1ared", "okred"],
    ["a complete multiline title", "ok\x1b]0;title\ncontinued\x07red", "okred"],
    ["a character-set designation", "a\x1b(Bb", "ab"],
    ["a title cut off at the end of the excerpt", "ok\n\x1b]0;tit", "ok\n"],
    ["a color cut off at the end of the excerpt", "ok\x1b[3", "ok"],
    ["a lone trailing ESC", "ok\x1b", "ok"],
  ])("strips %s without leaking control text", (_label, input, expected) => {
    expect(stripAnsi(input)).toBe(expected);
  });

  it("keeps printed text that only resembles terminal controls", () => {
    // A decoded U+009C is a printable code point in UTF-8 output, not ST.
    expect(stripAnsi("\x1b[1mé\u009c→\x1b[0m\nnext\r\n")).toBe(
      "é\u009c→\nnext\r\n",
    );
    // An unterminated title must not hide later lines of command output.
    expect(stripAnsi("\x1b]0;title\ncommand output")).toBe(
      "0;title\ncommand output",
    );
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])(
    "keeps a colored line after an unterminated title ending at %s",
    (_label, eol) => {
      expect(
        stripAnsi(`\x1b]0;title${eol}command output \x1b[31mred\x1b[0m`),
      ).toBe(`0;title${eol}command output red`);
    },
  );

  it("peeks resolved exits without waiting on live processes", async () => {
    const live = makeSession();
    await expect(peekExited(live)).resolves.toBeNull();

    const exited = makeSession();
    exited.resolveExit(7);
    await expect(peekExited(exited)).resolves.toEqual({ exitCode: 7 });
  });
});
