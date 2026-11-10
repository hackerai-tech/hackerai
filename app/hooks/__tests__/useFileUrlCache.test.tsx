import { act, renderHook, waitFor } from "@testing-library/react";
import type { ChatMessage } from "@/types";
import { useFileUrlCache } from "../useFileUrlCache";

const mockFetch = jest.fn();
let mockAuth: {
  isAuthenticated: boolean;
  isLoading: boolean;
  isRefreshing?: boolean;
} = { isAuthenticated: true, isLoading: false };
jest.mock("convex/react", () => ({
  useAction: () => mockFetch,
  useConvexAuth: () => mockAuth,
}));
jest.mock("@/convex/_generated/api", () => ({
  api: { s3Actions: { getFileUrlsBatchAction: "get-urls" } },
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

describe("signed URL cache lifetime", () => {
  const receivedAt = Date.parse("2026-10-29T12:00:00Z");

  beforeEach(() => {
    mockFetch.mockReset();
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
      expect(mockFetch).not.toHaveBeenCalled();
      mockAuth = { isAuthenticated: true, isLoading: false };
      rerender({ messages: images(1) });
      await waitFor(() =>
        expect(result.current.getCachedUrl("file-0")).toBe(
          "https://example.com/image",
        ),
      );
    },
  );

  it("pauses reads while an authenticated session refreshes its rejected token", () => {
    mockAuth = { isAuthenticated: true, isLoading: false, isRefreshing: true };
    const { rerender } = renderHook(
      ({ messages }) => useFileUrlCache(messages),
      { initialProps: { messages: images(1) } },
    );
    rerender({ messages: images(2) });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("releases abandoned pending IDs during StrictMode effect replay", async () => {
    let finishOld!: (urls: Record<string, string>) => void;
    mockFetch
      .mockReturnValueOnce(
        new Promise((r) => {
          finishOld = r;
        }),
      )
      .mockResolvedValue({ "file-0": "https://example.com/current" });
    const { result } = renderHook(() => useFileUrlCache(images(1)), {
      reactStrictMode: true,
    });
    await waitFor(() =>
      expect(result.current.getCachedUrl("file-0")).toBe(
        "https://example.com/current",
      ),
    );
    await act(async () =>
      finishOld({ "file-0": "https://example.com/abandoned" }),
    );
    expect(result.current.getCachedUrl("file-0")).toBe(
      "https://example.com/current",
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("discards an old auth scope without releasing the new scope's pending IDs", async () => {
    let finishOld!: (urls: Record<string, string>) => void;
    let finishNew!: (urls: Record<string, string>) => void;
    mockFetch
      .mockReturnValueOnce(
        new Promise((r) => {
          finishOld = r;
        }),
      )
      .mockReturnValueOnce(
        new Promise((r) => {
          finishNew = r;
        }),
      )
      .mockImplementation(async ({ fileIds }: { fileIds: string[] }) =>
        Object.fromEntries(
          fileIds.map((id) => [id, `https://example.com/new/${id}`]),
        ),
      );
    const { result, rerender } = renderHook(
      ({ messages }) => useFileUrlCache(messages),
      { initialProps: { messages: images(101) } },
    );
    mockAuth = { isAuthenticated: false, isLoading: false };
    rerender({ messages: images(101) });
    mockAuth = { isAuthenticated: true, isLoading: false };
    rerender({ messages: images(101) });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await act(async () => finishOld({ "file-0": "https://example.com/old" }));
    expect(result.current.getCachedUrl("file-0")).toBeNull();
    rerender({ messages: images(101) });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await act(async () => finishNew({ "file-0": "https://example.com/new" }));
    await waitFor(() =>
      expect(result.current.getCachedUrl("file-100")).toBe(
        "https://example.com/new/file-100",
      ),
    );
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(result.current.getCachedUrl("file-0")).toBe(
      "https://example.com/new",
    );
  });

  it.each([false, true])(
    "queues newly arriving IDs behind a pending request (first fails: %s)",
    async (firstFails) => {
      let finish!: () => void;
      mockFetch
        .mockReturnValueOnce(
          new Promise((resolve, reject) => {
            finish = () =>
              firstFails
                ? reject(new Error("temporary failure"))
                : resolve({ "file-0": "https://example.com/0" });
          }),
        )
        .mockImplementation(async ({ fileIds }: { fileIds: string[] }) =>
          Object.fromEntries(
            fileIds.map((id) => [id, `https://example.com/${id}`]),
          ),
        );
      const log = jest.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { result, rerender } = renderHook(
          ({ messages }) => useFileUrlCache(messages),
          { initialProps: { messages: images(1) } },
        );
        await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
        for (const count of [2, 3, 3, 3]) {
          await act(async () => rerender({ messages: images(count) }));
        }
        expect(mockFetch).toHaveBeenCalledTimes(1);
        await act(async () => finish());
        await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
        expect(mockFetch.mock.calls.map(([args]) => args.fileIds)).toEqual([
          ["file-0"],
          ["file-1"],
          ["file-2"],
        ]);
        expect(result.current.getCachedUrl("file-2")).toBe(
          "https://example.com/file-2",
        );
      } finally {
        log.mockRestore();
      }
    },
  );

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
    for (let i = 0; i < 50; i++) rerender({ messages: images(1) });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ "file-0": "https://example.com/image" }));
    expect(result.current.getCachedUrl("file-0")).toBe(
      "https://example.com/image",
    );
    rerender({ messages: images(1) });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("reserves queued batches and retains successful results when another batch fails", async () => {
    let resolve!: (value: Record<string, string>) => void;
    mockFetch
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve = r;
        }),
      )
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ "file-100": "https://example.com/last" });
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { result, rerender } = renderHook(
        ({ messages }) => useFileUrlCache(messages),
        { initialProps: { messages: images(101) } },
      );
      rerender({ messages: images(101) });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await act(async () =>
        resolve(
          Object.fromEntries(
            Array.from({ length: 50 }, (_, i) => [
              `file-${i}`,
              `https://example.com/${i}`,
            ]),
          ),
        ),
      );
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
      expect(mockFetch.mock.calls.map(([args]) => args.fileIds.length)).toEqual(
        [50, 50, 1],
      );
      expect(result.current.getCachedUrl("file-0")).toBe(
        "https://example.com/0",
      );
      expect(result.current.getCachedUrl("file-100")).toBe(
        "https://example.com/last",
      );
      expect(result.current.getCachedUrl("file-50")).toBeNull();
      mockFetch.mockResolvedValueOnce({
        "file-50": "https://example.com/retried",
      });
      rerender({ messages: images(101) });
      await waitFor(() =>
        expect(result.current.getCachedUrl("file-50")).toBe(
          "https://example.com/retried",
        ),
      );
      expect(mockFetch.mock.calls[3][0].fileIds).toHaveLength(50);
    } finally {
      log.mockRestore();
    }
  });
});
