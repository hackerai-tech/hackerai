import { processMessageFiles } from "../file-transform-utils";

jest.mock("server-only", () => ({}));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: jest.fn(() => ({
    action: jest.fn(),
  })),
}));

const makeMessage = (part: Record<string, unknown>) =>
  [
    {
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "what is this?" }, part],
    },
  ] as any;

const responseLike = ({
  status = 200,
  headers = {},
  body = null,
}: {
  status?: number;
  headers?: Record<string, string>;
  body?: { getReader: () => { read: () => Promise<any> } } | null;
}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    body,
  }) as Response;

const streamBody = (...chunks: Uint8Array[]) => ({
  getReader: () => {
    let index = 0;
    return {
      read: async () =>
        index < chunks.length
          ? { done: false, value: chunks[index++] }
          : { done: true },
    };
  },
});

describe("processMessageFiles image size guards", () => {
  const originalFetch = global.fetch;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    consoleWarnSpy.mockRestore();
  });

  it("omits URL-backed images when HEAD shows provider download size over 30 MB", async () => {
    global.fetch = jest.fn(async (_url, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return responseLike({
          headers: { "content-length": String(40 * 1024 * 1024) },
        });
      }

      throw new Error("Range probe should not run when HEAD has a size");
    }) as any;

    const result = await processMessageFiles(
      makeMessage({
        type: "file",
        mediaType: "image/png",
        fileId: "file_huge",
        name: "huge.png",
        url: "https://example.com/huge.png",
      }),
      "ask",
      "user123",
      undefined,
      "pro",
    );

    expect(result.messages[0].parts).toEqual([
      { type: "text", text: "what is this?" },
      {
        type: "text",
        text: '[Image "huge.png" omitted: 40.0 MB exceeds the 30 MB per-image limit]',
      },
    ]);
  });

  it("omits URL-backed images when headers are inconclusive but the range probe exceeds 5 MB", async () => {
    global.fetch = jest.fn(async (_url, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return responseLike({});
      }

      return responseLike({
        status: 206,
        body: streamBody(new Uint8Array(5 * 1024 * 1024 + 1)),
      });
    }) as any;

    const result = await processMessageFiles(
      makeMessage({
        type: "file",
        mediaType: "image/png",
        fileId: "file_unknown",
        name: "unknown-size.png",
        url: "https://example.com/unknown-size.png",
      }),
      "ask",
      "user123",
      undefined,
      "pro",
    );

    expect(result.messages[0].parts[1]).toEqual({
      type: "text",
      text: '[Image "unknown-size.png" omitted: 5.0 MB exceeds the 5 MB per-image limit]',
    });
  });

  it("keeps URL-backed images when content-length is within the image limit", async () => {
    global.fetch = jest.fn(async () => {
      return responseLike({
        headers: { "content-length": String(2 * 1024 * 1024) },
      });
    }) as any;

    const result = await processMessageFiles(
      makeMessage({
        type: "file",
        mediaType: "image/png",
        fileId: "file_small",
        name: "small.png",
        url: "https://example.com/small.png",
      }),
      "ask",
      "user123",
      undefined,
      "pro",
    );

    expect(result.messages[0].parts[1]).toMatchObject({
      type: "file",
      mediaType: "image/png",
      name: "small.png",
      url: "https://example.com/small.png",
    });
  });

  it("does not probe or convert inline URL file parts without fileId", async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    const result = await processMessageFiles(
      makeMessage({
        type: "file",
        mediaType: "application/pdf",
        name: "inline.pdf",
        url: "https://example.com/inline.pdf",
      }),
      "ask",
      "user123",
      undefined,
      "pro",
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.messages[0].parts[1]).toMatchObject({
      type: "file",
      mediaType: "application/pdf",
      url: "https://example.com/inline.pdf",
    });
  });

  it("stages oversized Agent images into the sandbox instead of sending them inline", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("Agent image with declared size should not be probed");
    }) as any;

    const result = await processMessageFiles(
      makeMessage({
        type: "file",
        fileId: "file_large",
        mediaType: "image/png",
        name: "large.png",
        size: 8 * 1024 * 1024,
        url: "https://example.com/large.png",
      }),
      "agent",
      "user123",
      "/home/user/upload",
      "pro",
    );

    expect(result.sandboxFiles).toEqual([
      {
        kind: "url",
        url: "https://example.com/large.png",
        localPath: "/home/user/upload/large.png",
      },
    ]);
    expect(result.messages[0].parts).toEqual([
      { type: "text", text: "what is this?" },
      {
        type: "text",
        text: '<attachment filename="large.png" local_path="/home/user/upload/large.png" />',
      },
    ]);
  });
});
