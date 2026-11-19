import "@testing-library/jest-dom";
import type { ComponentType, ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { MemoizedMarkdown } from "../MemoizedMarkdown";
import { rehypeMarkdownDirection } from "@/lib/chat/markdown-direction";

type MockLink = ComponentType<{ href?: string; children?: ReactNode }>;

const mockComponentMaps: { a: MockLink }[] = [];
const mockRehypePluginLists: unknown[][] = [];

jest.mock("streamdown", () => ({
  defaultRemarkPlugins: {},
  // Stands in for Streamdown's raw HTML, sanitize and harden plugins.
  defaultRehypePlugins: { sanitize: "default-sanitize" },
  Streamdown: ({
    children,
    components,
    isAnimating,
    rehypePlugins,
  }: {
    children: string;
    components: { a: MockLink };
    isAnimating: boolean;
    rehypePlugins: unknown[];
  }) => {
    mockComponentMaps.push(components);
    mockRehypePluginLists.push(rehypePlugins);
    return (
      <div data-animating={String(isAnimating)} data-testid="streamdown">
        {children}
      </div>
    );
  },
}));

jest.mock("@/app/hooks/useTauri", () => ({
  isTauriEnvironment: () => false,
  revealFileInDir: jest.fn(),
}));

describe("MemoizedMarkdown", () => {
  beforeEach(() => {
    mockComponentMaps.length = 0;
    mockRehypePluginLists.length = 0;
  });

  it("keeps Streamdown component identities stable across content updates", () => {
    const { rerender } = render(
      <MemoizedMarkdown content="first block" isAnimating />,
    );

    rerender(
      <MemoizedMarkdown content="first block\n\nnext block" isAnimating />,
    );

    expect(mockComponentMaps.length).toBeGreaterThanOrEqual(2);
    expect(
      mockComponentMaps.every(
        (componentMap) => componentMap === mockComponentMaps[0],
      ),
    ).toBe(true);
  });

  it("forwards streaming state to Streamdown", () => {
    const { rerender } = render(
      <MemoizedMarkdown content="streaming" isAnimating />,
    );

    expect(screen.getByTestId("streamdown")).toHaveAttribute(
      "data-animating",
      "true",
    );

    rerender(<MemoizedMarkdown content="complete" isAnimating={false} />);

    expect(screen.getByTestId("streamdown")).toHaveAttribute(
      "data-animating",
      "false",
    );
  });

  // Without the direction pass, Arabic blocks inherit the page's LTR direction
  // and mixed Arabic/Latin clauses render in reverse order. It must run after
  // the default sanitizers, and a stable list keeps finished blocks memoized.
  it("adds the block direction pass after the default rehype plugins", () => {
    const { rerender } = render(
      <MemoizedMarkdown
        content={"افتح الملف `/tmp/report.json`"}
        isAnimating
      />,
    );
    rerender(
      <MemoizedMarkdown
        content={"افتح الملف `/tmp/report.json`\n\nRun it"}
        isAnimating
      />,
    );

    expect(mockRehypePluginLists[0]).toEqual([
      "default-sanitize",
      rehypeMarkdownDirection,
    ]);
    expect(
      mockRehypePluginLists.every(
        (plugins) => plugins === mockRehypePluginLists[0],
      ),
    ).toBe(true);
  });

  // A URL or path that is not isolated loses its leading/trailing slash to
  // the surrounding right-to-left text.
  it("isolates link and local path text from surrounding prose direction", () => {
    render(<MemoizedMarkdown content="links" />);
    const MarkdownLink = mockComponentMaps[0].a;

    render(
      <>
        <MarkdownLink href="https://docs.example.com/scan/">
          https://docs.example.com/scan/
        </MarkdownLink>
        <MarkdownLink href="/tmp/report.json">/tmp/report.json</MarkdownLink>
        <MarkdownLink href="#hackerai-sandbox-file=%2Ftmp%2Fout%2Fscan.txt">
          /tmp/out/scan.txt
        </MarkdownLink>
      </>,
    );

    expect(
      screen.getByRole("link", { name: "https://docs.example.com/scan/" }),
    ).toHaveAttribute("dir", "auto");
    expect(screen.getByText("/tmp/report.json")).toHaveAttribute("dir", "auto");
    expect(
      screen.getByText("/tmp/out/scan.txt").closest("[dir]"),
    ).toHaveAttribute("dir", "auto");
  });
});
