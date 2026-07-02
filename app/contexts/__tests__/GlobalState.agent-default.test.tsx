import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { useAccessToken, useAuth } from "@workos-inc/authkit-nextjs/components";
import { GlobalStateProvider, useGlobalState } from "../GlobalState";
import { SHARED_TOKEN_KEY } from "@/lib/auth/shared-token";

const mockAuthUser = (
  entitlements: string[],
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
    chatMode,
    isCheckingProPlan,
    sandboxPreference,
    selectedModel,
    subscription,
  } = useGlobalState();

  return (
    <>
      <div data-testid="chat-mode">{chatMode}</div>
      <div data-testid="checking-pro-plan">{String(isCheckingProPlan)}</div>
      <div data-testid="sandbox-preference">{sandboxPreference}</div>
      <div data-testid="selected-model">{selectedModel}</div>
      <div data-testid="subscription">{subscription}</div>
    </>
  );
}

describe("GlobalStateProvider agent defaults", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
