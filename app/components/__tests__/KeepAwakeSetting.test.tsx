import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockInvoke = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockToastError = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

const { KeepAwakeSetting } =
  require("../KeepAwakeSetting") as typeof import("../KeepAwakeSetting");

const getSwitch = () =>
  screen.getByRole("switch", { name: "Keep awake while Agent works" });

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
}

describe("KeepAwakeSetting", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockToastError.mockReset();
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });

  it("is not shown in a browser", async () => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const { container } = render(<KeepAwakeSetting />);
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("is not shown on a Desktop build without the setting", async () => {
    mockInvoke.mockRejectedValue(new Error("command not found"));
    const { container } = render(<KeepAwakeSetting />);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows this device's saved value and turns it off", async () => {
    mockInvoke.mockImplementation(async (command) =>
      command === "get_keep_awake_enabled" ? true : false,
    );
    render(<KeepAwakeSetting />);

    await waitFor(() => expect(getSwitch()).toBeChecked());
    fireEvent.click(getSwitch());

    await waitFor(() => expect(getSwitch()).not.toBeChecked());
    expect(mockInvoke).toHaveBeenCalledWith("set_keep_awake_enabled", {
      enabled: false,
    });
  });

  it("keeps the shown value when saving fails", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "get_keep_awake_enabled") return true;
      throw new Error("Could not save this setting. Try again.");
    });
    render(<KeepAwakeSetting />);

    await waitFor(() => expect(getSwitch()).toBeChecked());
    fireEvent.click(getSwitch());

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(getSwitch()).toBeChecked();
    expect(getSwitch()).toBeEnabled();
  });

  it("notes that some Linux desktops may ignore it", async () => {
    setUserAgent("Mozilla/5.0 (X11; Linux x86_64)");
    mockInvoke.mockResolvedValue(true);
    render(<KeepAwakeSetting />);

    await waitFor(() =>
      expect(screen.getByText(/Some Linux desktops/)).toBeInTheDocument(),
    );
  });
});
