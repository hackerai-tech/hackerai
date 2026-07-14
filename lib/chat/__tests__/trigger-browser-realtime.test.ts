import { afterEach, describe, expect, it, jest } from "@jest/globals";

import { readTriggerRunStream } from "@/lib/chat/trigger-browser-realtime";

const originalFetch = global.fetch;

const response = (status: number, bodyText?: string) => {
  const encoder = new TextEncoder();
  let sent = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "x-stream-version" ? "v1" : null,
    },
    body:
      bodyText === undefined
        ? null
        : {
            getReader: () => ({
              read: async () => {
                if (sent) return { done: true as const, value: undefined };
                sent = true;
                return {
                  done: false as const,
                  value: encoder.encode(bodyText),
                };
              },
              cancel: async () => undefined,
              releaseLock: () => undefined,
            }),
          },
  } as unknown as Response;
};

const streamResponse = (id: string, value: unknown) =>
  response(200, `id: ${id}\ndata: ${JSON.stringify(value)}\n\n`);

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
