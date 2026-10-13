import "@testing-library/jest-dom";
import { render, waitFor, act } from "@testing-library/react";
import {
  setMockConvexAuth,
  resetMockConvexAuth,
} from "@/__mocks__/convex-react";
import { useAction } from "convex/react";
import { FileUrlCacheProvider } from "@/app/contexts/FileUrlCacheContext";
import { AllFilesDialog } from "../AllFilesDialog";

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

  beforeEach(() => {
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
});
