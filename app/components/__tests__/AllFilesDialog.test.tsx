import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAction } from "convex/react";
import { FileUrlCacheProvider } from "@/app/contexts/FileUrlCacheContext";
import { AllFilesDialog } from "../AllFilesDialog";
import { toast } from "sonner";

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

describe("AllFilesDialog", () => {
  let mockGetFileUrlsBatchAction: jest.Mock;
  let cache: Map<string, string>;
  const originalFetch = global.fetch;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;

  beforeEach(() => {
    mockGetFileUrlsBatchAction = useAction({} as any) as unknown as jest.Mock;
    mockGetFileUrlsBatchAction.mockReset();
    cache = new Map();
    global.fetch = jest.fn() as unknown as typeof fetch;
    URL.createObjectURL = jest.fn(() => "blob:zip-url");
    URL.revokeObjectURL = jest.fn();
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    jest.restoreAllMocks();
  });

  function renderWithCache(
    files: React.ComponentProps<typeof AllFilesDialog>["files"],
  ) {
    return render(
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
      </FileUrlCacheProvider>,
    );
  }

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

  it("reports only files successfully added to the ZIP", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        blob: async () => new Blob(["ok"]),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        blob: async () => new Blob(["missing"]),
      });

    renderWithCache([
      {
        part: {
          url: "https://files.example/file-1",
          name: "file-1.txt",
          mediaType: "text/plain",
        },
        partIndex: 0,
        messageId: "message-1",
      },
      {
        part: {
          url: "https://files.example/file-2",
          name: "file-2.txt",
          mediaType: "text/plain",
        },
        partIndex: 1,
        messageId: "message-1",
      },
    ]);

    await waitFor(() => {
      expect(screen.queryByText("Loading files...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Download files" }));
    fireEvent.click(screen.getByRole("button", { name: /Batch download/ }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        "Downloaded 1 files as Files.zip",
      );
    });
    expect(toast.success).not.toHaveBeenCalledWith(
      "Downloaded 2 files as Files.zip",
    );
  });

  it("shows an error instead of downloading an empty ZIP when every file fails", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      blob: async () => new Blob(["error"]),
    });

    renderWithCache([
      {
        part: {
          url: "https://files.example/file-1",
          name: "file-1.txt",
          mediaType: "text/plain",
        },
        partIndex: 0,
        messageId: "message-1",
      },
    ]);

    await waitFor(() => {
      expect(screen.queryByText("Loading files...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Download files" }));
    fireEvent.click(screen.getByRole("button", { name: /Batch download/ }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "No selected files could be downloaded",
      );
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
