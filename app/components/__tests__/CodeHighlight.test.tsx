import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { CodeHighlight } from "../CodeHighlight";

jest.mock("react-shiki", () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => {
    const React = require("react");
    return React.createElement("div", null, children);
  },
  isInlineCode: () => true,
}));

describe("CodeHighlight", () => {
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
});
