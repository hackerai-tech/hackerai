import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockInvoke = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const { AgentInputNotificationPrompt } =
  require("../AgentInputNotificationPrompt") as typeof import("../AgentInputNotificationPrompt");
const {
  readAgentInputNotificationsPreference,
  writeAgentInputNotificationsEnabled,
} =
  require("@/lib/chat/agent-input-notifications") as typeof import("@/lib/chat/agent-input-notifications");

const requestPermission = jest.fn<() => Promise<NotificationPermission>>();
let hasFocus = true;

function installBrowserNotifications(permission: NotificationPermission) {
  const FakeNotification = Object.assign(function Notification() {}, {
    permission,
    requestPermission,
  });
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: FakeNotification,
  });
}

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const findOffer = () =>
  screen.findByRole("group", { name: "Agent input notifications" });
const queryOffer = () =>
  screen.queryByRole("group", { name: "Agent input notifications" });

/** Lets permission reads and lock claims settle before asserting absence. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function renderOffer(
  requestKey = "user-1:chat-1:wait:run-1:call-1",
  userId = "user-1",
) {
  return render(
    <AgentInputNotificationPrompt key={requestKey} userId={userId} />,
  );
}

describe("AgentInputNotificationPrompt", () => {
  beforeEach(() => {
    localStorage.clear();
    requestPermission.mockReset();
    mockInvoke.mockReset();
    hasFocus = true;
    jest.spyOn(document, "hasFocus").mockImplementation(() => hasFocus);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: DESKTOP_UA,
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    installBrowserNotifications("default");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: async (_name: string, run: () => unknown) => run() },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete (window as { Notification?: unknown }).Notification;
    delete (navigator as { locks?: unknown }).locks;
  });

  it("appears without prompting for permission or enabling alerts", async () => {
    renderOffer();

    const offer = await findOffer();
    expect(offer).toHaveTextContent("Get notified next time Agent needs you");
    expect(document.activeElement).toBe(document.body);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(readAgentInputNotificationsPreference("user-1")).toBeNull();
  });

  it("stays hidden on remount and later waits even if the first offer was ignored", async () => {
    const first = renderOffer();
    await findOffer();
    first.unmount();

    renderOffer();
    renderOffer("user-1:chat-1:approval:approval-2:call-2");
    await settle();
    expect(queryOffer()).not.toBeInTheDocument();
  });

  it("shows one offer when multiple open views need input", async () => {
    renderOffer();
    renderOffer("user-1:chat-2:approval:approval-2:call-2");
    await findOffer();
    await settle();
    expect(
      screen.getAllByRole("group", { name: "Agent input notifications" }),
    ).toHaveLength(1);
  });

  it("Not now closes it for this and later waits and keeps alerts off", async () => {
    const view = renderOffer();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(queryOffer()).not.toBeInTheDocument();
    view.unmount();

    renderOffer();
    renderOffer("user-1:chat-1:wait:run-2:call-2");
    await settle();
    expect(queryOffer()).not.toBeInTheDocument();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(readAgentInputNotificationsPreference("user-1")).toBeNull();
  });

  it("enables browser alerts from the click without awaiting first", async () => {
    requestPermission.mockImplementation(async () => {
      installBrowserNotifications("granted");
      return "granted";
    });
    renderOffer();

    fireEvent.click(
      await screen.findByRole("button", { name: "Enable notifications" }),
    );
    // Called inside the click handler, keeping the user's activation.
    expect(requestPermission).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(queryOffer()).not.toBeInTheDocument());
    expect(readAgentInputNotificationsPreference("user-1")).toBe("on");
  });

  it("stays open to retry when permission is granted but the setting cannot be saved", async () => {
    requestPermission.mockImplementation(async () => {
      installBrowserNotifications("granted");
      return "granted";
    });
    const originalSetItem = Storage.prototype.setItem;
    // Only the preference write fails; the seen marker is stored normally.
    const setItem = jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === "agent_input_notifications:v1:user-1")
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        originalSetItem.call(this, key, value);
      });
    const view = renderOffer();

    fireEvent.click(
      await screen.findByRole("button", { name: "Enable notifications" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Couldn’t save your notification setting. Try again.",
      ),
    );
    expect(readAgentInputNotificationsPreference("user-1")).toBeNull();
    expect(screen.getByRole("button", { name: "Not now" })).toBeEnabled();
    const retry = screen.getByRole("button", { name: "Enable notifications" });
    expect(retry).toBeEnabled();

    setItem.mockRestore();
    fireEvent.click(retry);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    await waitFor(() => expect(queryOffer()).not.toBeInTheDocument());
    expect(readAgentInputNotificationsPreference("user-1")).toBe("on");
    view.unmount();
    renderOffer("user-1:chat-1:wait:run-2:call-2");
    await settle();
    expect(queryOffer()).not.toBeInTheDocument();
  });

  it("enables Desktop alerts through the native permission command", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    mockInvoke.mockImplementation(async (_command, args) =>
      (args as { request: boolean }).request ? "granted" : "prompt",
    );
    renderOffer();

    fireEvent.click(
      await screen.findByRole("button", { name: "Enable notifications" }),
    );

    await waitFor(() => expect(queryOffer()).not.toBeInTheDocument());
    expect(mockInvoke).toHaveBeenCalledWith("agent_notification_permission", {
      request: true,
    });
    expect(readAgentInputNotificationsPreference("user-1")).toBe("on");
  });

  it("stays off and closes when the permission request is denied", async () => {
    requestPermission.mockImplementation(async () => {
      installBrowserNotifications("denied");
      return "denied";
    });
    const view = renderOffer();

    fireEvent.click(
      await screen.findByRole("button", { name: "Enable notifications" }),
    );

    await waitFor(() => expect(queryOffer()).not.toBeInTheDocument());
    expect(readAgentInputNotificationsPreference("user-1")).toBe("off");
    view.unmount();
    renderOffer("user-1:chat-1:wait:run-2:call-2");
    await settle();
    expect(queryOffer()).not.toBeInTheDocument();
  });

  it.each([
    [
      "an explicit Settings choice to keep alerts off",
      () => writeAgentInputNotificationsEnabled("user-1", false),
    ],
    [
      "alerts already enabled",
      () => writeAgentInputNotificationsEnabled("user-1", true),
    ],
    ["blocked browser permission", () => installBrowserNotifications("denied")],
    [
      "a Desktop build without the native command",
      () => {
        (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
        mockInvoke.mockRejectedValue(new Error("unknown command"));
      },
    ],
    [
      "a browser without Web Locks",
      () => {
        delete (navigator as { locks?: unknown }).locks;
      },
    ],
  ])("is suppressed by %s", async (_case, arrange) => {
    arrange();
    renderOffer();
    await settle();
    expect(queryOffer()).not.toBeInTheDocument();
  });

  it("closes when alerts are enabled from Settings while it is open", async () => {
    renderOffer();
    await findOffer();

    act(() => {
      writeAgentInputNotificationsEnabled("user-1", true);
    });

    expect(queryOffer()).not.toBeInTheDocument();
  });

  it("waits for the foreground instead of spending the offer in the background", async () => {
    hasFocus = false;
    const background = renderOffer();
    await settle();
    expect(queryOffer()).not.toBeInTheDocument();
    background.unmount();

    renderOffer("user-1:chat-1:wait:run-2:call-2");
    await settle();
    expect(queryOffer()).not.toBeInTheDocument();

    hasFocus = true;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await findOffer()).toBeInTheDocument();
  });

  it("is scoped to the signed-in account", async () => {
    const view = renderOffer();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    view.unmount();

    renderOffer("user-2:chat-1:wait:run-1:call-1", "user-2");
    expect(await findOffer()).toBeInTheDocument();
  });
});
