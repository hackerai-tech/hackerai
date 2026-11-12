import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { ErrorInfo } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ConvexError } from "convex/values";

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
  },
}));
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
  getIdentifiedAnalyticsUserId: jest.fn(),
}));

const { ConvexErrorBoundary } =
  require("../ConvexErrorBoundary") as typeof import("../ConvexErrorBoundary");
const errorInfo = { componentStack: "" } as ErrorInfo;

const createBoundary = () => new ConvexErrorBoundary({ children: null });
const { toast } = jest.requireMock<typeof import("sonner")>("sonner");
const { captureAuthenticatedEvent, getIdentifiedAnalyticsUserId } =
  jest.requireMock<typeof import("@/lib/analytics/client")>(
    "@/lib/analytics/client",
  );
const capture = jest.mocked(captureAuthenticatedEvent);
const identity = jest.mocked(getIdentifiedAnalyticsUserId);

const NULL_REMOVE_CHILD =
  "Cannot read properties of null (reading 'removeChild')";
const failureContext = (boundary_scope: string) => [
  "react_boundary_failure_context",
  { version: 1, failure_family: "null_remove_child", boundary_scope },
];

describe("ConvexErrorBoundary", () => {
  beforeEach(() => {
    capture.mockReset();
    capture.mockReturnValue(true);
    identity.mockReset();
    identity.mockReturnValue("identified-fixture-owner");
    jest.mocked(toast.error).mockClear();
  });

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

  describe("null removeChild failure context", () => {
    let thrown: unknown = null;
    const Child = () => {
      if (thrown) throw thrown;
      return <p>Chat ready</p>;
    };
    let consoleError: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
      thrown = null;
      consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    });

    const expectExistingFallback = (error: unknown) => {
      expect(
        screen.getByRole("heading", { name: "Something went wrong" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Try Again" }),
      ).toBeInTheDocument();
      expect(toast.error).toHaveBeenLastCalledWith("Something went wrong", {
        description: "Please try refreshing the page.",
      });
      expect(consoleError).toHaveBeenCalledWith(
        "ConvexErrorBoundary caught an error:",
        error,
        expect.anything(),
      );
    };

    it.each([
      ["chat_content", "chat_content"],
      ["chat_layout", "chat_layout"],
      [undefined, "unknown"],
      ["PRIVATE-unlisted-scope", "unknown"],
    ])(
      "reports only the closed family and scope when a %s child throws it",
      (scope, expected) => {
        const error = new TypeError(NULL_REMOVE_CHILD);
        thrown = error;
        render(
          <ConvexErrorBoundary
            diagnosticScope={scope as "chat_content" | undefined}
          >
            <Child />
          </ConvexErrorBoundary>,
        );

        expectExistingFallback(error);
        expect(capture).toHaveBeenCalledTimes(1);
        expect(capture.mock.calls[0]).toEqual(failureContext(expected));
        const payload = capture.mock.calls[0][1] as Record<string, unknown>;
        expect(Object.keys(payload).sort()).toEqual([
          "boundary_scope",
          "failure_family",
          "version",
        ]);
        expect(JSON.stringify(payload)).not.toMatch(
          /PRIVATE|removeChild|Cannot read|Child/,
        );
      },
    );

    it("attempts once per caught Error object and again only for a new failure after retry", () => {
      const error = new TypeError(NULL_REMOVE_CHILD);
      thrown = error;
      render(
        <ConvexErrorBoundary diagnosticScope="chat_layout">
          <Child />
        </ConvexErrorBoundary>,
      );
      expect(capture).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
      expectExistingFallback(error);
      expect(capture).toHaveBeenCalledTimes(1);

      const next = new TypeError(NULL_REMOVE_CHILD);
      thrown = next;
      fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
      expectExistingFallback(next);
      expect(capture).toHaveBeenCalledTimes(2);
      expect(capture.mock.calls[1]).toEqual(failureContext("chat_layout"));

      thrown = null;
      fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
      expect(screen.getByText("Chat ready")).toBeInTheDocument();
      expect(capture).toHaveBeenCalledTimes(2);
    });

    it.each([
      [
        "throws",
        () => {
          throw new Error("PRIVATE reporter failure");
        },
      ],
      ["returns false", () => false],
    ])(
      "keeps the fallback and never retries the same Error when capture %s",
      (_label, outcome) => {
        capture.mockImplementation(outcome);
        const error = new TypeError(NULL_REMOVE_CHILD);
        thrown = error;
        render(
          <ConvexErrorBoundary diagnosticScope="chat_content">
            <Child />
          </ConvexErrorBoundary>,
        );
        expectExistingFallback(error);
        expect(capture).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
        expectExistingFallback(error);
        expect(capture).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      ["unidentified", () => null],
      [
        "unreadable",
        () => {
          throw new Error("PRIVATE identity failure");
        },
      ],
    ])(
      "sends no context while the analytics owner is %s, then allows an identified account",
      (_label, owner) => {
        identity.mockImplementation(owner);
        const error = new TypeError(NULL_REMOVE_CHILD);
        thrown = error;
        render(
          <ConvexErrorBoundary diagnosticScope="chat_content">
            <Child />
          </ConvexErrorBoundary>,
        );
        expectExistingFallback(error);
        expect(capture).not.toHaveBeenCalled();

        identity.mockReturnValue("identified-fixture-owner");
        const next = new TypeError(NULL_REMOVE_CHILD);
        thrown = next;
        fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
        expectExistingFallback(next);
        expect(capture.mock.calls).toEqual([failureContext("chat_content")]);
      },
    );

    it("never reads the stack or component stack of a qualifying failure", () => {
      const trap = jest.fn();
      const error = new TypeError(NULL_REMOVE_CHILD);
      Object.defineProperty(error, "stack", {
        get: () => {
          trap("stack");
          return "PRIVATE stack";
        },
      });
      const info = {
        get componentStack() {
          trap("componentStack");
          return "PRIVATE component stack";
        },
      } as ErrorInfo;

      new ConvexErrorBoundary({
        children: null,
        diagnosticScope: "chat_layout",
      }).componentDidCatch(error, info);

      expect(capture.mock.calls).toEqual([failureContext("chat_layout")]);
      expect(trap).not.toHaveBeenCalled();
    });

    it("keeps existing handling when error properties are hostile", () => {
      const hostile = Object.create(TypeError.prototype, {
        name: {
          get: () => {
            throw new Error("PRIVATE name getter");
          },
        },
        message: {
          get: () => {
            throw new Error("PRIVATE message getter");
          },
        },
      }) as Error;

      expect(() =>
        new ConvexErrorBoundary({
          children: null,
          diagnosticScope: "chat_content",
        }).componentDidCatch(hostile, errorInfo),
      ).not.toThrow();
      expect(capture).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith("Something went wrong", {
        description: "Please try refreshing the page.",
      });
    });

    it.each([
      [
        "a different null property",
        new TypeError(
          "Cannot read properties of null (reading 'insertBefore')",
        ),
      ],
      [
        "an undefined receiver",
        new TypeError(
          "Cannot read properties of undefined (reading 'removeChild')",
        ),
      ],
      ["a prefixed message", new TypeError(`TypeError: ${NULL_REMOVE_CHILD}`)],
      ["a suffixed message", new TypeError(`${NULL_REMOVE_CHILD}.`)],
      ["another error class", new Error(NULL_REMOVE_CHILD)],
      [
        "a DOM mutation error",
        new DOMException(
          "The node to be removed is not a child of this node.",
          "NotFoundError",
        ),
      ],
      [
        "a Convex error",
        new ConvexError({
          code: "NEW_UNHANDLED_CONVEX_ERROR",
          message: NULL_REMOVE_CHILD,
        }),
      ],
      ["a thrown string", NULL_REMOVE_CHILD],
    ])("stays silent for %s", (_label, error) => {
      thrown = error;
      render(
        <ConvexErrorBoundary diagnosticScope="chat_content">
          <Child />
        </ConvexErrorBoundary>,
      );
      expect(
        screen.getByRole("heading", { name: "Something went wrong" }),
      ).toBeInTheDocument();
      expect(capture).not.toHaveBeenCalled();
    });

    it("stays silent for ordinary renders", () => {
      render(
        <ConvexErrorBoundary diagnosticScope="chat_content">
          <Child />
        </ConvexErrorBoundary>,
      );
      expect(screen.getByText("Chat ready")).toBeInTheDocument();
      expect(capture).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });
  });
});
