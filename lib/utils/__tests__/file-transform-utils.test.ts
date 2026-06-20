import { processMessageFiles } from "../file-transform-utils";

jest.mock("server-only", () => ({}));
const mockConvexAction = jest.fn();
const mockConvexQuery = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: jest.fn(() => ({
    action: mockConvexAction,
    query: mockConvexQuery,
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

const VALID_PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
    "base64",
  ),
);

const MINIMAL_JPEG_BYTES = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01,
  0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xda, 0x00, 0x0c, 0x03,
  0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0x00, 0xff, 0xd9,
]);

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

const fileUrlInfo = (
  url: string,
  overrides: Partial<{
    sizeBytes: number;
    mediaType: string;
    name: string;
  }> = {},
) => ({
  url,
  sizeBytes: overrides.sizeBytes ?? 2 * 1024 * 1024,
  mediaType: overrides.mediaType ?? "image/png",
  name: overrides.name ?? "image.png",
});

describe("processMessageFiles image size guards", () => {
  const originalFetch = global.fetch;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockConvexAction.mockResolvedValue([]);
    mockConvexQuery.mockResolvedValue([]);
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    consoleWarnSpy.mockRestore();
  });

  it("omits stored images when trusted file size is over the provider download limit", async () => {
    mockConvexAction.mockResolvedValue([
      fileUrlInfo("https://storage.example/huge.png", {
        sizeBytes: 40 * 1024 * 1024,
        name: "huge.png",
      }),
    ]);
    global.fetch = jest.fn(async () => {
      throw new Error("Trusted file size should avoid network probes");
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

  it("omits images when trusted file size exceeds stale message metadata", async () => {
    mockConvexAction.mockResolvedValue([
      fileUrlInfo("https://storage.example/stale-metadata.png", {
        sizeBytes: 40 * 1024 * 1024,
        name: "stale-metadata.png",
      }),
    ]);
    global.fetch = jest.fn(async () => {
      throw new Error("Trusted file size should avoid network probes");
    }) as any;

    const result = await processMessageFiles(
      makeMessage({
        type: "file",
        mediaType: "image/png",
        fileId: "file_stale",
        name: "stale-metadata.png",
        size: 1024,
        url: "https://example.com/stale-metadata.png",
      }),
      "ask",
      "user123",
      undefined,
      "pro",
    );

    expect(result.messages[0].parts[1]).toEqual({
      type: "text",
      text: '[Image "stale-metadata.png" omitted: 40.0 MB exceeds the 30 MB per-image limit]',
    });
  });

  it("keeps stored images when resolved storage size is within limit despite stale oversized metadata", async () => {
    mockConvexAction.mockResolvedValue([
      fileUrlInfo("https://storage.example/actually-small.png", {
        sizeBytes: 2 * 1024 * 1024,
        name: "actually-small.png",
      }),
    ]);
    global.fetch = jest.fn(async () => {
      return responseLike({
        headers: { "content-length": String(VALID_PNG_BYTES.byteLength) },
        body: streamBody(VALID_PNG_BYTES),
      });
    }) as any;

    const result = await processMessageFiles(
      makeMessage({
        type: "file",
        mediaType: "image/png",
        fileId: "file_actually_small",
        name: "actually-small.png",
        size: 40 * 1024 * 1024,
        url: "https://example.com/actually-small.png",
      }),
      "ask",
      "user123",
      undefined,
      "pro",
    );

    expect(result.messages[0].parts[1]).toMatchObject({
      type: "file",
      mediaType: "image/png",
      name: "actually-small.png",
      url: "https://storage.example/actually-small.png",
    });
  });

  it("omits URL-backed images when headers are inconclusive but the range probe exceeds 5 MB", async () => {
    mockConvexAction.mockResolvedValue([
      {
        url: "https://storage.example/unknown-size.png",
        mediaType: "image/png",
        name: "unknown-size.png",
      },
    ]);
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

  it("omits stored images when trusted size is missing and probing is inconclusive", async () => {
    mockConvexAction.mockResolvedValue([
      {
        url: "https://storage.example/no-size.png",
        mediaType: "image/png",
        name: "no-size.png",
      },
    ]);
    global.fetch = jest.fn(async (_url, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return responseLike({});
      }

      return responseLike({ status: 200 });
    }) as any;

    const result = await processMessageFiles(
      makeMessage({
        type: "file",
        mediaType: "image/png",
        fileId: "file_no_size",
        name: "no-size.png",
        url: "https://example.com/no-size.png",
      }),
      "ask",
      "user123",
      undefined,
      "pro",
    );

    expect(JSON.stringify(result.messages)).not.toContain(
      "https://storage.example/no-size.png",
    );
    expect(result.messages[0].parts[1]).toEqual({
      type: "text",
      text: '[Image "no-size.png" omitted: could not verify the image size before sending it to the model. Please reattach a smaller image or use Agent mode for large images.]',
    });
  });

  it("keeps stored images when trusted file size is within the image limit", async () => {
    mockConvexAction.mockResolvedValue([
      fileUrlInfo("https://storage.example/small.png", {
        sizeBytes: 2 * 1024 * 1024,
        name: "small.png",
      }),
    ]);
    global.fetch = jest.fn(async () => {
      return responseLike({
        headers: { "content-length": String(VALID_PNG_BYTES.byteLength) },
        body: streamBody(VALID_PNG_BYTES),
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
      url: "https://storage.example/small.png",
    });
  });

  it("omits stored images whose storage URL does not return valid image bytes", async () => {
    const notImageBytes = new TextEncoder().encode("<html>not an image</html>");
    mockConvexAction.mockResolvedValue([
      fileUrlInfo("https://storage.example/not-image.png", {
        sizeBytes: notImageBytes.byteLength,
        name: "not-image.png",
      }),
    ]);
    global.fetch = jest.fn(async () => {
      return responseLike({
        headers: { "content-length": String(notImageBytes.byteLength) },
        body: streamBody(notImageBytes),
      });
    }) as any;

    const result = await processMessageFiles(
      makeMessage({
        type: "file",
        mediaType: "image/png",
        fileId: "file_not_image",
        name: "not-image.png",
      }),
      "ask",
      "user123",
      undefined,
      "pro",
    );

    expect(JSON.stringify(result.messages)).not.toContain(
      "https://storage.example/not-image.png",
    );
    expect(result.messages[0].parts[1]).toEqual({
      type: "text",
      text: '[Image "not-image.png" omitted: could not verify valid image bytes before sending it to the model. Please reattach or regenerate the image.]',
    });
  });

  it("omits non-streaming image responses without a content length before reading bytes", async () => {
    const arrayBuffer = jest.fn(async () => VALID_PNG_BYTES.buffer);
    mockConvexAction.mockResolvedValue([
      fileUrlInfo("https://storage.example/no-length.png", {
        name: "no-length.png",
      }),
    ]);
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: {
        get: () => null,
      },
      body: null,
      arrayBuffer,
    })) as any;

    const result = await processMessageFiles(
      makeMessage({
        type: "file",
        mediaType: "image/png",
        fileId: "file_no_length",
        name: "no-length.png",
      }),
      "ask",
      "user123",
      undefined,
      "pro",
    );

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(result.messages[0].parts[1]).toEqual({
      type: "text",
      text: '[Image "no-length.png" omitted: could not verify valid image bytes before sending it to the model. Please reattach or regenerate the image.]',
    });
  });

  it("corrects stored image media type when storage bytes disagree with stale metadata", async () => {
    mockConvexAction.mockResolvedValue([
      fileUrlInfo("https://storage.example/photo.jpg", {
        sizeBytes: MINIMAL_JPEG_BYTES.byteLength,
        mediaType: "image/png",
        name: "photo.jpg",
      }),
    ]);
    global.fetch = jest.fn(async () => {
      return responseLike({
        headers: { "content-length": String(MINIMAL_JPEG_BYTES.byteLength) },
        body: streamBody(MINIMAL_JPEG_BYTES),
      });
    }) as any;

    const result = await processMessageFiles(
      makeMessage({
        type: "file",
        mediaType: "image/png",
        fileId: "file_jpeg",
        name: "photo.jpg",
      }),
      "ask",
      "user123",
      undefined,
      "pro",
    );

    expect(result.messages[0].parts[1]).toMatchObject({
      type: "file",
      mediaType: "image/jpeg",
      url: "https://storage.example/photo.jpg",
    });
  });

  it("stages invalid Agent images into the sandbox without sending them inline to the provider", async () => {
    const notImageBytes = new TextEncoder().encode("not a png");
    mockConvexAction.mockResolvedValue([
      fileUrlInfo("https://storage.example/broken.png", {
        sizeBytes: notImageBytes.byteLength,
        name: "broken.png",
      }),
    ]);
    global.fetch = jest.fn(async () => {
      return responseLike({
        headers: { "content-length": String(notImageBytes.byteLength) },
        body: streamBody(notImageBytes),
      });
    }) as any;

    const result = await processMessageFiles(
      makeMessage({
        type: "file",
        fileId: "file_broken",
        mediaType: "image/png",
        name: "broken.png",
      }),
      "agent",
      "user123",
      "/home/user/upload",
      "pro",
    );

    expect(result.sandboxFiles).toEqual([
      {
        kind: "url",
        url: "https://storage.example/broken.png",
        localPath: "/home/user/upload/broken.png",
      },
    ]);
    expect(result.messages[0].parts).toEqual([
      { type: "text", text: "what is this?" },
      {
        type: "text",
        text: '<attachment filename="broken.png" local_path="/home/user/upload/broken.png" />',
      },
    ]);
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

  it("omits inline URL image file parts without fileId before provider use", async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    const result = await processMessageFiles(
      makeMessage({
        type: "file",
        mediaType: "image/png",
        name: "legacy-huge.png",
        url: "https://example.com/legacy-huge.png",
      }),
      "ask",
      "user123",
      undefined,
      "pro",
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(result.messages)).not.toContain(
      "https://example.com/legacy-huge.png",
    );
    expect(result.messages[0].parts[1]).toEqual({
      type: "text",
      text: '[Image "legacy-huge.png" omitted: URL-backed image attachments must be reattached before they can be sent to the model]',
    });
  });

  it("stages oversized Agent images into the sandbox instead of sending them inline", async () => {
    mockConvexAction.mockResolvedValue([
      fileUrlInfo("https://storage.example/large.png", {
        sizeBytes: 8 * 1024 * 1024,
        name: "large.png",
      }),
    ]);
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
        url: "https://storage.example/large.png",
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

  it("does not stage a client-supplied URL when storage resolution fails", async () => {
    mockConvexAction.mockResolvedValue([null]);

    const result = await processMessageFiles(
      makeMessage({
        type: "file",
        fileId: "file_unowned",
        mediaType: "text/plain",
        name: "notes.txt",
        size: 100,
        url: "http://169.254.169.254/latest/meta-data",
      }),
      "agent",
      "user123",
      "/home/user/upload",
      "pro",
    );

    expect(result.sandboxFiles).toEqual([]);
    expect(JSON.stringify(result.messages)).not.toContain("169.254.169.254");
  });

  it("fetches ask-mode PDFs from the storage-resolved URL, not the client URL", async () => {
    mockConvexAction.mockResolvedValue([
      fileUrlInfo("https://storage.example/trusted.pdf", {
        sizeBytes: 100,
        mediaType: "application/pdf",
        name: "trusted.pdf",
      }),
    ]);
    const fetchSpy = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }));
    global.fetch = fetchSpy as any;

    const result = await processMessageFiles(
      makeMessage({
        type: "file",
        fileId: "file_pdf",
        mediaType: "application/pdf",
        name: "trusted.pdf",
        size: 100,
        url: "http://169.254.169.254/latest/meta-data",
      }),
      "ask",
      "user123",
      undefined,
      "pro",
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://storage.example/trusted.pdf",
      expect.any(Object),
    );
    expect(
      fetchSpy.mock.calls.some(([url]) =>
        String(url).includes("169.254.169.254"),
      ),
    ).toBe(false);
    expect(result.messages[0].parts[1]).toMatchObject({
      type: "file",
      url: "data:application/pdf;base64,AQID",
    });
  });

  it("strips client URLs from stored ask-mode non-media file parts", async () => {
    mockConvexQuery.mockResolvedValue([]);

    const result = await processMessageFiles(
      makeMessage({
        type: "file",
        fileId: "file_text",
        mediaType: "text/plain",
        name: "notes.txt",
        size: 100,
        url: "http://169.254.169.254/latest/meta-data",
      }),
      "ask",
      "user123",
      undefined,
      "pro",
    );

    expect(JSON.stringify(result.messages)).not.toContain("169.254.169.254");
    expect(result.messages[0].parts).toEqual([
      { type: "text", text: "what is this?" },
    ]);
  });
});
