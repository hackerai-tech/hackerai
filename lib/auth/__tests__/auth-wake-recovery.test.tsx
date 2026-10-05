import { act, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { useAuthFromAuthKit, type AuthKitDeps } from "../use-auth-from-authkit";
import { CrossTabMutex } from "../cross-tab-mutex";

// Bypass the repository's convex/react mock: the regression is specifically
// about the real provider's effects after its backend reports auth failure.
const { ConvexProviderWithAuth, useConvexAuth } = jest.requireActual<
  typeof import("convex/react")
>("../../../node_modules/convex/dist/cjs/react/ConvexAuthState.js");

type FetchToken = ReturnType<typeof useAuthFromAuthKit>["fetchAccessToken"];

describe("auth recovery through ConvexProviderWithAuth", () => {
  const signedInUser = { id: "user-1" };
  let user: typeof signedInUser | null;
  let token: string | undefined;
  let offline: boolean;
  let ended: boolean;
  let fetchToken: FetchToken;
  let reportAuth: (authenticated: boolean) => void;
  let getAccessToken: jest.Mock;
  let refreshAuth: jest.Mock;
  let deps: AuthKitDeps;
  let client: ComponentProps<typeof ConvexProviderWithAuth>["client"];
  let observations: Array<{ isLoading: boolean; isAuthenticated: boolean }>;
  let renderApp: () => React.ReactNode;

  beforeEach(() => {
    jest.useFakeTimers();
    localStorage.clear();
    user = signedInUser;
    token = "old-token";
    offline = false;
    ended = false;
    observations = [];
    getAccessToken = jest.fn(async () => {
      if (offline) throw new Error("Network request timed out");
      return ended ? undefined : token;
    });
    refreshAuth = jest.fn(async () => {
      if (offline) return { error: "Network request timed out" };
      if (ended) user = null;
    });
    deps = {
      useAuth: (() => ({
        user,
        loading: false,
        sessionId: user ? "session-1" : undefined,
        refreshAuth,
      })) as AuthKitDeps["useAuth"],
      useAccessToken: (() => ({
        accessToken: token,
        getAccessToken,
        refresh: getAccessToken,
      })) as AuthKitDeps["useAccessToken"],
      mutex: new CrossTabMutex(),
      isCrossTabEnabled: () => false,
    };
    client = {
      setAuth: jest.fn((fetch, onChange) => {
        fetchToken = fetch;
        reportAuth = onChange;
        void fetch({ forceRefreshToken: false }).then((value) => {
          onChange(Boolean(value && !offline && !ended));
        });
      }),
      clearAuth: jest.fn(),
    };
    function useTestAuth() {
      return useAuthFromAuthKit(deps);
    }
    function Shell() {
      const [draft, setDraft] = useState("unsent draft");
      return (
        <aside>
          Chat sidebar
          <input
            aria-label="Draft"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </aside>
      );
    }
    function Page() {
      const auth = useConvexAuth();
      observations.push(auth);
      // The same returning-user condition used by both chat routes/layout.
      return auth.isAuthenticated || auth.isLoading ? (
        <Shell />
      ) : (
        <div>Signed out</div>
      );
    }
    renderApp = () => (
      <ConvexProviderWithAuth client={client} useAuth={useTestAuth}>
        <Page />
      </ConvexProviderWithAuth>
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  async function loseConnection() {
    offline = true;
    await act(async () => {
      await fetchToken({ forceRefreshToken: true });
      reportAuth(false);
    });
  }

  it.each([false, true])(
    "keeps the shell mounted and reauthenticates without interaction (cross-tab=%s)",
    async (crossTabEnabled) => {
      deps.isCrossTabEnabled = () => crossTabEnabled;
      const view = await act(async () => render(renderApp()));
      const draft = screen.getByLabelText("Draft");
      expect(observations.at(-1)?.isAuthenticated).toBe(true);
      await loseConnection();
      expect(observations.at(-1)?.isLoading).toBe(true);
      expect(screen.queryByText("Signed out")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Draft")).toBe(draft);

      offline = false;
      token = "fresh-token";
      // AuthKit updates its token store with the same user and stable callbacks.
      await act(async () => view.rerender(renderApp()));
      expect(observations.at(-1)?.isAuthenticated).toBe(true);
      expect(screen.getByLabelText("Draft")).toBe(draft);
      expect(
        observations.some(
          (state) => !state.isLoading && !state.isAuthenticated,
        ),
      ).toBe(false);

      const calls = (client.setAuth as jest.Mock).mock.calls.length;
      token = "routine-rotation";
      await act(async () => view.rerender(renderApp()));
      expect(client.setAuth).toHaveBeenCalledTimes(calls);
    },
  );

  it("retries after cooldown even when the token store has not emitted a change", async () => {
    await act(async () => render(renderApp()));
    await loseConnection();
    const attempts = getAccessToken.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("pageshow"));
      await jest.advanceTimersByTimeAsync(9_999);
    });
    expect(getAccessToken).toHaveBeenCalledTimes(attempts);
    offline = false;
    token = "fresh-token";
    await act(async () => jest.advanceTimersByTimeAsync(1));
    expect(observations.at(-1)?.isAuthenticated).toBe(true);
  });

  it("does not retry while offline and resumes on the online event", async () => {
    await act(async () => render(renderApp()));
    await loseConnection();
    const online = jest
      .spyOn(navigator, "onLine", "get")
      .mockReturnValue(false);
    const attempts = getAccessToken.mock.calls.length;
    await act(async () => jest.advanceTimersByTimeAsync(30_000));
    expect(getAccessToken).toHaveBeenCalledTimes(attempts);
    online.mockReturnValue(true);
    offline = false;
    token = "fresh-token";
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(observations.at(-1)?.isAuthenticated).toBe(true);
  });

  it("reconciles a genuinely ended session instead of keeping the shell forever", async () => {
    const view = await act(async () => render(renderApp()));
    await loseConnection();
    offline = false;
    ended = true;
    token = undefined;
    await act(async () => jest.advanceTimersByTimeAsync(10_000));
    await act(async () => view.rerender(renderApp()));
    expect(refreshAuth).toHaveBeenCalled();
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    expect(observations.at(-1)).toMatchObject({
      isAuthenticated: false,
      isLoading: false,
    });
  });

  it("stops recovery requests when unmounted", async () => {
    const view = await act(async () => render(renderApp()));
    await loseConnection();
    view.unmount();
    const attempts = getAccessToken.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(getAccessToken).toHaveBeenCalledTimes(attempts);
  });

  it("waits while hidden and recovers when the tab becomes visible", async () => {
    await act(async () => render(renderApp()));
    await loseConnection();
    const visibility = jest
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const attempts = getAccessToken.mock.calls.length;
    await act(async () => jest.advanceTimersByTimeAsync(30_000));
    expect(getAccessToken).toHaveBeenCalledTimes(attempts);
    visibility.mockReturnValue("visible");
    offline = false;
    token = "fresh-token";
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(observations.at(-1)?.isAuthenticated).toBe(true);
  });

  it("deduplicates wake events and ignores recovery completed after sign-out", async () => {
    const view = await act(async () => render(renderApp()));
    await loseConnection();
    let resolveRecovery!: (token: string) => void;
    getAccessToken.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRecovery = resolve;
        }),
    );
    await act(async () => jest.advanceTimersByTimeAsync(10_000));
    const attempts = getAccessToken.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(getAccessToken).toHaveBeenCalledTimes(attempts);
    user = null;
    token = undefined;
    await act(async () => view.rerender(renderApp()));
    await act(async () => resolveRecovery("late-token"));
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    expect(observations.at(-1)).toMatchObject({
      isLoading: false,
      isAuthenticated: false,
    });
  });

  it("keeps retrying transient session-check failures with a cooldown", async () => {
    await act(async () => render(renderApp()));
    await loseConnection();
    getAccessToken.mockResolvedValue(undefined);
    await act(async () => jest.advanceTimersByTimeAsync(10_000));
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Signed out")).not.toBeInTheDocument();
    await act(async () => jest.advanceTimersByTimeAsync(10_000));
    expect(refreshAuth).toHaveBeenCalledTimes(2);
    offline = false;
    token = "fresh-token";
    getAccessToken.mockResolvedValue(token);
    await act(async () => jest.advanceTimersByTimeAsync(10_000));
    expect(observations.at(-1)?.isAuthenticated).toBe(true);
  });
});
