import "@testing-library/jest-dom";
import { useEffect } from "react";
import { act, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockCapture =
  jest.fn<(event: string, properties: Record<string, unknown>) => boolean>();
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: (
    event: string,
    properties: Record<string, unknown>,
  ) => mockCapture(event, properties),
}));

const { ChatStartersProvider, useChatStarters } =
  require("../ChatStartersContext") as typeof import("../ChatStartersContext");

type Starters = NonNullable<ReturnType<typeof useChatStarters>>;
let latest: ReturnType<typeof useChatStarters> = null;
const Probe = () => {
  const value = useChatStarters();
  // Publish after commit so assertions read the rendered value.
  useEffect(() => {
    latest = value;
  }, [value]);
  return (
    <output data-testid="starters">
      {value
        ? `${value.userId}:${value.enabled}:${value.presentation}`
        : "none"}
    </output>
  );
};
const current = () => latest as Starters;

const RESOLVED_EMPTY_CHATS = { status: "Exhausted", results: [] };
const LOADING_CHATS = { status: "LoadingFirstPage", results: [] };
const EMPTY_PROJECTS = { results: [] };
const LOADING_PROJECTS = { results: undefined };

const mockFetch = jest.fn<typeof fetch>();
const flagResponse = (enabled: unknown) =>
  ({ ok: true, json: async () => ({ enabled }) }) as Response;

// Let the provider's flag request settle inside act.
const settle = () => act(async () => {});

const renderProvider = async ({
  userId = "user-a" as string | null,
  chats = RESOLVED_EMPTY_CHATS as { status: string; results?: unknown[] },
  projects = EMPTY_PROJECTS as { results?: unknown[] },
} = {}) => {
  const view = (props: {
    userId: string | null;
    chats: { status: string; results?: unknown[] };
    projects: { results?: unknown[] };
  }) => (
    <ChatStartersProvider {...props}>
      <Probe />
    </ChatStartersProvider>
  );
  let props = { userId, chats, projects };
  const result = render(view(props));
  await settle();
  return {
    rerender: async (next: Partial<typeof props>) => {
      props = { ...props, ...next };
      result.rerender(view(props));
      await settle();
    },
  };
};

describe("ChatStartersProvider", () => {
  beforeEach(() => {
    latest = null;
    window.localStorage.clear();
    mockCapture.mockReset().mockReturnValue(true);
    mockFetch.mockReset().mockResolvedValue(flagResponse(true));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: mockFetch,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("stays off without an authenticated user", async () => {
    await renderProvider({ userId: null });

    expect(screen.getByTestId("starters").textContent).toBe("none");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("expands only after both history lists resolve empty", async () => {
    const view = await renderProvider({
      chats: LOADING_CHATS,
      projects: LOADING_PROJECTS,
    });
    expect(current().enabled).toBe(true);
    expect(current().presentation).toBeNull();

    await view.rerender({ chats: RESOLVED_EMPTY_CHATS });
    expect(current().presentation).toBeNull();

    await view.rerender({ projects: EMPTY_PROJECTS });
    expect(current().presentation).toBe("expanded");
  });

  it.each([
    ["chats", { chats: { status: "LoadingFirstPage", results: [{}] } }],
    ["projects", { projects: { results: [{}] } }],
  ])(
    "collapses returning users with existing %s before every list resolves",
    async (_kind, history) => {
      await renderProvider({
        chats: LOADING_CHATS,
        projects: LOADING_PROJECTS,
        ...history,
      });

      expect(current().presentation).toBe("collapsed");
    },
  );

  it("collapses after a first submission, before history refreshes, and only for that account", async () => {
    const view = await renderProvider();
    expect(current().presentation).toBe("expanded");

    act(() => current().markFirstSubmission());
    expect(current().presentation).toBe("collapsed");

    await view.rerender({ userId: "user-b" });
    expect(current().userId).toBe("user-b");
    expect(current().presentation).toBe("expanded");

    await view.rerender({ userId: "user-a" });
    expect(current().presentation).toBe("collapsed");
  });

  it("restores the first-submission marker for the same account on a later visit", async () => {
    const first = render(
      <ChatStartersProvider
        userId="user-a"
        chats={RESOLVED_EMPTY_CHATS}
        projects={EMPTY_PROJECTS}
      >
        <Probe />
      </ChatStartersProvider>,
    );
    await settle();
    act(() => current().markFirstSubmission());
    first.unmount();

    await renderProvider();
    expect(current().presentation).toBe("collapsed");
  });

  it("keeps working when local storage is unavailable", async () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });

    await renderProvider();
    expect(current().presentation).toBe("expanded");

    act(() => current().markFirstSubmission());
    expect(current().presentation).toBe("collapsed");
  });

  it.each([
    ["a disabled flag", () => mockFetch.mockResolvedValue(flagResponse(false))],
    [
      "a non-boolean flag",
      () => mockFetch.mockResolvedValue(flagResponse("on")),
    ],
    [
      "an auth rejection",
      () =>
        mockFetch.mockResolvedValue({
          ok: false,
          json: async () => ({ enabled: true }),
        } as Response),
    ],
    [
      "a network failure",
      () => mockFetch.mockRejectedValue(new TypeError("offline")),
    ],
  ])("stays disabled after %s", async (_case, arrange) => {
    arrange();
    await renderProvider();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(current().enabled).toBe(false);
  });

  it("never exposes one account's flag to the next account", async () => {
    let resolveSecond: (response: Response) => void = () => {};
    mockFetch
      .mockResolvedValueOnce(flagResponse(true))
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => (resolveSecond = resolve)),
      );
    const view = await renderProvider();
    expect(current().enabled).toBe(true);

    await view.rerender({ userId: "user-b" });
    expect(current().userId).toBe("user-b");
    expect(current().enabled).toBe(false);
    const firstSignal = mockFetch.mock.calls[0][1]?.signal;
    expect(firstSignal?.aborted).toBe(true);

    await act(async () => resolveSecond(flagResponse(false)));
    expect(current().enabled).toBe(false);
  });

  it("records one exposure per account, mode and presentation", async () => {
    const view = await renderProvider();

    act(() => {
      current().recordExposure("agent", "expanded");
      current().recordExposure("agent", "expanded");
      current().recordExposure("ask", "expanded");
      current().recordExposure("agent", "collapsed");
    });
    await view.rerender({ userId: "user-b" });
    act(() => current().recordExposure("agent", "expanded"));

    expect(mockCapture.mock.calls).toEqual([
      [
        "chat_starters_exposed",
        { definition_version: 1, mode: "agent", presentation: "expanded" },
      ],
      [
        "chat_starters_exposed",
        { definition_version: 1, mode: "ask", presentation: "expanded" },
      ],
      [
        "chat_starters_exposed",
        { definition_version: 1, mode: "agent", presentation: "collapsed" },
      ],
      [
        "chat_starters_exposed",
        { definition_version: 1, mode: "agent", presentation: "expanded" },
      ],
    ]);
  });

  it("retries an exposure that analytics could not capture yet", async () => {
    mockCapture.mockReturnValueOnce(false);
    await renderProvider();

    act(() => {
      current().recordExposure("agent", "expanded");
      current().recordExposure("agent", "expanded");
      current().recordExposure("agent", "expanded");
    });

    expect(mockCapture).toHaveBeenCalledTimes(2);
  });
});
