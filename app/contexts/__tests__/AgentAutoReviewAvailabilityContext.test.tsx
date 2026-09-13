import "@testing-library/jest-dom";
import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { useAuth } from "@workos-inc/authkit-nextjs/components";

const { AgentAutoReviewAvailabilityProvider, useAgentAutoReviewAvailability } =
  jest.requireActual<typeof import("../AgentAutoReviewAvailabilityContext")>(
    "../AgentAutoReviewAvailabilityContext",
  );

function mockAuthUser(userId: string | null) {
  jest.mocked(useAuth).mockReturnValue({
    user: userId ? { id: userId } : null,
    entitlements: [],
    loading: false,
    isAuthenticated: Boolean(userId),
    signIn: jest.fn(),
    signOut: jest.fn(),
    organizationId: null,
    refreshAuth: jest.fn(),
  } as unknown as ReturnType<typeof useAuth>);
}

function AvailabilityProbe({ resolve = true }: { resolve?: boolean }) {
  const { agentAutoReviewAvailable, resolveAgentAutoReviewAvailability } =
    useAgentAutoReviewAvailability();

  useEffect(() => {
    if (resolve) resolveAgentAutoReviewAvailability();
  }, [resolve, resolveAgentAutoReviewAvailability]);

  return (
    <div data-testid="agent-auto-review-available">
      {String(agentAutoReviewAvailable)}
    </div>
  );
}

function PassiveSidebarLikeConsumer({ onRender }: { onRender: () => void }) {
  useEffect(() => {
    onRender();
  });

  return <div>Task row</div>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function availableResponse(available: boolean) {
  return {
    ok: true,
    json: () => Promise.resolve({ available }),
  } as Response;
}

describe("AgentAutoReviewAvailabilityProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthUser("user-a");
    global.fetch = jest.fn(() =>
      Promise.resolve(availableResponse(true)),
    ) as jest.MockedFunction<typeof fetch>;
  });

  it("does not fetch availability before a selector requests it", () => {
    render(
      <AgentAutoReviewAvailabilityProvider>
        <AvailabilityProbe resolve={false} />
      </AgentAutoReviewAvailabilityProvider>,
    );

    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.getByTestId("agent-auto-review-available")).toHaveTextContent(
      "null",
    );
  });

  it("keeps resolved availability across keyed consumer remounts", async () => {
    const renderProvider = (chatId: string) => (
      <AgentAutoReviewAvailabilityProvider>
        <AvailabilityProbe key={chatId} />
      </AgentAutoReviewAvailabilityProvider>
    );
    const { rerender } = render(renderProvider("chat-a"));

    await waitFor(() => {
      expect(
        screen.getByTestId("agent-auto-review-available"),
      ).toHaveTextContent("true");
    });

    rerender(renderProvider("chat-b"));

    expect(screen.getByTestId("agent-auto-review-available")).toHaveTextContent(
      "true",
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not rerender unrelated sidebar-like children when availability resolves", async () => {
    const onSidebarRender = jest.fn();
    render(
      <AgentAutoReviewAvailabilityProvider>
        <PassiveSidebarLikeConsumer onRender={onSidebarRender} />
        <AvailabilityProbe />
      </AgentAutoReviewAvailabilityProvider>,
    );

    const initialCommittedRenderCount = onSidebarRender.mock.calls.length;
    expect(initialCommittedRenderCount).toBe(1);

    await waitFor(() => {
      expect(
        screen.getByTestId("agent-auto-review-available"),
      ).toHaveTextContent("true");
    });

    expect(onSidebarRender).toHaveBeenCalledTimes(initialCommittedRenderCount);
  });

  it("leaves availability unresolved and permits a later request after fetch failure", async () => {
    const failedResponse = deferred<Response>();
    global.fetch = jest
      .fn()
      .mockReturnValueOnce(failedResponse.promise)
      .mockResolvedValueOnce(availableResponse(true)) as jest.MockedFunction<
      typeof fetch
    >;
    const renderProvider = (selectorKey: string) => (
      <AgentAutoReviewAvailabilityProvider>
        <AvailabilityProbe key={selectorKey} />
      </AgentAutoReviewAvailabilityProvider>
    );
    const { rerender } = render(renderProvider("first-selector"));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      failedResponse.reject(new Error("temporary network failure"));
    });
    expect(screen.getByTestId("agent-auto-review-available")).toHaveTextContent(
      "null",
    );

    rerender(renderProvider("retry-selector"));
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(
        screen.getByTestId("agent-auto-review-available"),
      ).toHaveTextContent("true");
    });
  });

  it("exposes no stale value and ignores an older response after account switch", async () => {
    const userAResponse = deferred<Response>();
    const userBResponse = deferred<Response>();
    global.fetch = jest
      .fn()
      .mockReturnValueOnce(userAResponse.promise)
      .mockReturnValueOnce(userBResponse.promise) as jest.MockedFunction<
      typeof fetch
    >;
    const { rerender } = render(
      <AgentAutoReviewAvailabilityProvider>
        <AvailabilityProbe />
      </AgentAutoReviewAvailabilityProvider>,
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    mockAuthUser("user-b");
    rerender(
      <AgentAutoReviewAvailabilityProvider>
        <AvailabilityProbe />
      </AgentAutoReviewAvailabilityProvider>,
    );

    expect(screen.getByTestId("agent-auto-review-available")).toHaveTextContent(
      "null",
    );
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));

    await act(async () => {
      userBResponse.resolve(availableResponse(false));
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("agent-auto-review-available"),
      ).toHaveTextContent("false");
    });

    await act(async () => {
      userAResponse.resolve(availableResponse(true));
    });
    expect(screen.getByTestId("agent-auto-review-available")).toHaveTextContent(
      "false",
    );
  });
});
