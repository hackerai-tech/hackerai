import "@testing-library/jest-dom";
import { describe, it, expect } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import { ContextUsageIndicator } from "../ContextUsageIndicator";

describe("ContextUsageIndicator", () => {
  const defaultProps = {
    usedTokens: 8000,
    maxTokens: 100000,
  };

  describe("Circle indicator", () => {
    it("renders an SVG circle element", () => {
      render(<ContextUsageIndicator {...defaultProps} />);
      const circle = screen.getByTestId("context-usage-circle");
      expect(circle).toBeInTheDocument();
      expect(circle.tagName).toBe("svg");
    });

    it("renders without token text", () => {
      render(<ContextUsageIndicator {...defaultProps} />);
      const indicator = screen.getByTestId("context-usage-indicator");
      expect(indicator.textContent).toBe("");
    });
  });

  describe("Zero tokens state", () => {
    it("renders nothing when all tokens are zero", () => {
      const { container } = render(
        <ContextUsageIndicator usedTokens={0} maxTokens={0} />,
      );
      expect(container.innerHTML).toBe("");
    });
  });

  describe("Aria label", () => {
    it("has correct aria-label with formatted token counts", () => {
      render(<ContextUsageIndicator {...defaultProps} />);
      const indicator = screen.getByTestId("context-usage-indicator");
      expect(indicator).toHaveAttribute(
        "aria-label",
        "Context usage: 8.0k of 100k tokens",
      );
    });
  });
});
