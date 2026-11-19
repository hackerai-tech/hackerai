import "@testing-library/jest-dom";
import { act, render, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

type Pending = Array<{ chatId: string; requestId: string }> | undefined;

let mockPending: Pending;
const mockPush = jest.fn();
const mockRouter = { push: mockPush };
const mockInvoke = jest.fn<(...args: unknown[]) => Promise<unknown>>();
let mockOpenListener: ((event: { payload: unknown }) => void) | null = null;
let mockConvexAuthenticated = true;

jest.mock("convex/react", () => ({
  useQuery: (_query: unknown, args: unknown) =>
    args === "skip" ? undefined : mockPending,
  useConvexAuth: () => ({
    isAuthenticated: mockConvexAuthenticated,
    isLoading: !mockConvexAuthenticated,
  }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
}));
jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock("@tauri-apps/api/event", () => ({
  listen: async (
    _event: string,
    handler: (event: { payload: unknown }) => void,
  ) => {
    mockOpenListener = handler;
    return () => {
      if (mockOpenListener === handler) mockOpenListener = null;
    };
  },
}));

const { AgentInputNotifications } =
  require("../AgentInputNotifications") as typeof import("../AgentInputNotifications");
const { writeAgentInputNotificationsEnabled } =
  require("@/lib/chat/agent-input-notifications") as typeof import("@/lib/chat/agent-input-notifications");

const CHAT_A = "11111111-1111-4111-8111-111111111111";
const CHAT_B = "22222222-2222-4222-8222-222222222222";
const waitA = {
  chatId: CHAT_A,
  requestId: JSON.stringify(["question", "run-a", "tool-a"]),
};
const waitB = {
  chatId: CHAT_B,
  requestId: JSON.stringify(["approval", "run-b", "approval-b"]),
};
const waitB2 = {
  chatId: CHAT_B,
  requestId: JSON.stringify(["question", "run-b", "tool-b2"]),
};

class MockNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = jest.fn();
  static instances: MockNotification[] = [];
  onclick: (() => void) | null = null;
  close = jest.fn();
  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    MockNotification.instances.push(this);
  }
}

let focused = false;
let lockGate: Promise<void> = Promise.resolve();

function installWebLocks() {
  let tail = Promise.resolve();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_name: string, callback: () => Promise<unknown>) => {
        const run = tail.then(() => lockGate).then(callback);
        tail = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    },
  });
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 5; index++) await Promise.resolve();
  });
}

function renderTab() {
  const view = render(<AgentInputNotifications />);
  return {
    ...view,
    update(next: Pending) {
      mockPending = next;
      view.rerender(<AgentInputNotifications />);
    },
  };
}

describe("AgentInputNotifications", () => {
  beforeEach(() => {
    localStorage.clear();
    mockPending = undefined;
    mockPush.mockReset();
    mockInvoke.mockReset();
    mockOpenListener = null;
    mockConvexAuthenticated = true;
    focused = false;
    lockGate = Promise.resolve();
    installWebLocks();
    MockNotification.instances = [];
    MockNotification.permission = "granted";
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: MockNotification,
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    jest.spyOn(document, "hasFocus").mockImplementation(() => focused);
    jest.spyOn(window, "focus").mockImplementation(() => undefined);
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    writeAgentInputNotificationsEnabled("user-1", true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete (navigator as { locks?: unknown }).locks;
  });

  it("alerts once with a generic title for a wait that appears after the baseline", async () => {
    const tab = renderTab();
    tab.update([waitA]);
    await flush();
    expect(MockNotification.instances).toHaveLength(0);

    tab.update([waitA, waitB]);
    await waitFor(() => expect(MockNotification.instances).toHaveLength(1));
    const [notification] = MockNotification.instances;
    expect(notification.title).toBe("HackerAI needs your input");
    expect(notification.options).toEqual({ tag: waitB.requestId });

    // A reconnect replays the same waits; nothing new is shown.
    tab.update(undefined);
    tab.update([waitA, waitB]);
    await flush();
    expect(MockNotification.instances).toHaveLength(1);
  });

  it("takes its baseline only after Convex auth resolves", async () => {
    // During auth loading the query answers as signed out.
    mockConvexAuthenticated = false;
    const tab = renderTab();
    tab.update([]);
    await flush();

    mockConvexAuthenticated = true;
    tab.update([waitA]);
    await flush();
    expect(MockNotification.instances).toHaveLength(0);

    tab.update([waitA, waitB]);
    await waitFor(() => expect(MockNotification.instances).toHaveLength(1));
    expect(MockNotification.instances[0].options).toEqual({
      tag: waitB.requestId,
    });
  });

  it("opens a legacy slug chat from a browser alert", async () => {
    const legacy = { chatId: "legacy_chat-1", requestId: "legacy-request" };
    const tab = renderTab();
    tab.update([]);
    tab.update([legacy]);
    await waitFor(() => expect(MockNotification.instances).toHaveLength(1));

    act(() => MockNotification.instances[0].onclick?.());

    expect(mockPush).toHaveBeenCalledWith("/c/legacy_chat-1");
  });

  it("delivers distinct waits in the same chat separately", async () => {
    const tab = renderTab();
    tab.update([]);
    tab.update([waitB]);
    await waitFor(() => expect(MockNotification.instances).toHaveLength(1));

    tab.update([waitB2]);
    await waitFor(() => expect(MockNotification.instances).toHaveLength(2));
  });

  it("opens the chat when the alert is clicked, even after the wait resolved", async () => {
    const tab = renderTab();
    tab.update([]);
    tab.update([waitB]);
    await waitFor(() => expect(MockNotification.instances).toHaveLength(1));
    tab.update([]);

    act(() => MockNotification.instances[0].onclick?.());

    expect(window.focus).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith(`/c/${CHAT_B}`);
    expect(MockNotification.instances[0].close).toHaveBeenCalled();
  });

  it.each([
    [
      "the app is focused",
      () => {
        focused = true;
      },
    ],
    [
      "the user opted out",
      () => {
        writeAgentInputNotificationsEnabled("user-1", false);
      },
    ],
    [
      "browser permission is denied",
      () => {
        MockNotification.permission = "denied";
      },
    ],
  ])("does not alert when %s", async (_case, arrange) => {
    const tab = renderTab();
    tab.update([]);
    act(arrange);
    tab.update([waitA]);
    await flush();

    expect(MockNotification.instances).toHaveLength(0);
  });

  it("does not replay pending waits after a reload", async () => {
    const first = renderTab();
    first.update([]);
    first.update([waitA]);
    await waitFor(() => expect(MockNotification.instances).toHaveLength(1));
    first.unmount();

    // The reloaded page's first snapshot already contains both waits.
    mockPending = [waitA, waitB];
    const reloaded = renderTab();
    reloaded.update([waitA, waitB]);
    await flush();

    expect(MockNotification.instances).toHaveLength(1);
  });

  it("shows one alert when two tabs observe the same new wait", async () => {
    const tabOne = renderTab();
    const tabTwo = renderTab();
    tabOne.update([]);
    tabTwo.update([]);

    tabOne.update([waitA]);
    tabTwo.update([waitA]);
    await flush();
    await waitFor(() => expect(MockNotification.instances).toHaveLength(1));
    await flush();

    expect(MockNotification.instances).toHaveLength(1);
  });

  it("delivers after browser permission is regranted without a remount", async () => {
    MockNotification.permission = "denied";
    const tab = renderTab();
    tab.update([]);
    tab.update([waitA]);
    await flush();
    expect(MockNotification.instances).toHaveLength(0);

    MockNotification.permission = "granted";
    tab.update([waitA, waitB]);

    await waitFor(() => expect(MockNotification.instances).toHaveLength(1));
    expect(MockNotification.instances[0].options).toEqual({
      tag: waitB.requestId,
    });
    // The denied attempt did not record a receipt for waitA.
    expect(
      JSON.parse(
        localStorage.getItem("agent_input_notification_receipts:v1:user-1")!,
      ),
    ).toEqual([waitB.requestId]);
  });

  it("does not alert from a claim still queued when the account signs out", async () => {
    let openGate = () => undefined as void;
    lockGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const tab = renderTab();
    tab.update([]);
    tab.update([waitA]);
    await flush();

    tab.unmount();
    openGate();
    await flush();

    expect(MockNotification.instances).toHaveLength(0);
  });

  it("is inactive where Web Locks cannot deduplicate alerts", async () => {
    delete (navigator as { locks?: unknown }).locks;
    const tab = renderTab();
    tab.update([]);
    tab.update([waitA]);
    await flush();

    expect(MockNotification.instances).toHaveLength(0);
  });

  it("routes Desktop alert clicks after the user opts out", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    writeAgentInputNotificationsEnabled("user-1", false);
    renderTab();

    await waitFor(() => expect(mockOpenListener).not.toBeNull());
    act(() => mockOpenListener?.({ payload: CHAT_B }));

    expect(mockPush).toHaveBeenCalledWith(`/c/${CHAT_B}`);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("uses only the native command on Desktop and routes native clicks", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    // WebKit can report stale focus; Desktop relies on the native check.
    focused = true;
    mockInvoke.mockResolvedValue(true);
    const tab = renderTab();
    tab.update([]);
    tab.update([waitA]);

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("show_agent_input_notification", {
        chatId: CHAT_A,
      }),
    );
    expect(MockNotification.instances).toHaveLength(0);

    await waitFor(() => expect(mockOpenListener).not.toBeNull());
    act(() => mockOpenListener?.({ payload: CHAT_A }));
    expect(mockPush).toHaveBeenCalledWith(`/c/${CHAT_A}`);

    // Legacy slugs route as one encoded segment; delimiters and dot segments never route.
    act(() => mockOpenListener?.({ payload: "release.notes v2" }));
    expect(mockPush).toHaveBeenLastCalledWith("/c/release.notes%20v2");
    for (const payload of ["../settings", "..", "https://evil.test", 42]) {
      act(() => mockOpenListener?.({ payload }));
    }
    expect(mockPush).toHaveBeenCalledTimes(2);
  });

  it("asks Desktop to show alerts for legacy slug chats", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    mockInvoke.mockResolvedValue(true);
    const tab = renderTab();
    tab.update([]);
    tab.update([{ chatId: "legacy_chat-1", requestId: "legacy-request" }]);

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("show_agent_input_notification", {
        chatId: "legacy_chat-1",
      }),
    );
  });
});
