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

  it("resolves early when aborted", async () => {
    const session = makeSession();
    const controller = new AbortController();

    const pending = waitForOutput(
      session,
      1_000,
      controller.signal,
      jest.fn(),
      consume,
    );
    controller.abort();

    await expect(pending).resolves.toEqual(new Uint8Array());
  });

  it("strips ANSI sequences and caps long output", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m \x1b]0;title\x07plain")).toBe(
      "red plain",
    );

    const capped = capOutput("a".repeat(200) + "b".repeat(200), 256);
    expect(capped).toBe(
      `${"a".repeat(179)}\n...[truncated 208 bytes]...\n${"b".repeat(13)}`,
    );
  });

  it("peeks resolved exits without waiting on live processes", async () => {
    const live = makeSession();
    await expect(peekExited(live)).resolves.toBeNull();

    const exited = makeSession();
    exited.resolveExit(7);
    await expect(peekExited(exited)).resolves.toEqual({ exitCode: 7 });
  });
});
