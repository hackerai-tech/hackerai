import { render, screen, waitFor } from "@testing-library/react";
import { FileUrlCacheProvider } from "@/app/contexts/FileUrlCacheContext";
import { FileContentViewer } from "../FileContentViewer";

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

  function renderViewer(file: File) {
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
        />
      </FileUrlCacheProvider>,
    );
  }

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
