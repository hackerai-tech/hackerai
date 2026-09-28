import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

let mockSubscription = "free";
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({ subscription: mockSubscription }),
}));

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), message: jest.fn() },
}));

// Load after the mocks above so the component sees them.
const { ModelProvidersTab } = jest.requireActual<
  typeof import("../ModelProvidersTab")
>("../ModelProvidersTab");
const { useOrcaRouterConnect, useOrcaRouterModels } = jest.requireActual<
  typeof import("@/app/hooks/useOrcaRouter")
>("@/app/hooks/useOrcaRouter");

type Handler = (init?: RequestInit) => { status?: number; body: unknown };
let routes: Record<string, Handler>;
const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
  const key = `${init?.method ?? "GET"} ${String(input)}`;
  const route = routes[key];
  if (!route) throw new Error(`unexpected request ${key}`);
  const { status = 200, body } = route(init);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

beforeEach(() => {
  mockSubscription = "free";
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockClear();
  routes = {
    "GET /api/orcarouter/credential": () => ({
      body: { enabled: true, connected: false },
    }),
  };
});

describe("ModelProvidersTab", () => {
  it("offers API key and OrcaRouter sign-in side by side", async () => {
    render(<ModelProvidersTab />, { wrapper });

    const keyOption = await screen.findByTestId("orcarouter-api-key-option");
    const pkceOption = screen.getByTestId("orcarouter-pkce-option");
    expect(keyOption).toBeVisible();
    expect(pkceOption).toBeVisible();
    expect(screen.getByLabelText("OrcaRouter API key")).toHaveAttribute(
      "type",
      "password",
    );
    expect(
      screen.getByRole("button", { name: "Connect OrcaRouter" }),
    ).toBeEnabled();
  });

  it("saves a pasted key and shows only its masked hint", async () => {
    routes["PUT /api/orcarouter/credential"] = (init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        apiKey: "sk-orca-pasted-1234",
      });
      return {
        body: {
          enabled: true,
          connected: true,
          source: "api_key",
          status: "active",
          keyHint: "…1234",
          updatedAt: 1,
        },
      };
    };
    render(<ModelProvidersTab />, { wrapper });

    fireEvent.change(await screen.findByLabelText("OrcaRouter API key"), {
      target: { value: "sk-orca-pasted-1234" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    const status = await screen.findByTestId("orcarouter-status");
    expect(status).toHaveTextContent("Connected with API key …1234");
    expect(document.body).not.toHaveTextContent("sk-orca-pasted-1234");
    expect(screen.getByLabelText("OrcaRouter API key")).toHaveValue("");
  });

  it("refreshes the model catalog after a new key is saved", async () => {
    let catalogFetches = 0;
    routes["GET /api/orcarouter/models"] = () => {
      catalogFetches += 1;
      return { body: { status: "live", models: [] } };
    };
    routes["PUT /api/orcarouter/credential"] = () => ({
      body: {
        enabled: true,
        connected: true,
        source: "api_key",
        status: "active",
        keyHint: "…9999",
        updatedAt: 2,
      },
    });
    const Both = () => {
      useOrcaRouterModels(true);
      return <ModelProvidersTab />;
    };
    render(<Both />, { wrapper });
    await waitFor(() => expect(catalogFetches).toBe(1));

    fireEvent.change(await screen.findByLabelText("OrcaRouter API key"), {
      target: { value: "sk-orca-new-9999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(catalogFetches).toBe(2));
  });

  it("prompts to reconnect after the key was revoked", async () => {
    routes["GET /api/orcarouter/credential"] = () => ({
      body: {
        enabled: true,
        connected: true,
        source: "pkce",
        status: "needs_reauth",
        keyHint: "…abcd",
        updatedAt: 1,
      },
    });
    render(<ModelProvidersTab />, { wrapper });
    expect(
      await screen.findByText(/OrcaRouter rejected the saved key/),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Connect OrcaRouter" }),
    ).toBeEnabled();
  });

  it("shows no Agent-mode note on the free plan", async () => {
    render(<ModelProvidersTab />, { wrapper });
    await screen.findByTestId("orcarouter-api-key-option");
    expect(
      screen.queryByTestId("orcarouter-agent-mode-note"),
    ).not.toBeInTheDocument();
  });

  it("still lets paid-plan users manage a saved key", async () => {
    mockSubscription = "pro";
    routes["GET /api/orcarouter/credential"] = () => ({
      body: {
        enabled: true,
        connected: true,
        source: "pkce",
        status: "active",
        keyHint: "…abcd",
        updatedAt: 1,
      },
    });
    render(<ModelProvidersTab />, { wrapper });
    expect(
      await screen.findByTestId("orcarouter-agent-mode-note"),
    ).toHaveTextContent("does not use OrcaRouter yet");
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled();
  });

  it("explains when the deployment has not enabled OrcaRouter", async () => {
    routes["GET /api/orcarouter/credential"] = () => ({
      body: { enabled: false, connected: false },
    });
    render(<ModelProvidersTab />, { wrapper });
    expect(
      await screen.findByText(/not enabled on this HackerAI deployment/),
    ).toBeVisible();
  });
});

describe("useOrcaRouterConnect", () => {
  it("navigates to the consent URL returned by the server", async () => {
    routes["POST /api/orcarouter/connect"] = () => ({
      body: { authorizeUrl: "https://www.orcarouter.ai/auth?state=s" },
    });
    const navigate = jest.fn();
    const { result } = renderHook(() => useOrcaRouterConnect(navigate));

    await act(() => result.current.connect());
    expect(navigate).toHaveBeenCalledWith(
      "https://www.orcarouter.ai/auth?state=s",
    );
  });

  it("releases the busy state on failure", async () => {
    routes["POST /api/orcarouter/connect"] = () => ({
      status: 503,
      body: { error: "OrcaRouter is not enabled on this deployment." },
    });
    const { result } = renderHook(() => useOrcaRouterConnect(jest.fn()));

    await act(async () => {
      await expect(result.current.connect()).rejects.toThrow(
        "OrcaRouter is not enabled on this deployment.",
      );
    });
    expect(result.current.isConnecting).toBe(false);
  });

  it("clears busy state on pagehide so a restored page can connect again", async () => {
    let release!: () => void;
    routes["POST /api/orcarouter/connect"] = () => ({
      body: { authorizeUrl: "https://www.orcarouter.ai/auth?state=late" },
    });
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => ({
                authorizeUrl: "https://www.orcarouter.ai/auth?state=stale",
              }),
            } as Response);
        }),
    );
    const navigate = jest.fn();
    const { result } = renderHook(() => useOrcaRouterConnect(navigate));

    let firstAttempt!: Promise<void>;
    act(() => {
      firstAttempt = result.current.connect();
    });
    expect(result.current.isConnecting).toBe(true);

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(result.current.isConnecting).toBe(false);

    // The stale attempt resolving later must not navigate or re-lock.
    await act(async () => {
      release();
      await firstAttempt;
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(result.current.isConnecting).toBe(false);

    // Without remounting, a second login can start and complete.
    await act(() => result.current.connect());
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        "https://www.orcarouter.ai/auth?state=late",
      ),
    );
  });
});
