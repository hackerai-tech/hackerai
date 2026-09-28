import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type { ErrorInfo } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { ConvexError } from "convex/values";

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
  },
}));

const { ConvexErrorBoundary } =
  require("../ConvexErrorBoundary") as typeof import("../ConvexErrorBoundary");
const errorInfo = { componentStack: "" } as ErrorInfo;

const createBoundary = () => new ConvexErrorBoundary({ children: null });
const { toast } = jest.requireMock<typeof import("sonner")>("sonner");

describe("ConvexErrorBoundary", () => {
  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  it("does not log expected Convex errors", () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    createBoundary().componentDidCatch(
      new ConvexError({
        code: "CHAT_ACCESS_SUSPENDED",
        message: "Your account has been suspended.",
      }),
      errorInfo,
    );

    expect(consoleError).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Account suspended", {
      description: "Your account has been suspended.",
    });
  });

  it("shows the security ban reason and support without retry actions", () => {
    const boundary = createBoundary();
    boundary.state = {
      hasError: true,
      error: new ConvexError({
        code: "CHAT_ACCESS_SUSPENDED",
        message: "Your account has been suspended due to security misuse.",
        suspensionCategory: "security_abuse",
      }),
    };
    render(boundary.render());
    expect(
      screen.getByRole("heading", { name: "Account suspended" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your account has been suspended due to security misuse.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Contact Support" }),
    ).toHaveAttribute("href", "https://help.hackerai.co/");
    expect(
      screen.queryByRole("button", { name: "Try Again" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New Task" }),
    ).not.toBeInTheDocument();
  });

  it("logs unknown Convex errors", () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const error = new ConvexError({
      code: "NEW_UNHANDLED_CONVEX_ERROR",
      message: "Something changed.",
    });

    createBoundary().componentDidCatch(error, errorInfo);

    expect(consoleError).toHaveBeenCalledWith(
      "ConvexErrorBoundary caught an error:",
      error,
      errorInfo,
    );
  });

  it("logs non-Convex errors", () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const error = new Error("render failed");

    createBoundary().componentDidCatch(error, errorInfo);

    expect(consoleError).toHaveBeenCalledWith(
      "ConvexErrorBoundary caught an error:",
      error,
      errorInfo,
    );
  });
});
