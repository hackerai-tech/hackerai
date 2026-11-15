import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { FileUrlCacheProvider } from "@/app/contexts/FileUrlCacheContext";
import { toSandboxAttachmentHref } from "@/lib/chat/sandbox-attachment-links";
import { startBlobDownload } from "@/lib/utils/file-download";
import type { FileDetails } from "@/types/file";
import {
  SandboxAttachmentContext,
  SandboxAttachmentLink,
} from "../SandboxAttachmentLink";

jest.mock("@/lib/utils/file-download", () => ({
  startBlobDownload: jest.fn(),
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

const path = "/home/user/report.txt";
const href = toSandboxAttachmentHref(path);
const report = {
  fileId: "file-1",
  name: "report.txt",
  url: "https://files.example/stale-message-url",
} as FileDetails;
const freshUrl = "https://files.example/fresh-signed-url";

describe("SandboxAttachmentLink", () => {
  const originalFetch = global.fetch;
  const blob = new Blob(["SANDBOX_MESSAGE_DOWNLOAD_OK\n"]);
  let getFileUrlAction: jest.Mock;
  let fetchMock: jest.Mock;
  let cache: Map<string, string>;

  beforeEach(() => {
    getFileUrlAction = useAction({} as any) as unknown as jest.Mock;
    getFileUrlAction.mockReset();
    getFileUrlAction.mockResolvedValue(freshUrl);
    fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, blob: async () => blob });
    global.fetch = fetchMock;
    jest.mocked(startBlobDownload).mockClear();
    jest.mocked(toast.error).mockClear();
    cache = new Map();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function renderLink(attachments: ReadonlyMap<string, FileDetails> | null) {
    return render(
      <FileUrlCacheProvider
        getCachedUrl={(fileId) => cache.get(fileId) ?? null}
        setCachedUrl={(fileId, url) => cache.set(fileId, url)}
      >
        <SandboxAttachmentContext.Provider value={attachments}>
          <p>
            Saved to{" "}
            <SandboxAttachmentLink href={href}>
              report.txt
            </SandboxAttachmentLink>
            .
          </p>
        </SandboxAttachmentContext.Provider>
      </FileUrlCacheProvider>,
    );
  }

  const link = () =>
    // Visible text stays first in the name; the hidden suffix states the action.
    screen.getByRole("link", {
      name: /^report\.txt\s*, download report\.txt$/,
    });

  async function click() {
    await act(async () => {
      fireEvent.click(link());
    });
  }

  it("downloads the delivered file through a fresh authenticated URL", async () => {
    renderLink(new Map([[path, report]]));

    await click();

    expect(getFileUrlAction).toHaveBeenCalledWith({ fileId: "file-1" });
    expect(fetchMock).toHaveBeenCalledWith(freshUrl);
    expect(fetchMock).not.toHaveBeenCalledWith(report.url);
    expect(startBlobDownload).toHaveBeenCalledWith(blob, "report.txt");
    expect(cache.get("file-1")).toBe(freshUrl);
    expect(window.location.hash).toBe("");
  });

  it("marks the link busy while downloading and ignores repeated clicks", async () => {
    let resolveUrl: (url: string) => void = () => {};
    getFileUrlAction.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveUrl = resolve;
      }),
    );
    renderLink(new Map([[path, report]]));

    await click();
    expect(link()).toHaveAttribute("aria-busy", "true");
    await click();
    expect(getFileUrlAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveUrl(freshUrl);
    });
    expect(link()).not.toHaveAttribute("aria-busy");
    expect(startBlobDownload).toHaveBeenCalledTimes(1);
  });

  it("keeps the link available to retry after a temporary failure", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    getFileUrlAction.mockRejectedValueOnce(new Error("Connection interrupted"));
    renderLink(new Map([[path, report]]));

    await click();
    expect(toast.error).toHaveBeenCalledWith("Connection interrupted");
    expect(startBlobDownload).not.toHaveBeenCalled();

    await click();
    expect(fetchMock).toHaveBeenCalledWith(freshUrl);
    expect(startBlobDownload).toHaveBeenCalledWith(blob, "report.txt");
  });

  it.each([
    { name: "no delivery matches the path", attachments: new Map() },
    { name: "no message context is provided", attachments: null },
  ])("renders plain text when $name", ({ attachments }) => {
    renderLink(attachments);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("report.txt")).toHaveClass("text-muted-foreground");
    expect(getFileUrlAction).not.toHaveBeenCalled();
  });
});
