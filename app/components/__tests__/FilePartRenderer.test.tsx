import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { useAction } from "convex/react";
import type { ComponentProps } from "react";
import { FileUrlCacheProvider } from "@/app/contexts/FileUrlCacheContext";
import { useFileUrlCache } from "@/app/hooks/useFileUrlCache";
import { startBlobDownload } from "@/lib/utils/file-download";
import { FilePartRenderer } from "../FilePartRenderer";

jest.mock("@/lib/utils/file-download", () => ({
  startBlobDownload: jest.fn(),
}));

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ alt, src, ...props }: any) => {
    const React = require("react");
    return React.createElement("img", { alt, src, ...props });
  },
}));

describe("FilePartRenderer", () => {
  let mockGetFileUrlAction: jest.Mock;
  let cache: Map<string, string>;

  beforeEach(() => {
    mockGetFileUrlAction = useAction({} as any) as unknown as jest.Mock;
    mockGetFileUrlAction.mockReset();
    cache = new Map();
  });

  function renderWithCache(
    part: ComponentProps<typeof FilePartRenderer>["part"],
  ) {
    return render(
      <FileUrlCacheProvider
        getCachedUrl={(fileId) => cache.get(fileId) ?? null}
        setCachedUrl={(fileId, url) => cache.set(fileId, url)}
      >
        <FilePartRenderer
          part={part}
          partIndex={0}
          messageId="message-1"
          totalFileParts={1}
        />
      </FileUrlCacheProvider>,
    );
  }

  it("shows a loading image tile instead of a transient unavailable error while fetching a file URL", async () => {
    let resolveUrl: (url: string) => void = () => {};
    mockGetFileUrlAction.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveUrl = resolve;
      }),
    );

    renderWithCache({
      fileId: "file-1" as any,
      name: "screenshot.png",
      mediaType: "image/png",
      s3Key: "uploads/screenshot.png",
    });

    expect(
      screen.queryByText("Image URL not available"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Loading screenshot.png" }),
    ).toBeInTheDocument();

    await act(async () => {
      resolveUrl("https://files.example/screenshot.png");
    });

    expect(await screen.findByAltText("screenshot.png")).toHaveAttribute(
      "src",
      "https://files.example/screenshot.png",
    );
    expect(cache.get("file-1")).toBe("https://files.example/screenshot.png");
  });

  describe("document downloads", () => {
    const originalFetch = global.fetch;
    const oldUrl = "https://files.example/old-signed-url";
    const freshUrl = "https://files.example/fresh-signed-url";
    const part = {
      fileId: "file-1" as NonNullable<
        ComponentProps<typeof FilePartRenderer>["part"]["fileId"]
      >,
      name: "report.txt",
      mediaType: "text/plain",
      url: oldUrl,
    };
    const blob = new Blob(["download fixture"]);
    let fetchMock: jest.Mock;

    beforeEach(() => {
      fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: true, blob: async () => blob });
      global.fetch = fetchMock;
      jest.mocked(startBlobDownload).mockClear();
      mockGetFileUrlAction.mockResolvedValue(freshUrl);
    });

    afterEach(() => {
      global.fetch = originalFetch;
      jest.restoreAllMocks();
    });

    async function clickDownload() {
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Download report.txt" }),
        );
      });
    }

    it("refreshes an expired URL without remounting, then reuses the refreshed cache", async () => {
      const now = jest.spyOn(Date, "now").mockReturnValue(1_000);
      const { result } = renderHook(() => useFileUrlCache([]));
      result.current.setCachedUrl("file-1", oldUrl);
      render(
        <FileUrlCacheProvider {...result.current}>
          <FilePartRenderer part={part} partIndex={0} messageId="message-1" />
        </FileUrlCacheProvider>,
      );
      now.mockReturnValue(1_000 + 51 * 60 * 1_000);

      await clickDownload();

      expect(mockGetFileUrlAction).toHaveBeenCalledWith({ fileId: "file-1" });
      expect(fetchMock).toHaveBeenCalledWith(freshUrl);
      expect(fetchMock).not.toHaveBeenCalledWith(oldUrl);
      expect(startBlobDownload).toHaveBeenCalledWith(blob, "report.txt");
      expect(result.current.getCachedUrl("file-1")).toBe(freshUrl);

      mockGetFileUrlAction.mockClear();
      await clickDownload();
      expect(mockGetFileUrlAction).not.toHaveBeenCalled();
      expect(startBlobDownload).toHaveBeenCalledTimes(2);
    });

    it("prefers a current cached URL over the URL stored on the attachment", async () => {
      cache.set("file-1", freshUrl);
      renderWithCache(part);
      await clickDownload();
      expect(mockGetFileUrlAction).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(freshUrl);
    });

    it("resolves file IDs on each click when no cache provider is available", async () => {
      render(
        <FilePartRenderer part={part} partIndex={0} messageId="message-1" />,
      );
      await clickDownload();
      mockGetFileUrlAction.mockResolvedValue("https://files.example/newer-url");
      await clickDownload();
      expect(fetchMock).toHaveBeenLastCalledWith(
        "https://files.example/newer-url",
      );
      expect(fetchMock).not.toHaveBeenCalledWith(oldUrl);
    });

    it("downloads a direct URL when the attachment has no file ID", async () => {
      renderWithCache({ ...part, fileId: undefined });
      await clickDownload();
      expect(mockGetFileUrlAction).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(oldUrl);
      expect(startBlobDownload).toHaveBeenCalledWith(blob, "report.txt");
    });

    it("shows an unavailable error instead of downloading a stale fallback URL", async () => {
      mockGetFileUrlAction.mockResolvedValue(null);
      renderWithCache(part);
      await clickDownload();
      expect(
        screen.getByText("Failed to get download URL"),
      ).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(startBlobDownload).not.toHaveBeenCalled();
    });
  });
});
