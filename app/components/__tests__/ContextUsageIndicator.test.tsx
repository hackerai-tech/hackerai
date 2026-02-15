import "@testing-library/jest-dom";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContextUsageIndicator } from "../ContextUsageIndicator";

// No popover mock needed -- clicking the trigger opens the real Radix popover in jsdom.

describe("ContextUsageIndicator", () => {
  const defaultProps = {
    messagesTokens: 5000,
    summaryTokens: 2000,
    systemTokens: 1000,
    maxTokens: 100000,
  };

  describe("Token text formatting", () => {
    it.each([
      {
        name: "formats as X.Xk for totals between 1k-10k",
        props: {
          messagesTokens: 1000,
          summaryTokens: 100,
          systemTokens: 100,
          maxTokens: 100000,
        },
        expected: "1.2k / 100k",
      },
      {
        name: "formats as XXk for totals >= 10k",
        props: {
          messagesTokens: 40000,
          summaryTokens: 3000,
          systemTokens: 2300,
          maxTokens: 100000,
        },
        expected: "45k / 100k",
      },
      {
        name: "formats as raw number below 1000",
        props: {
          messagesTokens: 500,
          summaryTokens: 200,
          systemTokens: 100,
          maxTokens: 100000,
        },
        expected: "800 / 100k",
      },
    ])("$name", ({ props, expected }) => {
      render(<ContextUsageIndicator {...props} />);
      expect(screen.getByText(expected)).toBeInTheDocument();
    });
  });

  describe("Bar color", () => {
    it.each([
      {
        name: "green when usage < 50%",
        messagesTokens: 10000,
        summaryTokens: 0,
        systemTokens: 0,
        maxTokens: 100000,
        expectedClass: "bg-green-500",
      },
      {
        name: "yellow when usage is between 50-80%",
        messagesTokens: 60000,
        summaryTokens: 0,
        systemTokens: 0,
        maxTokens: 100000,
        expectedClass: "bg-yellow-500",
      },
      {
        name: "red when usage > 80%",
        messagesTokens: 85000,
        summaryTokens: 0,
        systemTokens: 0,
        maxTokens: 100000,
        expectedClass: "bg-red-500",
      },
    ])(
      "$name",
      ({
        messagesTokens,
        summaryTokens,
        systemTokens,
        maxTokens,
        expectedClass,
      }) => {
        render(
          <ContextUsageIndicator
            messagesTokens={messagesTokens}
            summaryTokens={summaryTokens}
            systemTokens={systemTokens}
            maxTokens={maxTokens}
          />,
        );
        const bar = screen.getByTestId("context-usage-bar");
        expect(bar.className).toContain(expectedClass);
      },
    );
  });

  describe("Popover breakdown", () => {
    it("shows System, Summary, and Messages labels when opened", () => {
      render(<ContextUsageIndicator {...defaultProps} />);
      fireEvent.click(screen.getByTestId("context-usage-indicator"));
      expect(screen.getByText("System")).toBeInTheDocument();
      expect(screen.getByText("Summary")).toBeInTheDocument();
      expect(screen.getByText("Messages")).toBeInTheDocument();
    });

    it("shows Context Usage header and percentage when opened", () => {
      render(<ContextUsageIndicator {...defaultProps} />);
      fireEvent.click(screen.getByTestId("context-usage-indicator"));
      expect(screen.getByText("Context Usage")).toBeInTheDocument();
      expect(screen.getByText("8%")).toBeInTheDocument();
    });
  });

  describe("Zero tokens state", () => {
    it("renders 0 / 0 when all tokens are zero", () => {
      render(
        <ContextUsageIndicator
          messagesTokens={0}
          summaryTokens={0}
          systemTokens={0}
          maxTokens={0}
        />,
      );
      expect(screen.getByText("0 / 0")).toBeInTheDocument();
    });

    it("has 0% width bar when no tokens used", () => {
      render(
        <ContextUsageIndicator
          messagesTokens={0}
          summaryTokens={0}
          systemTokens={0}
          maxTokens={100000}
        />,
      );
      const bar = screen.getByTestId("context-usage-bar");
      expect(bar.style.width).toBe("0%");
    });
  });

  describe("Aria label", () => {
    it("has correct aria-label with formatted token counts", () => {
      render(<ContextUsageIndicator {...defaultProps} />);
      const button = screen.getByTestId("context-usage-indicator");
      expect(button).toHaveAttribute(
        "aria-label",
        "Context usage: 8.0k of 100k tokens",
      );
    });
  });
});
