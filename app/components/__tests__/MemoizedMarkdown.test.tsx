import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MemoizedMarkdown } from "../MemoizedMarkdown";

const mockComponentMaps: unknown[] = [];

jest.mock("streamdown", () => ({
  Streamdown: ({
    children,
    components,
    isAnimating,
  }: {
    children: string;
    components: unknown;
    isAnimating: boolean;
  }) => {
    mockComponentMaps.push(components);
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
});
