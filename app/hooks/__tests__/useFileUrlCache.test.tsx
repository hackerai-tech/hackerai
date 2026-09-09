import { act, renderHook, waitFor } from "@testing-library/react";
import type { ChatMessage } from "@/types";
import { useFileUrlCache } from "../useFileUrlCache";

const mockFetch = jest.fn();
jest.mock("convex/react", () => ({ useAction: () => mockFetch }));
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

describe("image URL prefetching", () => {
  beforeEach(() => mockFetch.mockReset());

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
