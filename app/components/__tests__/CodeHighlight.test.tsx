import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import {
  CodeHighlight,
  MAX_HIGHLIGHT_CHARS,
  MAX_HIGHLIGHT_LINES,
  MAX_STREAMING_HIGHLIGHT_CHARS,
} from "../CodeHighlight";

let mockInlineCode = true;
let mockCodeFenceIncomplete = false;
let mockShikiRenderCount = 0;

jest.mock("react-shiki", () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => {
    const React = require("react");
    mockShikiRenderCount += 1;
    return React.createElement("div", { "data-testid": "shiki" }, children);
  },
  isInlineCode: () => mockInlineCode,
}));

jest.mock("streamdown", () => ({
  useIsCodeFenceIncomplete: () => mockCodeFenceIncomplete,
}));

describe("CodeHighlight", () => {
  beforeEach(() => {
    mockInlineCode = true;
    mockCodeFenceIncomplete = false;
    mockShikiRenderCount = 0;
  });

  it("wraps long inline code tokens instead of forcing horizontal scrolling", () => {
    render(
      <CodeHighlight node={{ type: "element", tagName: "code" } as any}>
        53‡‡†305))6*;4826)4‡.)4‡);806*;48†8¶60))85
      </CodeHighlight>,
    );

    const code = screen.getByText(/53‡‡†305/);

    expect(code).toHaveClass("whitespace-pre-wrap");
    expect(code).toHaveClass("break-words");
    expect(code).toHaveClass("[overflow-wrap:anywhere]");
  });

  it("keeps large incomplete code fences plain while they stream", () => {
    mockInlineCode = false;
    mockCodeFenceIncomplete = true;
    const code = "x".repeat(MAX_STREAMING_HIGHLIGHT_CHARS + 1);

    const { container } = render(
      <CodeHighlight
        className="language-js"
        node={{ type: "element", tagName: "code" } as any}
      >
        {code}
      </CodeHighlight>,
    );

    expect(
      container.querySelector('[data-highlight-mode="plain-streaming"]'),
    ).toBeInTheDocument();
    expect(container.querySelector("pre > code")).toHaveTextContent(code);
    expect(mockShikiRenderCount).toBe(0);
  });

  it("highlights a completed block after the streaming guard releases", () => {
    mockInlineCode = false;
    const code = "const answer = 42;";

    const { container } = render(
      <CodeHighlight
        className="language-js"
        node={{ type: "element", tagName: "code" } as any}
      >
        {code}
      </CodeHighlight>,
    );

    expect(
      container.querySelector('[data-highlight-mode="highlighted"]'),
    ).toBeInTheDocument();
    expect(screen.getByTestId("shiki")).toHaveTextContent(code);
  });

  it("keeps oversized completed blocks plain without a highlighting override", () => {
    mockInlineCode = false;
    const code = "x".repeat(MAX_HIGHLIGHT_CHARS + 1);

    const { container } = render(
      <CodeHighlight
        className="language-js"
        node={{ type: "element", tagName: "code" } as any}
      >
        {code}
      </CodeHighlight>,
    );

    expect(
      container.querySelector('[data-highlight-mode="plain-large"]'),
    ).toBeInTheDocument();
    expect(mockShikiRenderCount).toBe(0);
    expect(
      screen.queryByRole("button", { name: "Enable syntax highlighting" }),
    ).not.toBeInTheDocument();
  });

  it("also bounds completed blocks with extremely many short lines", () => {
    mockInlineCode = false;
    const code = "x\n".repeat(MAX_HIGHLIGHT_LINES);

    const { container } = render(
      <CodeHighlight
        className="language-js"
        node={{ type: "element", tagName: "code" } as any}
      >
        {code}
      </CodeHighlight>,
    );

    expect(code.length).toBeLessThan(MAX_HIGHLIGHT_CHARS);
    expect(
      container.querySelector('[data-highlight-mode="plain-large"]'),
    ).toBeInTheDocument();
    expect(mockShikiRenderCount).toBe(0);
  });
});
