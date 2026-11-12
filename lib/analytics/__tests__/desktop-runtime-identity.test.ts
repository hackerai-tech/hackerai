/** @jest-environment node */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockInvoke = jest.fn<(command: string) => Promise<unknown>>();
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => mockInvoke(command),
}));

type IdentityModule = typeof import("../desktop-runtime-identity");
const BUILD = "A".repeat(40);
const originalBuild = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
const host = globalThis as { window?: unknown };

/** A Tauri page: both globals are injected natively before page scripts. */
function desktopWindow(platform: unknown) {
  const win = {};
  Object.defineProperty(win, "__TAURI_INTERNALS__", { value: {} });
  Object.defineProperty(win, "__TAURI_OS_PLUGIN_INTERNALS__", {
    value: { platform, version: "private-os-version", arch: "aarch64" },
  });
  return win;
}

function load(win?: object): IdentityModule {
  if (win) host.window = win;
  let loaded!: IdentityModule;
  jest.isolateModules(() => {
    loaded = require("../desktop-runtime-identity");
  });
  return loaded;
}

describe("Desktop runtime identity", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = BUILD;
  });

  afterEach(() => {
    delete host.window;
    jest.useRealTimers();
    if (originalBuild === undefined) {
      delete process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
    } else {
      process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = originalBuild;
    }
  });

  it.each([
    ["SSR", undefined],
    ["a browser", {}],
  ])(
    "leaves %s events unchanged and never calls native IPC",
    async (_, win) => {
      const identity = load(win);
      const properties = { native_app_version: "spoofed", retained: "value" };
      await identity.startDesktopRuntimeIdentityLookup();

      expect(identity.getDesktopRuntimeIdentity()).toBeNull();
      expect(identity.withDesktopRuntimeIdentity("event", properties)).toBe(
        properties,
      );
      const event = { event: "$exception", properties };
      expect(identity.applyDesktopRuntimeIdentity(event)).toEqual({
        event: "$exception",
        properties: { native_app_version: "spoofed", retained: "value" },
      });
      expect(mockInvoke).not.toHaveBeenCalled();
    },
  );

  it("reports startup identity without the bridge, and no version until the native answer", async () => {
    let answer!: (value: unknown) => void;
    mockInvoke.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const identity = load(desktopWindow("macos"));

    // A startup error before IPC settles is still attributable, never guessed.
    expect(identity.getDesktopRuntimeIdentity()).toEqual({
      native_app_version: null,
      native_platform: "darwin",
      hackerai_frontend_build_commit: "a".repeat(40),
    });
    answer("0.0.74");
    await identity.startDesktopRuntimeIdentityLookup();

    expect(identity.getDesktopRuntimeIdentity()).toEqual({
      native_app_version: "0.0.74",
      native_platform: "darwin",
      hackerai_frontend_build_commit: "a".repeat(40),
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("plugin:app|version");
  });

  it.each<[unknown, string | null]>([
    ["macos", "darwin"],
    ["darwin", "darwin"],
    ["windows", "windows"],
    ["win32", "windows"],
    ["linux", "linux"],
    ["ios", null],
    ["freebsd", null],
    ["MacOS", null],
    ["private-host", null],
    [undefined, null],
  ])("maps native platform %p to %p", (platform, expected) => {
    mockInvoke.mockResolvedValue("0.0.74");
    const identity = load(desktopWindow(platform));
    expect(identity.getDesktopRuntimeIdentity()?.native_platform).toBe(
      expected,
    );
  });

  it("reports a null platform when the OS plugin is absent or spoofed with a getter", () => {
    mockInvoke.mockResolvedValue("0.0.74");
    const absent = {};
    Object.defineProperty(absent, "__TAURI_INTERNALS__", { value: {} });
    expect(
      load(absent).getDesktopRuntimeIdentity()?.native_platform,
    ).toBeNull();

    const getter = jest.fn(() => "macos");
    const spoofed = {};
    Object.defineProperty(spoofed, "__TAURI_INTERNALS__", { value: {} });
    Object.defineProperty(spoofed, "__TAURI_OS_PLUGIN_INTERNALS__", {
      value: Object.defineProperty({}, "platform", { get: getter }),
    });
    expect(
      load(spoofed).getDesktopRuntimeIdentity()?.native_platform,
    ).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each<[string, () => Promise<unknown>]>([
    ["rejected IPC", () => Promise.reject(new Error("private native detail"))],
    ["a private string", () => Promise.resolve("PRIVATE")],
    ["a prerelease", () => Promise.resolve("0.0.74-beta.1")],
    ["a partial version", () => Promise.resolve("0.74")],
    ["a number", () => Promise.resolve(74)],
    ["an object", () => Promise.resolve({ version: "0.0.74" })],
  ])("keeps the version null after %s without retrying", async (_, answer) => {
    mockInvoke.mockImplementation(answer);
    const identity = load(desktopWindow("macos"));
    await identity.startDesktopRuntimeIdentityLookup();
    await identity.startDesktopRuntimeIdentityLookup();

    expect(identity.getDesktopRuntimeIdentity()?.native_app_version).toBeNull();
    expect(JSON.stringify(identity.getDesktopRuntimeIdentity())).not.toMatch(
      /private|PRIVATE|beta/,
    );
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("bounds a hung lookup without blocking, and records a valid late answer", async () => {
    jest.useFakeTimers();
    let answer!: (value: unknown) => void;
    mockInvoke.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const identity = load(desktopWindow("linux"));
    const settled = jest.fn();
    void identity.startDesktopRuntimeIdentityLookup().then(settled);

    await jest.advanceTimersByTimeAsync(499);
    expect(settled).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(identity.getDesktopRuntimeIdentity()?.native_app_version).toBeNull();

    answer("0.0.73");
    jest.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(identity.getDesktopRuntimeIdentity()?.native_app_version).toBe(
      "0.0.73",
    );
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("shares one lookup across concurrent initializers and captures", async () => {
    mockInvoke.mockResolvedValue("0.0.74");
    const identity = load(desktopWindow("macos"));
    const first = identity.startDesktopRuntimeIdentityLookup();
    identity.withDesktopRuntimeIdentity("event", {});
    const second = identity.startDesktopRuntimeIdentityLookup();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "", "a".repeat(39), "g".repeat(40), "main"])(
    "sends an explicit null for an unavailable frontend build (%p)",
    (build) => {
      if (build === undefined) {
        delete process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
      } else {
        process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = build;
      }
      mockInvoke.mockResolvedValue("0.0.74");
      const sent = load(desktopWindow("macos")).withDesktopRuntimeIdentity(
        "e",
        {},
      );
      expect(sent).toHaveProperty("hackerai_frontend_build_commit", null);
    },
  );

  describe("with a measured identity", () => {
    let identity: IdentityModule;
    beforeEach(async () => {
      mockInvoke.mockResolvedValue("0.0.74");
      identity = load(desktopWindow("macos"));
      await identity.startDesktopRuntimeIdentityLookup();
    });

    const measured = {
      native_app_version: "0.0.74",
      native_platform: "darwin",
      hackerai_frontend_build_commit: "a".repeat(40),
    };
    const receipt = {
      native_authorization_diagnostic_version: 1,
      native_authorization_send_timeout: true,
      native_authorization_send_connect: false,
      native_authorization_send_request: false,
      native_authorization_send_elapsed_ms: 1200,
      native_authorization_origin_class: "canonical_production",
      native_app_version: "0.0.73",
      native_platform: "linux",
    };

    it("replaces spoofed caller identity without mutating the caller", () => {
      const caller = {
        transport: "native_ipc",
        native_app_version: "unknown",
        native_platform: "macos",
        hackerai_frontend_build_commit: "b".repeat(40),
      };
      const sent = identity.withDesktopRuntimeIdentity(
        "desktop_file_bridge_probe_failed",
        caller,
      );
      expect(sent).toEqual({ transport: "native_ipc", ...measured });
      expect(caller.native_app_version).toBe("unknown");
    });

    it("keeps a valid same-invocation send receipt on a terminal-error ACK", () => {
      const settled = { terminalType: "error", outcome: "acknowledged" };
      expect(
        identity.withDesktopRuntimeIdentity("desktop_ack_command_settled", {
          ...settled,
          ...receipt,
        }),
      ).toEqual({
        ...settled,
        ...receipt,
        hackerai_frontend_build_commit: "a".repeat(40),
      });
      // A valid null member can use the independent native measurement.
      expect(
        identity.withDesktopRuntimeIdentity("desktop_ack_command_settled", {
          ...settled,
          ...receipt,
          native_app_version: null,
        }),
      ).toMatchObject({
        native_app_version: "0.0.74",
        native_platform: "linux",
      });
    });

    it.each<[string, string, Record<string, unknown>]>([
      ["an invalid receipt member", "error", { native_platform: "private" }],
      [
        "an incomplete receipt",
        "error",
        { native_authorization_send_timeout: undefined },
      ],
      ["a non-error ACK", "exit", {}],
    ])(
      "does not let %s override measured identity",
      (_, terminalType, override) => {
        const sent = identity.withDesktopRuntimeIdentity(
          "desktop_ack_command_settled",
          { terminalType, ...receipt, ...override },
        );
        expect(sent).toMatchObject(measured);
      },
    );

    it("does not honor a receipt group on any other event", () => {
      expect(
        identity.withDesktopRuntimeIdentity("ordinary_event", {
          terminalType: "error",
          ...receipt,
        }),
      ).toMatchObject(measured);
    });

    it("adds identity to an SDK event without properties", () => {
      expect(
        identity.applyDesktopRuntimeIdentity({ event: "$exception" }),
      ).toEqual({
        event: "$exception",
        properties: measured,
      });
    });
  });
});
