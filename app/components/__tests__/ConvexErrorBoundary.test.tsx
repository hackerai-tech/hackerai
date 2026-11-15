import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { StrictMode, type ErrorInfo } from "react";
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
  getPermittedAnalyticsUserId: jest.fn(),
  subscribeAuthenticatedAnalytics: jest.fn(() => () => {}),
}));

const { ConvexErrorBoundary } =
  require("../ConvexErrorBoundary") as typeof import("../ConvexErrorBoundary");
const { getReactBoundaryDiagnostics, startReactBoundaryDiagnostics } =
  require("@/lib/posthog/react-boundary-diagnostics") as typeof import("@/lib/posthog/react-boundary-diagnostics");
const errorInfo = { componentStack: "" } as ErrorInfo;

const createBoundary = () => new ConvexErrorBoundary({ children: null });
const { toast } = jest.requireMock<typeof import("sonner")>("sonner");
const {
  captureAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
  getPermittedAnalyticsUserId,
} = jest.requireMock<typeof import("@/lib/analytics/client")>(
  "@/lib/analytics/client",
);
const capture = jest.mocked(captureAuthenticatedEvent);
const identity = jest.mocked(getIdentifiedAnalyticsUserId);
const permitted = jest.mocked(getPermittedAnalyticsUserId);
const OWNER = "identified-fixture-owner";

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
    identity.mockReturnValue(OWNER);
    permitted.mockReset();
    permitted.mockReturnValue(OWNER);
    jest.mocked(toast.error).mockReset();
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

  describe("nearby context for retained exceptions", () => {
    let stopObserver: () => void;
    const mountedScopes = () => {
      const fields = getReactBoundaryDiagnostics(OWNER);
      return {
        chat_content: fields.hackerai_react_boundary_chat_content_mounted,
        chat_layout: fields.hackerai_react_boundary_chat_layout_mounted,
        unknown: fields.hackerai_react_boundary_unknown_scope_mounted,
      };
    };
    const recentCatch = () => {
      const fields = getReactBoundaryDiagnostics(OWNER);
      return [
        fields.hackerai_react_boundary_recent_catch_state,
        fields.hackerai_react_boundary_recent_scope,
      ];
    };

    beforeEach(() => {
      jest.spyOn(console, "error").mockImplementation(() => {});
      stopObserver = startReactBoundaryDiagnostics();
    });

    afterEach(() => {
      cleanup();
      stopObserver();
    });

    it("tracks mounted fixed scopes from before identification through scope changes and unmount", () => {
      stopObserver();
      identity.mockReturnValue(null);
      permitted.mockReturnValue(null);
      const view = render(
        <>
          <ConvexErrorBoundary diagnosticScope="chat_content">
            <p>content</p>
          </ConvexErrorBoundary>
          <ConvexErrorBoundary diagnosticScope="chat_layout">
            <p>layout</p>
          </ConvexErrorBoundary>
        </>,
      );
      identity.mockReturnValue(OWNER);
      permitted.mockReturnValue(OWNER);
      stopObserver = startReactBoundaryDiagnostics();
      expect(mountedScopes()).toEqual({
        chat_content: true,
        chat_layout: true,
        unknown: false,
      });

      view.rerender(
        <>
          <ConvexErrorBoundary diagnosticScope="chat_content">
            <p>content</p>
          </ConvexErrorBoundary>
          <ConvexErrorBoundary
            diagnosticScope={"PRIVATE-scope" as "chat_layout"}
          >
            <p>layout</p>
          </ConvexErrorBoundary>
        </>,
      );
      expect(mountedScopes()).toEqual({
        chat_content: true,
        chat_layout: false,
        unknown: true,
      });

      view.unmount();
      expect(mountedScopes()).toEqual({
        chat_content: false,
        chat_layout: false,
        unknown: false,
      });
    });

    it("leaves no registration behind after StrictMode's remount and unmount", () => {
      const view = render(
        <StrictMode>
          <ConvexErrorBoundary diagnosticScope="chat_layout">
            <p>layout</p>
          </ConvexErrorBoundary>
        </StrictMode>,
      );
      expect(mountedScopes().chat_layout).toBe(true);
      view.unmount();
      expect(mountedScopes().chat_layout).toBe(false);
    });

    it("records a recent catch with the boundary's fixed scope", () => {
      const Throw = () => {
        throw new TypeError(NULL_REMOVE_CHILD);
      };
      render(
        <ConvexErrorBoundary diagnosticScope="chat_layout">
          <Throw />
        </ConvexErrorBoundary>,
      );
      expect(recentCatch()).toEqual(["observed", "chat_layout"]);
    });

    it.each([
      ["console.error", () => jest.mocked(console.error)],
      ["toast.error", () => jest.mocked(toast.error)],
    ])(
      "records and captures before %s throws, then rethrows the original",
      (_label, reporter) => {
        const original = new Error("legacy reporter failure");
        reporter().mockImplementation(() => {
          throw original;
        });
        const boundary = new ConvexErrorBoundary({
          children: null,
          diagnosticScope: "chat_content",
        });

        let thrown: unknown;
        try {
          boundary.componentDidCatch(
            new TypeError(NULL_REMOVE_CHILD),
            errorInfo,
          );
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBe(original);
        expect(capture.mock.calls).toEqual([failureContext("chat_content")]);
        expect(recentCatch()).toEqual(["observed", "chat_content"]);
      },
    );

    it("neither records nor captures when the permitted owner differs", () => {
      permitted.mockReturnValue("another-owner");
      new ConvexErrorBoundary({
        children: null,
        diagnosticScope: "chat_content",
      }).componentDidCatch(new TypeError(NULL_REMOVE_CHILD), errorInfo);
      expect(capture).not.toHaveBeenCalled();
      permitted.mockReturnValue(OWNER);
      expect(recentCatch()).toEqual(["none", undefined]);
    });

    it("keeps the fallback, capture and legacy reporting when recording fails", () => {
      // The boundary's own owner gate passes; the recorder's re-read throws.
      identity.mockReturnValueOnce(OWNER).mockImplementationOnce(() => {
        throw new Error("PRIVATE identity failure");
      });
      const Throw = () => {
        throw new TypeError(NULL_REMOVE_CHILD);
      };
      render(
        <ConvexErrorBoundary diagnosticScope="chat_content">
          <Throw />
        </ConvexErrorBoundary>,
      );
      expect(
        screen.getByRole("heading", { name: "Something went wrong" }),
      ).toBeInTheDocument();
      expect(toast.error).toHaveBeenCalledWith("Something went wrong", {
        description: "Please try refreshing the page.",
      });
      expect(capture.mock.calls).toEqual([failureContext("chat_content")]);
      expect(recentCatch()).toEqual(["none", undefined]);
    });
  });
});
