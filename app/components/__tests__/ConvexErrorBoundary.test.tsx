import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type { ErrorInfo } from "react";
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
    expect(toast.error).toHaveBeenCalledWith("Error", {
      description: "Your account has been suspended.",
    });
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
