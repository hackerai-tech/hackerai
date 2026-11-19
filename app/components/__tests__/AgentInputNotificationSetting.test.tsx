import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockInvoke = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const { AgentInputNotificationSetting } =
  require("../AgentInputNotificationSetting") as typeof import("../AgentInputNotificationSetting");
const {
  readAgentInputNotificationsEnabled,
  writeAgentInputNotificationsEnabled,
} =
  require("@/lib/chat/agent-input-notifications") as typeof import("@/lib/chat/agent-input-notifications");

const requestPermission = jest.fn<() => Promise<NotificationPermission>>();

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

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
}

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const getSwitch = () =>
  screen.getByRole("switch", { name: "Agent input notifications" });

describe("AgentInputNotificationSetting", () => {
  beforeEach(() => {
    localStorage.clear();
    requestPermission.mockReset();
    mockInvoke.mockReset();
    setUserAgent(DESKTOP_UA);
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
    delete (window as { Notification?: unknown }).Notification;
    delete (navigator as { locks?: unknown }).locks;
  });

  it("is off by default and explains that a tab must stay open", async () => {
    render(<AgentInputNotificationSetting />);

    const toggle = await waitFor(getSwitch);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleDescription(
      "Alert me when Agent needs an answer or approval. Works while a HackerAI tab is open.",
    );
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("requests browser permission when enabled and can be turned off", async () => {
    requestPermission.mockImplementation(async () => {
      installBrowserNotifications("granted");
      return "granted";
    });
    render(<AgentInputNotificationSetting />);

    fireEvent.click(await waitFor(getSwitch));

    await waitFor(() =>
      expect(getSwitch()).toHaveAttribute("aria-checked", "true"),
    );
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(readAgentInputNotificationsEnabled("user-1")).toBe(true);

    fireEvent.click(getSwitch());
    await waitFor(() =>
      expect(getSwitch()).toHaveAttribute("aria-checked", "false"),
    );
    expect(readAgentInputNotificationsEnabled("user-1")).toBe(false);
  });

  it("stays off with recovery steps when permission is denied", async () => {
    requestPermission.mockImplementation(async () => {
      installBrowserNotifications("denied");
      return "denied";
    });
    render(<AgentInputNotificationSetting />);

    fireEvent.click(await waitFor(getSwitch));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Notifications are blocked for this site. Allow them in your browser's site settings, then turn this on.",
    );
    expect(getSwitch()).toHaveAttribute("aria-checked", "false");
    expect(readAgentInputNotificationsEnabled("user-1")).toBe(false);
  });

  it("shows a revoked permission honestly and turns off without a prompt", async () => {
    writeAgentInputNotificationsEnabled("user-1", true);
    installBrowserNotifications("denied");
    render(<AgentInputNotificationSetting />);

    const toggle = await waitFor(getSwitch);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Notifications are blocked for this site. Allow them in your browser's site settings.",
    );

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(getSwitch()).toHaveAttribute("aria-checked", "false"),
    );
    expect(requestPermission).not.toHaveBeenCalled();
    expect(readAgentInputNotificationsEnabled("user-1")).toBe(false);
  });

  it.each([
    [
      "the browser has no Web Locks",
      () => {
        delete (navigator as { locks?: unknown }).locks;
      },
    ],
    [
      "the browser has no Notification API",
      () => {
        delete (window as { Notification?: unknown }).Notification;
      },
    ],
    [
      "the page is not a secure context",
      () => {
        Object.defineProperty(window, "isSecureContext", {
          configurable: true,
          value: false,
        });
      },
    ],
    [
      "the browser is mobile",
      () => {
        setUserAgent(
          "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36",
        );
      },
    ],
    [
      "the Desktop WebView has no Web Locks",
      () => {
        (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
        mockInvoke.mockResolvedValue("granted");
        delete (navigator as { locks?: unknown }).locks;
      },
    ],
  ])("is hidden when %s", async (_case, arrange) => {
    arrange();
    const { container } = render(<AgentInputNotificationSetting />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("is hidden on Desktop builds without the native command", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    mockInvoke.mockRejectedValue(
      new Error("Command agent_notification_permission not found"),
    );
    const { container } = render(<AgentInputNotificationSetting />);

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("agent_notification_permission", {
        request: false,
      }),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("asks Desktop for OS permission and shows system recovery steps", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    mockInvoke.mockImplementation(async (_command, args) =>
      (args as { request: boolean }).request ? "denied" : "prompt",
    );
    render(<AgentInputNotificationSetting />);

    const toggle = await waitFor(getSwitch);
    expect(toggle).toHaveAccessibleDescription(
      "Alert me when Agent needs an answer or approval",
    );
    fireEvent.click(toggle);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Notifications are blocked for HackerAI. Allow them in your system notification settings, then turn this on.",
    );
    expect(mockInvoke).toHaveBeenCalledWith("agent_notification_permission", {
      request: true,
    });
    expect(getSwitch()).toHaveAttribute("aria-checked", "false");
  });
});
