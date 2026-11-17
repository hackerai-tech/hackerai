import { act, renderHook, waitFor } from "@testing-library/react";
import type { ChatMessage } from "@/types";
import { useFileUrlCache } from "../useFileUrlCache";

const mockFetch = jest.fn();
const mockFetchOne = jest.fn();
let mockAuth: {
  isAuthenticated: boolean;
  isLoading: boolean;
  isRefreshing?: boolean;
} = { isAuthenticated: true, isLoading: false };
jest.mock("convex/react", () => ({
  useAction: (reference: string) =>
    reference === "get-urls" ? mockFetch : mockFetchOne,
  useConvexAuth: () => mockAuth,
}));
jest.mock("@/convex/_generated/api", () => ({
  api: {
    s3Actions: {
      getFileUrlsBatchAction: "get-urls",
      getFileUrlAction: "get-url",
    },
  },
}));
jest.mock("@/lib/utils/file-utils", () => ({
  isSupportedImageMediaType: (type: string) => type === "image/png",
}));

function images(count: number): ChatMessage[] {
  return [
    {
      id: "msg",
      role: "user",
      parts: Array.from({ length: count }, (_, i) => ({
        type: "file",
        fileId: `file-${i}`,
        s3Key: `key-${i}`,
        mediaType: "image/png",
      })),
    },
  ] as unknown as ChatMessage[];
}

const urlsFor = ({ fileIds }: { fileIds: string[] }, prefix: string) =>
  Object.fromEntries(fileIds.map((id) => [id, `${prefix}/${id}`]));

/** Lets requests made in the same tick leave together. */
const flush = () => act(async () => {});

describe("signed URL cache lifetime", () => {
  const receivedAt = Date.parse("2026-10-29T12:00:00Z");

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetchOne.mockReset();
    mockAuth = { isAuthenticated: true, isLoading: false };
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    { query: "X-Amz-Expires=2400", minutes: 39 },
    { query: "X-Amz-Expires=3600", minutes: 50 },
    { query: "", minutes: 50 },
    { query: "X-Amz-Date=20261029T100000Z&X-Amz-Expires=2400", minutes: 39 },
  ])("expires at minute $minutes for $query", ({ query, minutes }) => {
    const now = jest.spyOn(Date, "now").mockReturnValue(receivedAt);
    const url = `https://files.example/object?${query}`;
    const { result } = renderHook(() => useFileUrlCache([]));
    result.current.setCachedUrl("file-0", url);
    now.mockReturnValue(receivedAt + minutes * 60_000 - 1);
    expect(result.current.getCachedUrl("file-0")).toBe(url);
    now.mockReturnValue(receivedAt + minutes * 60_000);
    expect(result.current.getCachedUrl("file-0")).toBeNull();
  });

  it("also expires prefetched image URLs and permits refetching them", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(receivedAt);
    const url = "https://files.example/image?X-Amz-Expires=2400";
    mockFetch.mockResolvedValue({ "file-0": url });
    const { result, rerender } = renderHook(
      ({ messages }) => useFileUrlCache(messages),
      { initialProps: { messages: images(1) } },
    );
    await waitFor(() =>
      expect(result.current.getCachedUrl("file-0")).toBe(url),
    );
    now.mockReturnValue(receivedAt + 39 * 60_000);
    expect(result.current.getCachedUrl("file-0")).toBeNull();
    mockFetch.mockResolvedValue({
      "file-0": "https://files.example/refreshed",
    });
    rerender({ messages: images(1) });
    await waitFor(() =>
      expect(result.current.getCachedUrl("file-0")).toBe(
        "https://files.example/refreshed",
      ),
    );
  });

  it.each(["abc", "0", "-1", "2400oops", "2400&X-Amz-Expires=3600", "60"])(
    "does not retain unusable or too-short signed lifetimes: %s",
    (lifetime) => {
      const { result } = renderHook(() => useFileUrlCache([]));
      result.current.setCachedUrl(
        "file-0",
        `https://files.example/object?X-Amz-Expires=${lifetime}`,
      );
      expect(result.current.getCachedUrl("file-0")).toBeNull();
    },
  );
});

describe("image URL prefetching", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetchOne.mockReset();
    mockAuth = { isAuthenticated: true, isLoading: false };
  });

  it.each([false, true])(
    "waits for authentication across streaming renders (loading: %s)",
    async (isLoading) => {
      mockAuth = { isAuthenticated: false, isLoading };
      mockFetch.mockResolvedValue({ "file-0": "https://example.com/image" });
      const { result, rerender } = renderHook(
        ({ messages }) => useFileUrlCache(messages),
        {
          initialProps: { messages: images(1) },
        },
      );
      for (let i = 0; i < 20; i++) rerender({ messages: images(1) });
      await flush();
      expect(mockFetch).not.toHaveBeenCalled();
      await expect(result.current.loadImageUrl("file-0")).rejects.toThrow(
        expect.objectContaining({ name: "AbortError" }),
      );
      mockAuth = { isAuthenticated: true, isLoading: false };
      rerender({ messages: images(1) });
      await waitFor(() =>
        expect(result.current.getCachedUrl("file-0")).toBe(
          "https://example.com/image",
        ),
      );
    },
  );

  it("pauses reads while an authenticated session refreshes its rejected token", async () => {
    mockAuth = { isAuthenticated: true, isLoading: false, isRefreshing: true };
    const { rerender } = renderHook(
      ({ messages }) => useFileUrlCache(messages),
      { initialProps: { messages: images(1) } },
    );
    rerender({ messages: images(2) });
    await flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("requests each image once under StrictMode effect replay", async () => {
    mockFetch.mockResolvedValue({ "file-0": "https://example.com/current" });
    const { result } = renderHook(() => useFileUrlCache(images(1)), {
      reactStrictMode: true,
    });
    await waitFor(() =>
      expect(result.current.getCachedUrl("file-0")).toBe(
        "https://example.com/current",
      ),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("discards an old auth scope's responses without releasing the new scope's requests", async () => {
    const held: Array<(urls: Record<string, string>) => void> = [];
    mockFetch.mockImplementation(
      () => new Promise((resolve) => held.push(resolve)),
    );
    const { result, rerender } = renderHook(
      ({ messages }) => useFileUrlCache(messages),
      { initialProps: { messages: images(101) } },
    );
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const old = mockFetch.mock.calls.map(([args]) => args);
    mockAuth = { isAuthenticated: false, isLoading: false };
    rerender({ messages: images(101) });
    mockAuth = { isAuthenticated: true, isLoading: false };
    rerender({ messages: images(101) });
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(6);

    await act(async () =>
      old.forEach((args, i) => held[i](urlsFor(args, "https://old"))),
    );
    expect(result.current.getCachedUrl("file-0")).toBeNull();
    rerender({ messages: images(101) });
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(6);

    await act(async () =>
      mockFetch.mock.calls
        .slice(3)
        .forEach(([args], i) => held[3 + i](urlsFor(args, "https://new"))),
    );
    expect(result.current.getCachedUrl("file-0")).toBe("https://new/file-0");
    expect(result.current.getCachedUrl("file-100")).toBe(
      "https://new/file-100",
    );
    expect(mockFetchOne).not.toHaveBeenCalled();
  });

  it("drops requests that have not left yet when authentication is lost", async () => {
    const { rerender } = renderHook(
      ({ messages }) => useFileUrlCache(messages),
      { initialProps: { messages: images(3) } },
    );
    mockAuth = { isAuthenticated: false, isLoading: false };
    rerender({ messages: images(3) });
    await flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends newly arriving IDs without waiting for a pending request", async () => {
    mockFetch
      .mockReturnValueOnce(new Promise(() => {}))
      .mockImplementation(async (args: { fileIds: string[] }) =>
        urlsFor(args, "https://example.com"),
      );
    const { result, rerender } = renderHook(
      ({ messages }) => useFileUrlCache(messages),
      { initialProps: { messages: images(1) } },
    );
    await flush();
    for (const count of [2, 3, 3, 3]) {
      rerender({ messages: images(count) });
      await flush();
    }
    expect(mockFetch.mock.calls.map(([args]) => args.fileIds)).toEqual([
      ["file-0"],
      ["file-1"],
      ["file-2"],
    ]);
    expect(result.current.getCachedUrl("file-2")).toBe(
      "https://example.com/file-2",
    );
    expect(result.current.getCachedUrl("file-0")).toBeNull();
  });

  it("deduplicates pending images across streaming updates", async () => {
    let resolve!: (value: Record<string, string>) => void;
    mockFetch.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { result, rerender } = renderHook(
      ({ messages }) => useFileUrlCache(messages),
      { initialProps: { messages: images(1) } },
    );
    await flush();
    for (let i = 0; i < 50; i++) rerender({ messages: images(1) });
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ "file-0": "https://example.com/image" }));
    expect(result.current.getCachedUrl("file-0")).toBe(
      "https://example.com/image",
    );
    rerender({ messages: images(1) });
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("splits large histories into batches of 50 and recovers a failed batch file by file", async () => {
    mockFetch
      .mockImplementationOnce(async (args: { fileIds: string[] }) =>
        urlsFor(args, "https://batch"),
      )
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockImplementationOnce(async (args: { fileIds: string[] }) =>
        urlsFor(args, "https://batch"),
      );
    mockFetchOne.mockImplementation(
      async ({ fileId }: { fileId: string }) => `https://single/${fileId}`,
    );
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { result, rerender } = renderHook(
        ({ messages }) => useFileUrlCache(messages),
        { initialProps: { messages: images(101) } },
      );
      await waitFor(() =>
        expect(result.current.getCachedUrl("file-99")).toBe(
          "https://single/file-99",
        ),
      );
      expect(mockFetch.mock.calls.map(([args]) => args.fileIds.length)).toEqual(
        [50, 50, 1],
      );
      expect(result.current.getCachedUrl("file-0")).toBe(
        "https://batch/file-0",
      );
      expect(result.current.getCachedUrl("file-100")).toBe(
        "https://batch/file-100",
      );
      expect(mockFetchOne.mock.calls.map(([args]) => args.fileId)).toEqual(
        Array.from({ length: 50 }, (_, i) => `file-${50 + i}`),
      );
      rerender({ messages: images(101) });
      await flush();
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetchOne).toHaveBeenCalledTimes(50);
    } finally {
      log.mockRestore();
    }
  });

  it("prefetches uploaded images that carry only a file ID, but not local Desktop files", async () => {
    mockFetch.mockImplementation(async (args: { fileIds: string[] }) =>
      urlsFor(args, "https://example.com"),
    );
    const messages = [
      {
        id: "msg",
        role: "user",
        parts: [
          { type: "file", fileId: "upload", mediaType: "image/png" },
          {
            type: "file",
            fileId: "local",
            storage: "local-desktop",
            mediaType: "image/png",
          },
        ],
      },
    ] as unknown as ChatMessage[];
    renderHook(() => useFileUrlCache(messages));
    await flush();
    expect(mockFetch.mock.calls.map(([args]) => args.fileIds)).toEqual([
      ["upload"],
    ]);
  });
});
