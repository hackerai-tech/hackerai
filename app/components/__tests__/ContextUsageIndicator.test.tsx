import "@testing-library/jest-dom";
import { afterAll, beforeAll, describe, it, expect } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextUsageIndicator } from "../ContextUsageIndicator";

const originalResizeObserver = global.ResizeObserver;

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterAll(() => {
  global.ResizeObserver = originalResizeObserver;
});

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

    it("uses a passive hover target by default", () => {
      render(<ContextUsageIndicator {...defaultProps} />);
      const indicator = screen.getByTestId("context-usage-indicator");
      expect(indicator.tagName).toBe("DIV");
    });

    it("keeps the passive desktop target keyboard-focusable", () => {
      render(<ContextUsageIndicator {...defaultProps} />);
      const indicator = screen.getByTestId("context-usage-indicator");

      expect(indicator).toHaveAttribute("tabIndex", "0");
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

  describe("Desktop tooltip", () => {
    it("shows the exact auto-compact threshold on hover", async () => {
      const user = userEvent.setup();

      render(<ContextUsageIndicator {...defaultProps} />);

      await user.hover(screen.getByTestId("context-usage-indicator"));

      expect(
        await screen.findAllByText(
          "Auto-compact starts at 90,000 tokens (90%).",
        ),
      ).not.toHaveLength(0);
      expect(
        screen.getAllByText("82,000 tokens until auto-compact"),
      ).not.toHaveLength(0);
    });
  });

  describe("Compact popover", () => {
    it("opens a short mobile-friendly message on click", async () => {
      const user = userEvent.setup();

      render(
        <ContextUsageIndicator
          usedTokens={8500}
          maxTokens={200000}
          variant="compact-popover"
        />,
      );

      await user.click(screen.getByTestId("context-usage-indicator"));

      expect(screen.getByText("Context window:")).toBeInTheDocument();
      expect(screen.getByText("4% used (96% left)")).toBeInTheDocument();
      expect(screen.getByText("8.5k / 200k tokens used")).toBeInTheDocument();
      expect(
        screen.getByText("HackerAI automatically compacts its context"),
      ).toBeInTheDocument();
    });
  });
});
