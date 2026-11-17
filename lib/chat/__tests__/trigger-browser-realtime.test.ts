import { afterEach, describe, expect, it, jest } from "@jest/globals";

import { readTriggerRunStream } from "@/lib/chat/trigger-browser-realtime";

const originalFetch = global.fetch;
const encoder = new TextEncoder();

const response = (
  status: number,
  body?: string | Uint8Array[],
  streamVersion: "v1" | "v2" = "v1",
) => {
  const chunks = typeof body === "string" ? [encoder.encode(body)] : body;
  let nextChunk = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "x-stream-version" ? streamVersion : null,
    },
    body:
      chunks === undefined
        ? null
        : {
            getReader: () => ({
              read: async () => {
                if (nextChunk >= chunks.length) {
                  return { done: true as const, value: undefined };
                }
                return { done: false as const, value: chunks[nextChunk++] };
              },
              cancel: async () => undefined,
              releaseLock: () => undefined,
            }),
          },
  } as unknown as Response;
};

const streamResponse = (id: string, value: unknown) =>
  response(200, `id: ${id}\ndata: ${JSON.stringify(value)}\n\n`);

const byteOffsetOf = (text: string, marker: string) => {
  const index = text.indexOf(marker);
  if (index === -1) throw new Error(`Missing fixture marker: ${marker}`);
  return encoder.encode(text.slice(0, index)).length;
};

const splitAtBytes = (text: string, offsets: number[]) => {
  const bytes = encoder.encode(text);
  const boundaries = [0, ...offsets, bytes.length];
  return boundaries
    .slice(1)
    .map((end, index) => bytes.slice(boundaries[index], end));
};

const splitEveryBytes = (text: string, size: number) => {
  const bytes = encoder.encode(text);
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; start += size) {
    chunks.push(bytes.slice(start, start + size));
  }
  return chunks;
};

type BatchRecord = {
  seq_num: number;
  headers?: Array<[string, string]>;
  body: string;
};

const record = (seq: number, id: string, data: unknown): BatchRecord => ({
  seq_num: seq,
  body: JSON.stringify({ id, data }),
});

const batchEvent = (records: BatchRecord[]) =>
  `event: batch\r\ndata: ${JSON.stringify({ records })}`;

const collectInto = async <T>(stream: AsyncIterable<T>, values: T[]) => {
  for await (const value of stream) values.push(value);
};

const requestHeaders = (fetchMock: jest.Mock<typeof fetch>, call: number) =>
  fetchMock.mock.calls[call]?.[1]?.headers as Record<string, string>;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe("readTriggerRunStream token refresh", () => {
  it("refreshes after 401 while preserving the stream cursor", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse("11", { value: "before" }))
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(streamResponse("12", { value: "after" }));
    global.fetch = fetchMock;
    const refreshAccessToken = jest
      .fn<() => Promise<string>>()
      .mockResolvedValue("fresh-run-token");
    const iterator = readTriggerRunStream<{ value: string }>("run_123", "ui", {
      accessToken: "expired-run-token",
      refreshAccessToken,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { value: "before" },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { value: "after" },
    });
    await iterator.return?.();

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer expired-run-token",
        "Last-Event-ID": "11",
      }),
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer fresh-run-token",
        "Last-Event-ID": "11",
      }),
    });
  });

  it("fails closed when the refreshed token is also unauthorized", async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(403))
      .mockResolvedValueOnce(response(401));
    global.fetch = fetchMock;
    const refreshAccessToken = jest
      .fn<() => Promise<string>>()
      .mockResolvedValue("fresh-run-token");
    const iterator = readTriggerRunStream("run_123", "ui", {
      accessToken: "expired-run-token",
      refreshAccessToken,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow(
      "Trigger stream request failed: 401",
    );
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("readTriggerRunStream SSE framing", () => {
  it("reassembles v1 events split across UTF-8 bytes and CRLF reads", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const body =
      ": keepalive\r\n" +
      'id: 1\r\ndata: {"text":"café 🔐"}\r\n\r\n' +
      "id: 2\ndata: first line\ndata: second line\n\n" +
      'id: 3\ndata: {"n":3}\n\nid: 4\ndata: {"n":4}\n\n';
    const dataLineEnd = byteOffsetOf(body, '"}\r\n') + 2;
    const chunks = splitAtBytes(body, [
      byteOffsetOf(body, "é") + 1,
      byteOffsetOf(body, "🔐") + 2,
      dataLineEnd + 1,
      dataLineEnd + 3,
      byteOffsetOf(body, "second line"),
    ]);
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, chunks))
      .mockResolvedValueOnce(response(404));
    global.fetch = fetchMock;
    const values: unknown[] = [];

    await expect(
      collectInto(
        readTriggerRunStream("run_123", "ui", { accessToken: "run-token" }),
        values,
      ),
    ).rejects.toThrow("Trigger stream request failed: 404");

    expect(values).toEqual([
      { text: "café 🔐" },
      "first line\nsecond line",
      { n: 3 },
      { n: 4 },
    ]);
    expect(requestHeaders(fetchMock, 1)["Last-Event-ID"]).toBe("4");
  });

  it("reassembles a long v2 batch fragmented across many reads", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const parts = Array.from({ length: 300 }, (_, index) => ({
      index,
      text: `part ${index} é🔐 ${"x".repeat(200)}`,
    }));
    const tail = { index: 300, text: "tail" };
    const body =
      ": keepalive\r\n" +
      `${batchEvent(parts.map((data, index) => record(index + 1, `part-${index}`, data)))}\r\n\r\n` +
      `${batchEvent([record(301, "tail", tail)])}\r\n\r\n`;
    const chunks = splitEveryBytes(body, 1021);
    expect(chunks.length).toBeGreaterThan(50);
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, chunks, "v2"))
      .mockResolvedValueOnce(response(404));
    global.fetch = fetchMock;
    const values: unknown[] = [];

    await expect(
      collectInto(
        readTriggerRunStream("run_123", "ui", { accessToken: "run-token" }),
        values,
      ),
    ).rejects.toThrow("Trigger stream request failed: 404");

    expect(values).toEqual([...parts, tail]);
    expect(requestHeaders(fetchMock, 1)["Last-Event-ID"]).toBe("301");
  });
});

describe("readTriggerRunStream recovery", () => {
  it("resumes v2 from the last record cursor without replaying seen parts", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    // The first connection closes without a terminating blank line.
    const firstConnection = batchEvent([
      record(1, "part-a", "A"),
      record(2, "part-b", "B"),
    ]);
    const secondConnection = `${batchEvent([
      record(2, "part-b", "B"),
      {
        seq_num: 3,
        headers: [["", "control"]],
        body: JSON.stringify({ id: "control", data: "control" }),
      },
      record(4, "part-c", "C"),
    ])}\r\n\r\n`;
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(200, splitEveryBytes(firstConnection, 17), "v2"),
      )
      .mockResolvedValueOnce(
        response(200, splitEveryBytes(secondConnection, 23), "v2"),
      )
      .mockResolvedValueOnce(response(404));
    global.fetch = fetchMock;
    const values: unknown[] = [];

    await expect(
      collectInto(
        readTriggerRunStream("run_123", "ui", { accessToken: "run-token" }),
        values,
      ),
    ).rejects.toThrow("Trigger stream request failed: 404");

    expect(values).toEqual(["A", "B", "C"]);
    expect(requestHeaders(fetchMock, 0)["Last-Event-ID"]).toBeUndefined();
    expect(requestHeaders(fetchMock, 1)["Last-Event-ID"]).toBe("2");
    expect(requestHeaders(fetchMock, 2)["Last-Event-ID"]).toBe("4");
  });

  it("stops without reconnecting when the caller aborts during a read", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let markReadPending = () => {};
    const readPending = new Promise<void>((resolve) => {
      markReadPending = resolve;
    });
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        const signal = init?.signal as AbortSignal;
        requestSignal = signal;
        let sent = false;
        return {
          ok: true,
          status: 200,
          headers: { get: () => "v1" },
          body: {
            getReader: () => ({
              read: () => {
                if (!sent) {
                  sent = true;
                  return Promise.resolve({
                    done: false as const,
                    value: encoder.encode(
                      'id: 1\ndata: {"value":"first"}\n\nid: 2\ndata: {"val',
                    ),
                  });
                }
                markReadPending();
                return new Promise((_resolve, reject) => {
                  signal.addEventListener(
                    "abort",
                    () => reject(new Error("aborted")),
                    { once: true },
                  );
                });
              },
              cancel: async () => undefined,
              releaseLock: () => undefined,
            }),
          },
        } as unknown as Response;
      });
    global.fetch = fetchMock;
    const iterator = readTriggerRunStream<{ value: string }>("run_123", "ui", {
      accessToken: "run-token",
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { value: "first" },
    });
    const pendingNext = iterator.next();
    await readPending;
    controller.abort();

    await expect(pendingNext).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
