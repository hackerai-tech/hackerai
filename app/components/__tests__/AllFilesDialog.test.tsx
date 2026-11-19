import "@testing-library/jest-dom";
import {
  render,
  waitFor,
  act,
  screen,
  fireEvent,
} from "@testing-library/react";
import { useLayoutEffect, type ReactNode } from "react";
import {
  setMockConvexAuth,
  resetMockConvexAuth,
} from "@/__mocks__/convex-react";
import { useAction } from "convex/react";
import { FileUrlCacheProvider } from "@/app/contexts/FileUrlCacheContext";
import { AllFilesDialog } from "../AllFilesDialog";
import { toast } from "sonner";
import JSZip from "jszip";

jest.mock("@/convex/_generated/api", () => ({
  api: {
    s3Actions: {
      getFileUrlsBatchAction: "s3Actions.getFileUrlsBatchAction",
    },
  },
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
  },
}));

jest.mock("@/app/hooks/useTauri", () => ({
  isTauriEnvironment: jest.fn(() => false),
  openDownloadsFolder: jest.fn(),
}));

function CommitProbe({
  children,
  onCommit,
}: {
  children: ReactNode;
  onCommit: () => void;
}) {
  useLayoutEffect(onCommit);
  return children;
}

describe("AllFilesDialog", () => {
  let mockGetFileUrlsBatchAction: jest.Mock;
  let cache: Map<string, string>;

  beforeEach(() => {
    jest.clearAllMocks();
    resetMockConvexAuth();
    mockGetFileUrlsBatchAction = useAction({} as any) as unknown as jest.Mock;
    mockGetFileUrlsBatchAction.mockReset();
    cache = new Map();
  });

  afterEach(() => resetMockConvexAuth());

  function cachedDialog(
    files: React.ComponentProps<typeof AllFilesDialog>["files"],
  ) {
    return (
      <FileUrlCacheProvider
        getCachedUrl={(fileId) => cache.get(fileId) ?? null}
        setCachedUrl={(fileId, url) => cache.set(fileId, url)}
      >
        <AllFilesDialog
          open={true}
          onOpenChange={jest.fn()}
          files={files}
          chatTitle="Files"
        />
      </FileUrlCacheProvider>
    );
  }

  const renderWithCache = (
    files: React.ComponentProps<typeof AllFilesDialog>["files"],
  ) => render(cachedDialog(files));

  describe("download integrity", () => {
    const originalFetch = global.fetch;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    let saved: Blob[];
    let click: jest.SpyInstance;
    const files = ["a", "b"].map((name, index) => ({
      part: {
        fileId: name as any,
        name: `${name}.txt`,
        mediaType: "text/plain",
      },
      partIndex: index,
      messageId: "download-test",
    }));
    const response = (content: string, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      blob: async () => new Blob([content]),
    });
    async function bytes(blob: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = reject;
        reader.readAsArrayBuffer(blob);
      });
    }
    beforeEach(() => {
      saved = [];
      URL.createObjectURL = jest.fn((blob: Blob) => {
        saved.push(blob);
        return "blob:download-test";
      });
      URL.revokeObjectURL = jest.fn();
      click = jest
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(() => {});
      global.fetch = jest.fn();
      mockGetFileUrlsBatchAction.mockResolvedValue({
        a: "https://files.example/a",
        b: "https://files.example/b",
      });
    });
    afterEach(() => {
      global.fetch = originalFetch;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      click.mockRestore();
    });

    it("renews an expired cached URL instead of using the URL stored on the message", async () => {
      (fetch as jest.Mock).mockResolvedValue(response("fresh artifact"));
      renderWithCache([
        {
          ...files[0],
          part: {
            ...files[0].part,
            url: "https://files.example/expired-message-url",
          },
        },
      ]);
      const download = await screen.findByRole("button", {
        name: "Download file",
      });
      await waitFor(() =>
        expect(cache.get("a")).toBe("https://files.example/a"),
      );
      cache.clear();
      mockGetFileUrlsBatchAction.mockResolvedValue({
        a: "https://files.example/renewed",
      });
      fireEvent.click(download);
      await waitFor(() => expect(saved).toHaveLength(1));
      expect((fetch as jest.Mock).mock.calls[0][0]).toBe(
        "https://files.example/renewed",
      );
      expect(Buffer.from(await bytes(saved[0])).toString()).toBe(
        "fresh artifact",
      );
    });

    it("rejects a single HTTP error body and retries using the current cached URL", async () => {
      (fetch as jest.Mock)
        .mockResolvedValueOnce(response("PRIVATE error XML", 403))
        .mockResolvedValueOnce(response("actual file"));
      renderWithCache(files.slice(0, 1));
      fireEvent.click(
        await screen.findByRole("button", { name: "Download file" }),
      );
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(saved).toHaveLength(0);
      expect(toast.success).not.toHaveBeenCalled();
      cache.set("a", "https://files.example/fresh-a");
      fireEvent.click(screen.getByRole("button", { name: "Download file" }));
      await waitFor(() => expect(saved).toHaveLength(1));
      expect((fetch as jest.Mock).mock.calls[1][0]).toBe(
        "https://files.example/fresh-a",
      );
      expect(Buffer.from(await bytes(saved[0])).toString()).toBe("actual file");
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    });

    it("keeps a failed batch selected, then retries to an archive containing every file", async () => {
      let failed = true;
      (fetch as jest.Mock).mockImplementation(async (url: string) =>
        response(
          url.endsWith("/a") ? "alpha" : "beta",
          failed && url.endsWith("/b") ? 403 : 200,
        ),
      );
      renderWithCache(files);
      await screen.findAllByRole("button", { name: "Download file" });
      fireEvent.click(screen.getByRole("button", { name: "Download files" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Batch download (2)" }),
      );
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(saved).toHaveLength(0);
      expect(toast.success).not.toHaveBeenCalled();
      const retry = screen.getByRole("button", { name: "Batch download (2)" });
      await waitFor(() => expect(retry).toBeEnabled());
      failed = false;
      fireEvent.click(retry);
      await waitFor(() => expect(saved).toHaveLength(1));
      const zip = await JSZip.loadAsync(await bytes(saved[0]));
      expect(Object.keys(zip.files)).toEqual(["a.txt", "b.txt"]);
      expect(await zip.file("a.txt")!.async("string")).toBe("alpha");
      expect(await zip.file("b.txt")!.async("string")).toBe("beta");
      expect(
        screen.queryByRole("button", { name: "Batch download (2)" }),
      ).not.toBeInTheDocument();
    });

    it("does not silently omit a selected file whose URL cannot be resolved", async () => {
      mockGetFileUrlsBatchAction.mockResolvedValue({
        a: "https://files.example/a",
      });
      (fetch as jest.Mock).mockResolvedValue(response("alpha"));
      renderWithCache(files);
      await screen.findByRole("button", { name: "Download file" });
      fireEvent.click(screen.getByRole("button", { name: "Download files" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Batch download (2)" }),
      );
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(saved).toHaveLength(0);
      expect(
        screen.getByRole("button", { name: "Batch download (2)" }),
      ).toBeInTheDocument();
    });

    it("preserves every file when selected names collide", async () => {
      (fetch as jest.Mock).mockImplementation(async (url: string) =>
        response(url.endsWith("/a") ? "alpha" : "beta"),
      );
      renderWithCache(
        files.map((file) => ({
          ...file,
          part: { ...file.part, name: "report.txt" },
        })),
      );
      await screen.findAllByRole("button", { name: "Download file" });
      fireEvent.click(screen.getByRole("button", { name: "Download files" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Batch download (2)" }),
      );
      await waitFor(() => expect(saved).toHaveLength(1));
      const zip = await JSZip.loadAsync(await bytes(saved[0]));
      expect(Object.keys(zip.files)).toHaveLength(2);
      expect(
        await Promise.all(
          Object.values(zip.files).map((file) => file.async("string")),
        ),
      ).toEqual(["alpha", "beta"]);
    });

    it("does not save a pending download after authentication is lost", async () => {
      let finish!: (value: ReturnType<typeof response>) => void;
      (fetch as jest.Mock).mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const view = renderWithCache(files.slice(0, 1));
      fireEvent.click(
        await screen.findByRole("button", { name: "Download file" }),
      );
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      setMockConvexAuth({ isAuthenticated: false });
      view.rerender(cachedDialog(files.slice(0, 1)));
      await act(async () => finish(response("private artifact")));
      expect(saved).toHaveLength(0);
    });
  });

  it("fetches dialog file URLs in 50-file batches instead of per-file actions", async () => {
    mockGetFileUrlsBatchAction.mockImplementation(
      async ({ fileIds }: { fileIds: string[] }) => {
        return Object.fromEntries(
          fileIds.map((fileId) => [fileId, `https://files.example/${fileId}`]),
        );
      },
    );

    const files = Array.from({ length: 51 }, (_, index) => {
      const fileId = `file-${index}`;
      return {
        part: {
          fileId: fileId as any,
          name: `${fileId}.txt`,
          mediaType: "text/plain",
          s3Key: `uploads/${fileId}.txt`,
        },
        partIndex: index,
        messageId: "message-1",
      };
    });

    renderWithCache(files);

    await waitFor(() => {
      expect(mockGetFileUrlsBatchAction).toHaveBeenCalledTimes(2);
      expect(cache.size).toBe(51);
    });

    expect(mockGetFileUrlsBatchAction.mock.calls[0][0].fileIds).toHaveLength(
      50,
    );
    expect(mockGetFileUrlsBatchAction.mock.calls[1][0].fileIds).toEqual([
      "file-50",
    ]);
  });

  it("does not request URLs before authentication and resumes when ready", async () => {
    setMockConvexAuth({ isAuthenticated: false, isLoading: true });
    mockGetFileUrlsBatchAction.mockResolvedValue({
      "file-0": "https://files.example/0",
    });
    const files = [
      {
        part: {
          fileId: "file-0" as any,
          name: "image.png",
          mediaType: "image/png",
          s3Key: "uploads/image",
        },
        partIndex: 0,
        messageId: "message",
      },
    ];
    const view = renderWithCache(files);
    expect(mockGetFileUrlsBatchAction).not.toHaveBeenCalled();
    setMockConvexAuth({ isAuthenticated: true, isLoading: false });
    view.rerender(cachedDialog(files));
    await waitFor(() =>
      expect(cache.get("file-0")).toBe("https://files.example/0"),
    );
  });

  it("stops remaining dialog batches and discards their late URLs after auth loss", async () => {
    let finish!: (urls: Record<string, string>) => void;
    mockGetFileUrlsBatchAction.mockReturnValue(
      new Promise((r) => {
        finish = r;
      }),
    );
    const files = Array.from({ length: 51 }, (_, i) => ({
      part: {
        fileId: `file-${i}` as any,
        name: `file-${i}.txt`,
        mediaType: "text/plain",
        s3Key: `uploads/${i}`,
      },
      partIndex: i,
      messageId: "message",
    }));
    const view = renderWithCache(files);
    expect(mockGetFileUrlsBatchAction).toHaveBeenCalledTimes(1);
    setMockConvexAuth({ isAuthenticated: false });
    view.rerender(cachedDialog(files));
    await act(async () => finish({ "file-0": "https://files.example/late" }));
    expect(mockGetFileUrlsBatchAction).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
  });

  it("does not expose old download URLs in the reauthenticated commit before effects run", async () => {
    let finishNew!: (urls: Record<string, string>) => void;
    mockGetFileUrlsBatchAction
      .mockResolvedValueOnce({ "file-0": "https://files.example/old" })
      .mockReturnValueOnce(
        new Promise((r) => {
          finishNew = r;
        }),
      );
    const files = [
      {
        part: {
          fileId: "file-0" as any,
          name: "file.txt",
          mediaType: "text/plain",
          s3Key: "uploads/file",
        },
        partIndex: 0,
        messageId: "message",
      },
    ];
    const commits: boolean[] = [];
    const element = () => (
      <CommitProbe
        onCommit={() => {
          commits.push(
            Boolean(screen.queryByRole("button", { name: "Download file" })),
          );
        }}
      >
        {cachedDialog(files)}
      </CommitProbe>
    );
    const view = render(element());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Download file" }),
      ).toBeInTheDocument(),
    );
    setMockConvexAuth({ isAuthenticated: false });
    view.rerender(element());
    // The real message cache clears on auth loss; isolate the dialog's own URL state.
    cache.clear();
    commits.length = 0;
    setMockConvexAuth({ isAuthenticated: true });
    view.rerender(element());
    expect(commits.length).toBeGreaterThan(0);
    expect(commits).not.toContain(true);
    await act(async () =>
      finishNew({ "file-0": "https://files.example/current" }),
    );
    expect(
      screen.getByRole("button", { name: "Download file" }),
    ).toBeInTheDocument();
  });
});
