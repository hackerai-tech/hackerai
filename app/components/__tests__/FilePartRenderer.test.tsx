import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import { useAction } from "convex/react";
import type { ComponentProps } from "react";
import { FileUrlCacheProvider } from "@/app/contexts/FileUrlCacheContext";
import { FilePartRenderer } from "../FilePartRenderer";

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
});
