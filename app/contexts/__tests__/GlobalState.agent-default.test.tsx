import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { useAccessToken, useAuth } from "@workos-inc/authkit-nextjs/components";
import { SHARED_TOKEN_KEY } from "@/lib/auth/shared-token";

jest.mock("@/app/hooks/useSandboxPreference", () => {
  const setSandboxPreference = jest.fn();
  const retryDesktopBridge = jest.fn();

  return {
    useSandboxPreference: () => ({
      sandboxPreference: "e2b",
      setSandboxPreference,
      desktopBridgeActive: false,
      desktopBridgeStatus: "idle",
      retryDesktopBridge,
    }),
  };
});

const { GlobalStateProvider, useGlobalState } =
  jest.requireActual<typeof import("../GlobalState")>("../GlobalState");

const mockAuthUser = (
  entitlements: string[] | undefined,
  overrides: Partial<ReturnType<typeof useAuth>> = {},
) => {
  jest.mocked(useAuth).mockReturnValue({
    user: { id: "user_ultra" },
    entitlements,
    loading: false,
    isAuthenticated: true,
    signIn: jest.fn(),
    signOut: jest.fn(),
    organizationId: "org_ultra",
    refreshAuth: jest.fn(),
    ...overrides,
  } as ReturnType<typeof useAuth>);
};

function GlobalStateProbe() {
  const {
    agentPermissionMode,
    chatModeAccessResolved,
    chatMode,
    isCheckingProPlan,
    paidAgentOnlyActive,
    sandboxPreference,
    selectedModel,
    subscription,
  } = useGlobalState();

  return (
    <>
      <div data-testid="agent-permission-mode">{agentPermissionMode}</div>
      <div data-testid="chat-mode-access-resolved">
        {String(chatModeAccessResolved)}
      </div>
      <div data-testid="chat-mode">{chatMode}</div>
      <div data-testid="checking-pro-plan">{String(isCheckingProPlan)}</div>
      <div data-testid="paid-agent-only">{String(paidAgentOnlyActive)}</div>
      <div data-testid="sandbox-preference">{sandboxPreference}</div>
      <div data-testid="selected-model">{selectedModel}</div>
      <div data-testid="subscription">{subscription}</div>
    </>
  );
}

function ActiveProjectProbe() {
  const { activeProjectId } = useGlobalState();

  return <div data-testid="active-project-id">{activeProjectId ?? "none"}</div>;
}

describe("GlobalStateProvider agent defaults", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    delete window.__TAURI_INTERNALS__;
    window.history.pushState({}, "", "/");
    window.localStorage.clear();
    jest.mocked(useAccessToken).mockReturnValue({
      getAccessToken: jest.fn().mockResolvedValue("mock-access-token"),
      accessToken: "mock-access-token",
      refresh: jest.fn().mockResolvedValue("mock-access-token"),
    } as ReturnType<typeof useAccessToken>);
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false }),
    ) as unknown as typeof fetch;
    mockAuthUser([]);
  });

  it("reveals free desktop mode access before token refresh finishes", async () => {
    window.__TAURI_INTERNALS__ = {};
    const refreshAuth = jest.fn(() => new Promise<void>(() => {}));
    mockAuthUser(undefined, { refreshAuth });
    global.fetch = jest.fn((input) => {
      if (String(input) === "/api/entitlements") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ entitlements: [] }),
        });
      }

      return Promise.resolve({ ok: false });
    }) as unknown as typeof fetch;

    render(
      <GlobalStateProvider>
        <GlobalStateProbe />
      </GlobalStateProvider>,
    );

    await waitFor(() => {
      expect(refreshAuth).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("chat-mode-access-resolved")).toHaveTextContent(
        "true",
      );
      expect(screen.getByTestId("checking-pro-plan")).toHaveTextContent(
        "false",
      );
    });
    expect(screen.getByTestId("subscription")).toHaveTextContent("free");
    expect(screen.getByTestId("paid-agent-only")).toHaveTextContent("false");
  });

  it("reveals free web mode access when AuthKit omits entitlements", async () => {
    const refreshAuth = jest.fn(() => new Promise<void>(() => {}));
    mockAuthUser(undefined, { refreshAuth });
    global.fetch = jest.fn((input) => {
      if (String(input) === "/api/entitlements") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ entitlements: [], subscription: "free" }),
        });
      }

      return Promise.resolve({ ok: false });
    }) as unknown as typeof fetch;

    render(
      <GlobalStateProvider>
        <GlobalStateProbe />
      </GlobalStateProvider>,
    );

    expect(screen.getByTestId("chat-mode-access-resolved")).toHaveTextContent(
      "false",
    );

    await waitFor(() => {
      expect(refreshAuth).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("chat-mode-access-resolved")).toHaveTextContent(
        "true",
      );
    });
    expect(screen.getByTestId("subscription")).toHaveTextContent("free");
    expect(screen.getByTestId("paid-agent-only")).toHaveTextContent("false");
  });

  it("keeps paid web users Agent-only when AuthKit omits entitlements", async () => {
    const refreshAuth = jest.fn(() => new Promise<void>(() => {}));
    mockAuthUser(undefined, { refreshAuth });
    global.fetch = jest.fn((input) => {
      if (String(input) === "/api/entitlements") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              entitlements: ["pro-plan"],
              subscription: "pro",
            }),
        });
      }

      return Promise.resolve({ ok: false });
    }) as unknown as typeof fetch;

    render(
      <GlobalStateProvider>
        <GlobalStateProbe />
      </GlobalStateProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("subscription")).toHaveTextContent("pro");
      expect(screen.getByTestId("chat-mode-access-resolved")).toHaveTextContent(
        "true",
      );
      expect(screen.getByTestId("paid-agent-only")).toHaveTextContent("true");
      expect(screen.getByTestId("chat-mode")).toHaveTextContent("agent");
    });
  });

  it("keeps web mode access unresolved when missing entitlements cannot be verified", async () => {
    jest.useFakeTimers();
    mockAuthUser(undefined);
    global.fetch = jest.fn((input) =>
      Promise.resolve({ ok: String(input) !== "/api/entitlements" }),
    ) as unknown as typeof fetch;

    render(
      <GlobalStateProvider>
        <GlobalStateProbe />
      </GlobalStateProvider>,
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/entitlements",
        expect.objectContaining({ credentials: "include" }),
      );
      expect(screen.getByTestId("checking-pro-plan")).toHaveTextContent(
        "false",
      );
    });
    expect(screen.getByTestId("chat-mode-access-resolved")).toHaveTextContent(
      "false",
    );
    expect(screen.getByTestId("paid-agent-only")).toHaveTextContent("false");
  });

  it("retries missing web entitlements after a transient verification failure", async () => {
    jest.useFakeTimers();
    mockAuthUser(undefined);
    let entitlementAttempts = 0;
    global.fetch = jest.fn((input) => {
      if (String(input) === "/api/entitlements") {
        entitlementAttempts += 1;
        if (entitlementAttempts === 1) {
          return Promise.resolve({ ok: false });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ entitlements: [], subscription: "free" }),
        });
      }

      return Promise.resolve({ ok: false });
    }) as unknown as typeof fetch;

    render(
      <GlobalStateProvider>
        <GlobalStateProbe />
      </GlobalStateProvider>,
    );

    await waitFor(() => {
      expect(entitlementAttempts).toBe(1);
      expect(screen.getByTestId("chat-mode-access-resolved")).toHaveTextContent(
        "false",
      );
    });

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });

    await waitFor(() => {
      expect(entitlementAttempts).toBe(2);
      expect(screen.getByTestId("chat-mode-access-resolved")).toHaveTextContent(
        "true",
      );
    });
    expect(screen.getByTestId("subscription")).toHaveTextContent("free");
  });

  it("resolves paid desktop users to Agent-only before token refresh finishes", async () => {
    window.__TAURI_INTERNALS__ = {};
    const refreshAuth = jest.fn(() => new Promise<void>(() => {}));
    mockAuthUser([], { refreshAuth });
    global.fetch = jest.fn((input) => {
      if (String(input) === "/api/entitlements") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ entitlements: ["pro-plan"] }),
        });
      }

      return Promise.resolve({ ok: false });
    }) as unknown as typeof fetch;

    render(
      <GlobalStateProvider>
        <GlobalStateProbe />
      </GlobalStateProvider>,
    );

    await waitFor(() => {
      expect(refreshAuth).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("subscription")).toHaveTextContent("pro");
      expect(screen.getByTestId("chat-mode-access-resolved")).toHaveTextContent(
        "true",
      );
      expect(screen.getByTestId("paid-agent-only")).toHaveTextContent("true");
      expect(screen.getByTestId("chat-mode")).toHaveTextContent("agent");
    });
  });

  it("releases free desktop mode access when entitlement refresh times out", async () => {
    jest.useFakeTimers();
    window.__TAURI_INTERNALS__ = {};
    let requestAborted = false;
    global.fetch = jest.fn((input, init) => {
      if (String(input) === "/api/entitlements") {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            requestAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }

      return Promise.resolve({ ok: false });
    }) as unknown as typeof fetch;

    render(
      <GlobalStateProvider>
        <GlobalStateProbe />
      </GlobalStateProvider>,
    );

    expect(screen.getByTestId("chat-mode-access-resolved")).toHaveTextContent(
      "false",
    );

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });

    expect(requestAborted).toBe(true);
    expect(screen.getByTestId("chat-mode-access-resolved")).toHaveTextContent(
      "true",
    );
    expect(screen.getByTestId("checking-pro-plan")).toHaveTextContent("false");
  });

  it("aborts a stale desktop entitlement refresh when the account changes", async () => {
    window.__TAURI_INTERNALS__ = {};
    let requestSignal: AbortSignal | undefined;
    global.fetch = jest.fn((input, init) => {
      if (String(input) === "/api/entitlements") {
        requestSignal = init?.signal ?? undefined;
        return new Promise((_, reject) => {
          requestSignal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }

      return Promise.resolve({ ok: false });
    }) as unknown as typeof fetch;

    const { rerender } = render(
      <GlobalStateProvider>
        <GlobalStateProbe />
      </GlobalStateProvider>,
    );

    await waitFor(() => {
      expect(requestSignal).toBeDefined();
    });

    mockAuthUser(["pro-plan"], { user: { id: "user_paid" } });
    rerender(
      <GlobalStateProvider>
        <GlobalStateProbe />
      </GlobalStateProvider>,
    );

    expect(requestSignal?.aborted).toBe(true);
    await waitFor(() => {
      expect(screen.getByTestId("subscription")).toHaveTextContent("pro");
      expect(screen.getByTestId("checking-pro-plan")).toHaveTextContent(
        "false",
      );
      expect(screen.getByTestId("paid-agent-only")).toHaveTextContent("true");
    });
  });

  it("keeps chat mode access unresolved while authentication is loading", () => {
    mockAuthUser([], { loading: true });

    render(
      <GlobalStateProvider>
        <GlobalStateProbe />
      </GlobalStateProvider>,
    );

    expect(screen.getByTestId("chat-mode-access-resolved")).toHaveTextContent(
      "false",
    );
  });

  it("syncs the active project when browser history changes", async () => {
    window.history.pushState({}, "", "/?project=project-one");

    render(
      <GlobalStateProvider>
        <ActiveProjectProbe />
      </GlobalStateProvider>,
    );

    expect(screen.getByTestId("active-project-id")).toHaveTextContent(
      "project-one",
    );

    act(() => {
      window.history.pushState({}, "", "/?project=project-two");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("active-project-id")).toHaveTextContent(
        "project-two",
      );
    });
  });

  it("defaults first-time Ultra users to Agent with the auto model and cloud sandbox", async () => {
    window.localStorage.setItem("selected_model", "hackerai-max");
    mockAuthUser(["ultra-plan"]);

    render(
      <GlobalStateProvider>
        <GlobalStateProbe />
      </GlobalStateProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("chat-mode")).toHaveTextContent("agent");
    });

    expect(screen.getByTestId("selected-model")).toHaveTextContent("auto");
    expect(screen.getByTestId("sandbox-preference")).toHaveTextContent("e2b");
  });

  it("defaults first-time Pro Plus users to Agent with the auto model and cloud sandbox", async () => {
    window.localStorage.setItem("selected_model", "hackerai-max");
    mockAuthUser(["pro-plus-plan"]);

    render(
      <GlobalStateProvider>
        <GlobalStateProbe />
      </GlobalStateProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("chat-mode")).toHaveTextContent("agent");
    });

    expect(screen.getByTestId("subscription")).toHaveTextContent("pro-plus");
    expect(screen.getByTestId("selected-model")).toHaveTextContent("auto");
    expect(screen.getByTestId("sandbox-preference")).toHaveTextContent("e2b");
  });

  it("forces returning paid users from saved Ask into Agent without overwriting permission choice", async () => {
    window.localStorage.setItem("chat_mode", "ask");
    window.localStorage.setItem("agent_permission_mode", "ask_approval");
    mockAuthUser(["pro-plan"]);

    render(
      <GlobalStateProvider>
        <GlobalStateProbe />
      </GlobalStateProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("chat-mode")).toHaveTextContent("agent");
      expect(screen.getByTestId("paid-agent-only")).toHaveTextContent("true");
    });
    expect(screen.getByTestId("agent-permission-mode")).toHaveTextContent(
      "ask_approval",
    );
  });

  it("refreshes AuthKit access token after checkout entitlement refresh before showing paid state", async () => {
    const refreshAuth = jest.fn().mockResolvedValue(undefined);
    const refreshAccessToken = jest.fn().mockResolvedValue("fresh-paid-token");

    mockAuthUser([], { refreshAuth });
    jest.mocked(useAccessToken).mockReturnValue({
      getAccessToken: jest.fn().mockResolvedValue("old-free-token"),
      accessToken: "old-free-token",
      refresh: refreshAccessToken,
    } as ReturnType<typeof useAccessToken>);
    window.localStorage.setItem(
      SHARED_TOKEN_KEY,
      JSON.stringify({
        token: "stale-free-token",
        refreshedAt: Date.now(),
      }),
    );
    window.history.pushState({}, "", "/?refresh=entitlements");
    global.fetch = jest.fn((input) => {
      const url = String(input);
      if (url === "/api/entitlements") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              entitlements: ["pro-plan"],
              subscription: "pro",
            }),
        });
      }

      if (url === "/api/referrals/attribution") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        });
      }

      return Promise.resolve({
        ok: false,
        json: () => Promise.resolve({}),
      });
    }) as unknown as typeof fetch;

    render(
      <GlobalStateProvider>
        <GlobalStateProbe />
      </GlobalStateProvider>,
    );

    await waitFor(() => {
      expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    });

    expect(refreshAuth).toHaveBeenCalledWith({ organizationId: "org_ultra" });
    expect(JSON.parse(window.localStorage.getItem(SHARED_TOKEN_KEY)!)).toEqual(
      expect.objectContaining({ token: "fresh-paid-token" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("subscription")).toHaveTextContent("pro");
      expect(screen.getByTestId("checking-pro-plan")).toHaveTextContent(
        "false",
      );
    });
  });
});
