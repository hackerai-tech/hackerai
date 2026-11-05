import { render, screen, waitFor } from "@testing-library/react";
import { FileUrlCacheProvider } from "@/app/contexts/FileUrlCacheContext";
import { FileContentViewer } from "../FileContentViewer";
import { readLocalPreviewFile } from "@/app/hooks/useTauri";
import type { LocalDesktopFile } from "@/types/file";

jest.mock("@/app/hooks/useTauri", () => ({ readLocalPreviewFile: jest.fn() }));

describe("FileContentViewer", () => {
  let createObjectURL: jest.Mock;
  let revokeObjectURL: jest.Mock;

  function makeFile(contents: string, name: string, type: string): File {
    const file = new File([contents], name, { type });

    Object.defineProperty(file, "text", {
      configurable: true,
      value: jest.fn(async () => contents),
    });
    Object.defineProperty(file, "slice", {
      configurable: true,
      value: jest.fn((start = 0, end = contents.length) => ({
        text: jest.fn(async () => contents.slice(start, end)),
      })),
    });

    return file;
  }

  beforeEach(() => {
    createObjectURL = jest.fn(() => "blob:preview-pdf");
    revokeObjectURL = jest.fn();

    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
  });

  function renderViewer(file: File | LocalDesktopFile, localPath?: string) {
    return render(
      <FileUrlCacheProvider
        getCachedUrl={() => null}
        setCachedUrl={() => undefined}
      >
        <FileContentViewer
          isOpen
          onClose={() => undefined}
          file={file}
          fileName={file.name}
          localPath={localPath}
        />
      </FileUrlCacheProvider>,
    );
  }

  it("reads a metadata-only Desktop attachment locally and escapes its text", async () => {
    const file = makeFile(
      "Local café <script>alert(1)</script>",
      "notes.txt",
      "text/plain",
    );
    jest.mocked(readLocalPreviewFile).mockResolvedValueOnce(file);
    const { container } = renderViewer(
      { name: file.name, type: file.type, size: file.size, lastModified: 0 },
      "/local/notes.txt",
    );
    expect(
      await screen.findByText("Local café <script>alert(1)</script>"),
    ).toBeVisible();
    expect(readLocalPreviewFile).toHaveBeenCalledWith("/local/notes.txt");
    expect(container.querySelector("script")).toBeNull();
  });

  it("loads a local PDF and releases its blob when the preview closes", async () => {
    const file = makeFile("%PDF-1.7\n", "local.pdf", "application/pdf");
    jest.mocked(readLocalPreviewFile).mockResolvedValueOnce(file);
    const { container, unmount } = renderViewer(
      { name: file.name, type: file.type, size: file.size, lastModified: 0 },
      "/local/local.pdf",
    );
    await waitFor(() =>
      expect(container.querySelector("iframe")).toHaveAttribute(
        "src",
        "blob:preview-pdf",
      ),
    );
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-pdf");
  });

  it.each([
    "Command read_local_preview_file not found",
    "Command read_local_preview_file not allowed by ACL",
    "READ_LOCAL_PREVIEW_FILE Not Allowed",
  ])(
    "requests a Desktop update for an unsupported preview command: %s",
    async (error) => {
      jest.mocked(readLocalPreviewFile).mockRejectedValueOnce(new Error(error));
      renderViewer(
        { name: "notes.txt", type: "text/plain", size: 10, lastModified: 0 },
        "/local/notes.txt",
      );
      expect(
        await screen.findByText(
          "Update HackerAI Desktop to preview local files.",
        ),
      ).toBeVisible();
    },
  );

  it("reports a missing local file without falling back to a cloud URL", async () => {
    jest
      .mocked(readLocalPreviewFile)
      .mockRejectedValueOnce(new Error("not found"));
    renderViewer(
      { name: "missing.txt", type: "text/plain", size: 10, lastModified: 0 },
      "/local/missing.txt",
    );
    expect(await screen.findByText(/Check that it still exists/)).toBeVisible();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("renders valid in-memory PDFs in the native PDF iframe", async () => {
    const file = makeFile("%PDF-1.7\n1 0 obj\n", "safe.pdf", "application/pdf");

    const { container } = renderViewer(file);

    await waitFor(() => {
      expect(container.querySelector("iframe")).toBeInTheDocument();
    });

    const iframe = container.querySelector("iframe");
    expect(createObjectURL).toHaveBeenCalledWith(file);
    expect(iframe).toHaveAttribute("src", "blob:preview-pdf");
    expect(iframe).not.toHaveAttribute("sandbox");
  });

  it("shows crafted HTML .pdf files as escaped text instead of iframe PDFs", async () => {
    const file = makeFile(
      "<script>window.__attachmentPreviewPoc = true;</script>",
      "poc.pdf",
      "text/html",
    );

    const { container } = renderViewer(file);

    expect(
      await screen.findByText(
        "<script>window.__attachmentPreviewPoc = true;</script>",
      ),
    ).toBeInTheDocument();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(container.querySelector("iframe")).not.toBeInTheDocument();
  });

  it("rejects application/pdf browser files without a PDF signature", async () => {
    const file = makeFile(
      "<html><script>alert(1)</script></html>",
      "poc.pdf",
      "application/pdf",
    );

    const { container } = renderViewer(file);

    expect(
      await screen.findByText("Failed to read file content."),
    ).toBeInTheDocument();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(container.querySelector("iframe")).not.toBeInTheDocument();
  });
});
