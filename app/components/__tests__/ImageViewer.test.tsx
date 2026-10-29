import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ImageViewer } from "../ImageViewer";

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ alt, ...props }: any) => <img alt={alt} {...props} />,
}));

describe("ImageViewer downloads", () => {
  const imageSrc = "https://files.example/screenshot.png";
  const originalFetch = global.fetch;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let fetchMock: jest.Mock;
  let downloaded: Array<{ href: string; name: string }>;
  let rerender: ReturnType<typeof render>["rerender"];

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    URL.createObjectURL = jest.fn(() => "blob:image-fixture");
    URL.revokeObjectURL = jest.fn();
    downloaded = [];
    jest.spyOn(window, "open").mockReturnValue(null);
    jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloaded.push({ href: this.href, name: this.download });
      });
    ({ rerender } = render(
      <ImageViewer
        isOpen
        onClose={jest.fn()}
        imageSrc={imageSrc}
        imageAlt="Screenshot"
        fileName="screenshot.png"
      />,
    ));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    jest.restoreAllMocks();
  });

  async function download() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download image" }));
    });
  }

  it.each([403, 500])(
    "does not save an HTTP %s error body and permits a successful retry",
    async (status) => {
      const errorBlob = jest.fn(
        async () => new Blob(["<Error>Denied</Error>"]),
      );
      const imageBlob = new Blob(["image fixture"], { type: "image/png" });
      fetchMock
        .mockResolvedValueOnce({ ok: false, status, blob: errorBlob })
        .mockResolvedValueOnce({ ok: true, blob: async () => imageBlob });

      await download();

      expect(errorBlob).not.toHaveBeenCalled();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(downloaded).toEqual([]);
      expect(screen.getByRole("alert")).toHaveTextContent("Download failed.");
      const fallback = screen.getByRole("link", { name: "Open image" });
      expect(fallback).toHaveAttribute("href", imageSrc);
      expect(fallback).toHaveAttribute("target", "_blank");
      expect(fallback).toHaveAttribute("rel", "noopener noreferrer");
      expect(window.open).toHaveBeenCalledWith(
        imageSrc,
        "_blank",
        "noopener,noreferrer",
      );
      expect(
        screen.getByRole("button", { name: "Download image" }),
      ).toBeEnabled();

      await download();

      expect(URL.createObjectURL).toHaveBeenCalledWith(imageBlob);
      expect(downloaded).toEqual([
        { href: "blob:image-fixture", name: "screenshot.png" },
      ]);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:image-fixture");
      expect(window.open).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("preserves the direct-open fallback for a rejected network request", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await download();

    expect(window.open).toHaveBeenCalledWith(
      imageSrc,
      "_blank",
      "noopener,noreferrer",
    );
    expect(downloaded).toEqual([]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Open image" })).toHaveAttribute(
      "href",
      imageSrc,
    );
  });

  it("does not show a late download failure on a different image", async () => {
    let rejectDownload!: (error: Error) => void;
    fetchMock.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectDownload = reject;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Download image" }));
    rerender(
      <ImageViewer
        isOpen
        onClose={jest.fn()}
        imageSrc="https://files.example/other.png"
        imageAlt="Other image"
      />,
    );

    await act(async () => {
      rejectDownload(new Error("offline"));
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(downloaded).toEqual([]);
  });
});
