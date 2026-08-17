import "@testing-library/jest-dom";
import { describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";

jest.mock("@/app/hooks/useToolSidebar", () => ({
  useToolSidebar: () => ({
    handleOpenInSidebar: jest.fn(),
    handleKeyDown: jest.fn(),
  }),
}));

const { WebToolHandler } =
  require("../WebToolHandler") as typeof import("../WebToolHandler");

describe("WebToolHandler", () => {
  it("falls back to the legacy query when queries is not an array", () => {
    render(
      <WebToolHandler
        status="ready"
        part={{
          toolCallId: "call-1",
          state: "output-available",
          input: {
            queries: { 0: "unexpected", length: 1 },
            query: "fallback query",
          } as never,
        }}
      />,
    );

    expect(screen.getByText("Searched web")).toBeInTheDocument();
    expect(screen.getByText("fallback query")).toBeInTheDocument();
  });
});
