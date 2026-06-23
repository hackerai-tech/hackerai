import "@testing-library/jest-dom";
import { render, waitFor } from "@testing-library/react";
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
    mockGetFileUrlsBatchAction = useAction({} as any) as unknown as jest.Mock;
    mockGetFileUrlsBatchAction.mockReset();
    cache = new Map();
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
    });

    expect(mockGetFileUrlsBatchAction.mock.calls[0][0].fileIds).toHaveLength(
      50,
    );
    expect(mockGetFileUrlsBatchAction.mock.calls[1][0].fileIds).toEqual([
      "file-50",
    ]);
    expect(cache.size).toBe(51);
  });
});
