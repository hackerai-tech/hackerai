import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import {
  DESKTOP_UPDATE_URL,
  navigateToAuth,
  pickLocalFolder,
} from "../useTauri";

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}));

jest.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: jest.fn(),
}));

jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: jest.fn(),
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
  },
}));

const mockInvoke = invoke as jest.Mock;
const mockDialogOpen = open as jest.Mock;
const mockOpenUrl = openUrl as jest.Mock;
const mockToastError = toast.error as jest.Mock;
let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

function setTauriEnvironment() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
}

describe("navigateToAuth", () => {
  beforeEach(() => {
    setTauriEnvironment();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockOpenUrl.mockResolvedValue(undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: undefined,
    });
  });

  it("opens desktop login with a desktop auth state when supported", async () => {
    const desktopAuthState = "a".repeat(64);
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "prepare_desktop_auth_state") {
        return desktopAuthState;
      }
      if (command === "get_dev_auth_port") {
        return 0;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await navigateToAuth("/signup?returnTo=%2Fsettings");

    expect(mockOpenUrl).toHaveBeenCalledWith(
      `http://localhost/desktop-login?returnTo=%2Fsettings&desktop_state=${desktopAuthState}&screen_hint=sign-up`,
    );
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("opens the latest desktop release when the secure auth bridge is missing", async () => {
    mockInvoke.mockRejectedValue(new Error("unknown command"));

    await navigateToAuth("/login");

    expect(mockToastError).toHaveBeenCalledWith(
      "Update HackerAI Desktop to sign in",
      expect.objectContaining({
        description: expect.stringContaining("secure sign-in bridge"),
      }),
    );
    expect(mockOpenUrl).toHaveBeenCalledTimes(1);
    expect(mockOpenUrl).toHaveBeenCalledWith(DESKTOP_UPDATE_URL);
  });
});

describe("pickLocalFolder", () => {
  beforeEach(() => {
    setTauriEnvironment();
    mockDialogOpen.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: undefined,
    });
  });

  it("opens a single-directory picker and returns the selected path", async () => {
    mockDialogOpen.mockResolvedValue("/Users/hackerai/targets/acme");

    await expect(pickLocalFolder()).resolves.toBe(
      "/Users/hackerai/targets/acme",
    );
    expect(mockDialogOpen).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
    });
  });

  it("returns null when the user cancels", async () => {
    mockDialogOpen.mockResolvedValue(null);

    await expect(pickLocalFolder()).resolves.toBeNull();
  });
});
