import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import {
  DESKTOP_UPDATE_URL,
  getLocalFileMetadata,
  navigateToAuth,
  pickLocalFiles,
  pickLocalFolder,
  readLocalFile,
  writeGeneratedTextAttachment,
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

describe("local attachment feedback after the caller's scope ends", () => {
  beforeEach(() => {
    setTauriEnvironment();
    mockInvoke.mockReset();
    mockToastError.mockClear();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: undefined,
    });
  });

  const failAfterAbort = (scope: AbortController) =>
    mockInvoke.mockImplementation(async () => {
      scope.abort();
      throw new Error("read failed");
    });

  it("does not start a read for an already ended scope", async () => {
    const scope = new AbortController();
    scope.abort();

    await expect(readLocalFile("/tmp/logo.png", scope.signal)).resolves.toBe(
      null,
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("reports a failed read only while its scope is current", async () => {
    const stale = new AbortController();
    failAfterAbort(stale);
    await expect(readLocalFile("/tmp/logo.png", stale.signal)).resolves.toBe(
      null,
    );
    expect(mockToastError).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    mockInvoke.mockRejectedValue(new Error("read failed"));
    await expect(
      readLocalFile("/tmp/logo.png", new AbortController().signal),
    ).resolves.toBe(null);
    expect(mockToastError).toHaveBeenCalledWith("Failed to read local file");
  });

  it("reports a metadata failure only for a current selection", async () => {
    const stale = new AbortController();
    failAfterAbort(stale);
    await expect(
      getLocalFileMetadata("/tmp/logo.png", stale.signal),
    ).resolves.toBeNull();
    expect(mockToastError).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    mockInvoke.mockRejectedValue(new Error("metadata failed"));
    await expect(
      getLocalFileMetadata("/tmp/logo.png", new AbortController().signal),
    ).resolves.toBeNull();
    expect(mockToastError).toHaveBeenCalledWith(
      "Failed to read local file metadata",
    );
  });

  it("does not open a legacy picker when the original scope ends first", async () => {
    const stale = new AbortController();
    mockDialogOpen.mockClear();
    mockInvoke.mockImplementation(async () => {
      stale.abort();
      throw new Error("command not registered");
    });
    await expect(pickLocalFiles(stale.signal)).resolves.toEqual([]);
    expect(mockDialogOpen).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();

    mockInvoke.mockRejectedValue(new Error("command not registered"));
    mockDialogOpen.mockResolvedValueOnce(["/tmp/logo.png"]);
    await expect(pickLocalFiles(new AbortController().signal)).resolves.toEqual(
      ["/tmp/logo.png"],
    );
    expect(mockDialogOpen).toHaveBeenCalledTimes(1);
  });

  it("ignores a legacy picker failure after the open selection ends", async () => {
    const scope = new AbortController();
    mockInvoke.mockRejectedValue(new Error("command not registered"));
    mockDialogOpen.mockImplementationOnce(async () => {
      scope.abort();
      throw new Error("legacy picker failed");
    });

    await expect(pickLocalFiles(scope.signal)).resolves.toEqual([]);
    expect(scope.signal.aborted).toBe(true);
    expect(mockToastError).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("still writes pasted text but reports failure only for the current scope", async () => {
    const stale = new AbortController();
    failAfterAbort(stale);
    await expect(
      writeGeneratedTextAttachment(
        "paste-1",
        "Pasted text.txt",
        "body",
        stale.signal,
      ),
    ).resolves.toBe(null);
    expect(mockInvoke).toHaveBeenCalledWith("write_generated_text_attachment", {
      attachmentId: "paste-1",
      fileName: "Pasted text.txt",
      content: "body",
    });
    expect(mockToastError).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    mockInvoke.mockRejectedValue(new Error("write failed"));
    await writeGeneratedTextAttachment("paste-1", "Pasted text.txt", "body");
    expect(mockToastError).toHaveBeenCalledWith(
      "Failed to save pasted text locally",
    );
  });
});
