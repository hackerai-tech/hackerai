import {
  cancelDesktopRunLocally,
  prepareDesktopStreamCancel,
  registerDesktopCommand,
} from "../desktop-command-cancellation";
import {
  captureAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
  getPermittedAnalyticsUserId,
} from "@/lib/analytics/client";
import { invoke } from "@tauri-apps/api/core";

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn().mockReturnValue(true),
  getIdentifiedAnalyticsUserId: jest.fn(),
  getPermittedAnalyticsUserId: jest.fn(),
}));
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }));
// Only the actual client, loaded explicitly below, ever reaches this SDK.
const mockPosthog = { __loaded: true, capture: jest.fn() };
jest.mock("posthog-js", () => ({ __esModule: true, default: mockPosthog }));

const OWNER = "user_01OWNER";
const EVENT = "desktop_stream_cancel_nonconfirmation";
let sequence = 0;
/** Registry state is module-wide, so each test uses fresh IDs. */
const fresh = () => {
  sequence++;
  const suffix = String(sequence).padStart(12, "0");
  return {
    commandId: `0193a5b2-7c41-7a10-8f00-${suffix}`,
    chatId: `chat-${sequence}`,
    runId: `run-${sequence}`,
  };
};
const events = () =>
  jest
    .mocked(captureAuthenticatedEvent)
    .mock.calls.filter(([event]) => event === EVENT)
    .map(([, properties]) => properties);
const native = jest.mocked(invoke);

/** One deferred native cancel per call, settled by the test. */
function deferNative() {
  const pending: {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];
  native.mockImplementation(
    () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  );
  return pending;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue(OWNER);
  jest.mocked(getPermittedAnalyticsUserId).mockReturnValue(OWNER);
});

describe("local run stop nonconfirmation", () => {
  it("reports the first unconfirmed local stop and keeps its failure", async () => {
    const { commandId, chatId, runId } = fresh();
    const unregister = registerDesktopCommand(commandId, chatId, runId, OWNER);
    native.mockResolvedValue(false);
    try {
      await expect(cancelDesktopRunLocally(chatId, runId)).rejects.toThrow(
        "Could not stop every local command",
      );
      // A repeated Stop still invokes native but never reports again.
      await expect(cancelDesktopRunLocally(chatId, runId)).rejects.toThrow(
        "Could not stop every local command",
      );
      expect(native.mock.calls).toEqual([
        ["cancel_stream_command", { commandId }],
        ["cancel_stream_command", { commandId }],
      ]);
      expect(events()).toEqual([
        {
          version: 1,
          command_id: commandId,
          caller: "local_run_stop",
          outcome: "returned_false",
        },
      ]);
    } finally {
      unregister();
    }
  });

  it("reports a rejected IPC with no error detail", async () => {
    const { commandId, chatId, runId } = fresh();
    const unregister = registerDesktopCommand(commandId, chatId, runId, OWNER);
    native.mockRejectedValue(new Error("PRIVATE C:\\Users\\me pid 4242"));
    try {
      await expect(cancelDesktopRunLocally(chatId, runId)).rejects.toThrow(
        "Could not stop every local command",
      );
      expect(events()).toEqual([
        {
          version: 1,
          command_id: commandId,
          caller: "local_run_stop",
          outcome: "invoke_rejected",
        },
      ]);
      const serialized = JSON.stringify(
        jest.mocked(captureAuthenticatedEvent).mock.calls,
      );
      expect(serialized).not.toContain("PRIVATE");
      expect(serialized).not.toContain("4242");
    } finally {
      unregister();
    }
  });

  it("never reports a confirmed stop", async () => {
    const { commandId, chatId, runId } = fresh();
    const unregister = registerDesktopCommand(commandId, chatId, runId, OWNER);
    native.mockResolvedValue(true);
    try {
      await expect(cancelDesktopRunLocally(chatId, runId)).resolves.toBe(
        undefined,
      );
      expect(events()).toEqual([]);
    } finally {
      unregister();
    }
  });

  it.each<[string, string | null, (id: string) => string]>([
    ["no registration owner (non-Windows)", null, (id) => id],
    ["an invalid owner", "user@example.com", (id) => id],
    ["a non-UUID command ID", OWNER, () => "PRIVATE-command"],
  ])("never reports with %s", async (_, owner, commandIdFor) => {
    const ids = fresh();
    const commandId = commandIdFor(ids.commandId);
    const unregister = registerDesktopCommand(
      commandId,
      ids.chatId,
      ids.runId,
      owner,
    );
    native.mockResolvedValue(false);
    try {
      await expect(
        cancelDesktopRunLocally(ids.chatId, ids.runId),
      ).rejects.toThrow("Could not stop every local command");
      expect(native).toHaveBeenCalledWith("cancel_stream_command", {
        commandId,
      });
      expect(events()).toEqual([]);
    } finally {
      unregister();
    }
  });

  it.each([
    ["signs out", null],
    ["switches accounts", "user_01OTHER"],
  ])("never reports after analytics identity %s", async (_, identity) => {
    const { commandId, chatId, runId } = fresh();
    const unregister = registerDesktopCommand(commandId, chatId, runId, OWNER);
    const pending = deferNative();
    try {
      const stop = cancelDesktopRunLocally(chatId, runId);
      await flush();
      jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue(identity);
      pending[0].resolve(false);
      await expect(stop).rejects.toThrow("Could not stop every local command");
      expect(events()).toEqual([]);
    } finally {
      unregister();
    }
  });

  it("reports a receipt arriving after the owner's ordinary unregister", async () => {
    const { commandId, chatId, runId } = fresh();
    const unregister = registerDesktopCommand(commandId, chatId, runId, OWNER);
    const pending = deferNative();
    const stop = cancelDesktopRunLocally(chatId, runId);
    await flush();
    expect(pending).toHaveLength(1);
    // The command settles on its own while native cancel is still waiting.
    unregister();
    pending[0].resolve(false);
    await expect(stop).rejects.toThrow("Could not stop every local command");
    expect(events()).toEqual([
      expect.objectContaining({
        command_id: commandId,
        caller: "local_run_stop",
        outcome: "returned_false",
      }),
    ]);
  });

  it("suppresses a receipt once a replacement registration holds the ID", async () => {
    const { commandId, chatId, runId } = fresh();
    const unregister = registerDesktopCommand(commandId, chatId, runId, OWNER);
    const pending = deferNative();
    const stop = cancelDesktopRunLocally(chatId, runId);
    await flush();
    unregister();
    const unregisterReplacement = registerDesktopCommand(
      commandId,
      chatId,
      "run-replacement",
      OWNER,
    );
    try {
      pending[0].resolve(false);
      await expect(stop).rejects.toThrow("Could not stop every local command");
      expect(events()).toEqual([]);
    } finally {
      unregisterReplacement();
    }
  });

  it("stays suppressed when the replacement is gone before the old cancel settles", async () => {
    const { commandId, chatId, runId } = fresh();
    const unregister = registerDesktopCommand(commandId, chatId, runId, OWNER);
    const pending = deferNative();
    const stop = cancelDesktopRunLocally(chatId, runId);
    await flush();
    unregister();
    // A replacement registers and settles before the original IPC answers.
    registerDesktopCommand(commandId, chatId, "run-replacement", OWNER)();
    pending[0].resolve(false);
    await expect(stop).rejects.toThrow("Could not stop every local command");
    expect(events()).toEqual([]);
  });
});

describe("cancel receipt races", () => {
  it.each([
    ["removed", (_: string) => {}],
    [
      "replaced",
      (commandId: string) => {
        registerDesktopCommand(commandId, "chat-other", "run-other", OWNER);
      },
    ],
  ])(
    "fails closed when the registration is %s before dispatch",
    async (_, change) => {
      const { commandId, chatId, runId } = fresh();
      const unregister = registerDesktopCommand(
        commandId,
        chatId,
        runId,
        OWNER,
      );
      const cancel = prepareDesktopStreamCancel(
        commandId,
        "relay_command_cancel",
      );
      unregister();
      change(commandId);
      native.mockResolvedValue(false);
      await expect(cancel(invoke)).resolves.toBe(false);
      await flush();
      expect(native).toHaveBeenCalledWith("cancel_stream_command", {
        commandId,
      });
      expect(events()).toEqual([]);
    },
  );

  it("reports concurrent duplicates once per caller", async () => {
    const { commandId, chatId, runId } = fresh();
    const unregister = registerDesktopCommand(commandId, chatId, runId, OWNER);
    const pending = deferNative();
    try {
      const relay = prepareDesktopStreamCancel(
        commandId,
        "relay_command_cancel",
      );
      const overflow = prepareDesktopStreamCancel(commandId, "output_overflow");
      const results = [relay(invoke), relay(invoke), overflow(invoke)];
      expect(pending).toHaveLength(3);
      pending[0].resolve(false);
      pending[1].reject(new Error("PRIVATE"));
      pending[2].resolve(false);
      await Promise.allSettled(results);
      await flush();
      expect(events()).toEqual([
        expect.objectContaining({
          caller: "relay_command_cancel",
          outcome: "returned_false",
        }),
        expect.objectContaining({
          caller: "output_overflow",
          outcome: "returned_false",
        }),
      ]);
    } finally {
      unregister();
    }
  });

  it("keeps no tombstone: a later registration of a settled ID reports normally", async () => {
    const { commandId, chatId, runId } = fresh();
    const pending = deferNative();
    const first = registerDesktopCommand(commandId, chatId, runId, OWNER);
    const original = prepareDesktopStreamCancel(
      commandId,
      "output_overflow",
    )(invoke);
    first();
    // A replacement while the original is pending is not itself superseded.
    const second = registerDesktopCommand(commandId, chatId, runId, OWNER);
    const replacement = prepareDesktopStreamCancel(
      commandId,
      "output_overflow",
    )(invoke);
    // Differing outcomes tell the two apart: only the replacement's false
    // reports; the superseded original's rejection never does.
    pending[0].reject(new Error("original transport"));
    pending[1].resolve(false);
    const settled = await Promise.allSettled([original, replacement]);
    expect(settled).toEqual([
      { status: "rejected", reason: new Error("original transport") },
      { status: "fulfilled", value: false },
    ]);
    await flush();
    expect(events()).toEqual([
      {
        version: 1,
        command_id: commandId,
        caller: "output_overflow",
        outcome: "returned_false",
      },
    ]);
    second();
    // After both settled, the same ID registers again with no leftover state.
    const third = registerDesktopCommand(commandId, chatId, runId, OWNER);
    try {
      const later = prepareDesktopStreamCancel(
        commandId,
        "output_overflow",
      )(invoke);
      pending[2].reject(new Error("transport"));
      await expect(later).rejects.toThrow("transport");
      await flush();
      expect(events()).toEqual([
        expect.objectContaining({ outcome: "returned_false" }),
        {
          version: 1,
          command_id: commandId,
          caller: "output_overflow",
          outcome: "invoke_rejected",
        },
      ]);
    } finally {
      third();
    }
  });
});

describe("one-shot capture ingress", () => {
  it.each([
    ["https://us.i.posthog.com", "https://us.i.posthog.com/i/v0/e/"],
    ["https://us.i.posthog.com/", "https://us.i.posthog.com/i/v0/e/"],
    ["https://app.posthog.com", "https://us.i.posthog.com/i/v0/e/"],
    ["https://eu.i.posthog.com", "https://eu.i.posthog.com/i/v0/e/"],
  ])("keeps the configured %s region", (host, expected) => {
    const { desktopStreamCancelCaptureUrl } = jest.requireActual<
      typeof import("@/lib/analytics/desktop-stream-cancel-diagnostic")
    >("@/lib/analytics/desktop-stream-cancel-diagnostic");
    expect(desktopStreamCancelCaptureUrl(host)).toBe(expected);
  });

  it.each([
    "http://us.i.posthog.com",
    "https://user:pass@us.i.posthog.com",
    "https://us.i.posthog.com:8443",
    "https://us.i.posthog.com/ingest",
    "https://us.i.posthog.com/?token=x",
    "https://us.i.posthog.com/#x",
    "https://us.i.posthog.com.example.com",
    "https://hackerai.co",
    "/ingest",
    undefined,
  ])("fails closed for %p", (host) => {
    const { desktopStreamCancelCaptureUrl } = jest.requireActual<
      typeof import("@/lib/analytics/desktop-stream-cancel-diagnostic")
    >("@/lib/analytics/desktop-stream-cancel-diagnostic");
    expect(desktopStreamCancelCaptureUrl(host)).toBeNull();
  });
});

describe("final analytics payload", () => {
  const originalKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const originalBuild = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
  afterEach(() => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = originalKey;
    process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = originalBuild;
  });

  it("stamps the exact bundle and survives before_send as only the closed fields", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = "AB".repeat(20);
    const { commandId, chatId, runId } = fresh();
    const unregister = registerDesktopCommand(commandId, chatId, runId, OWNER);
    native.mockResolvedValue(false);
    try {
      await expect(cancelDesktopRunLocally(chatId, runId)).rejects.toThrow();
    } finally {
      unregister();
    }
    const [[event, captured]] = jest
      .mocked(captureAuthenticatedEvent)
      .mock.calls.filter(([name]) => name === EVENT);

    // The registry's exact capture through the actual client.
    const client = jest.requireActual<typeof import("@/lib/analytics/client")>(
      "@/lib/analytics/client",
    );
    await client.loadPostHogClient();
    expect(client.captureAuthenticatedEvent(event, captured)).toBe(true);
    const [[, stamped]] = mockPosthog.capture.mock.calls as [
      [string, Record<string, unknown>],
    ];
    const fields = {
      version: 1,
      command_id: commandId,
      caller: "local_run_stop",
      outcome: "returned_false",
    };
    expect(stamped).toEqual({
      ...fields,
      hackerai_frontend_build_commit: "ab".repeat(20),
    });

    const { sanitizeDesktopStreamCancelEvent } = jest.requireActual<
      typeof import("@/lib/analytics/desktop-ack-privacy")
    >("@/lib/analytics/desktop-ack-privacy");
    const getter = jest.fn(() => "PRIVATE");
    const transport = {
      token: "phc_test",
      distinct_id: OWNER,
      $session_id: "0193a5b2-7c41-7a10-8f00-aaaaaaaaaaaa",
      $lib: "web",
      $lib_version: "1.447.5",
      $is_identified: true,
    };
    const enriched = (properties: Record<string, unknown>) => ({
      uuid: "0193a5b2-7c41-7a10-8f00-bbbbbbbbbbbb",
      event,
      properties: Object.defineProperties(
        {
          ...transport,
          ...properties,
          $current_url: "https://hackerai.co/c/PRIVATE?code=PRIVATE",
          $pathname: "/c/PRIVATE",
          $referrer: "https://PRIVATE.example/",
          $device_id: "PRIVATE",
          registered_super_property: "PRIVATE",
          error: "PRIVATE C:\\Users\\me",
        },
        { stack: { get: getter, enumerable: true } },
      ),
      $set: { email: "PRIVATE" },
      $set_once: { first: "PRIVATE" },
      timestamp: new Date(1_794_094_000_000),
    });
    const expected = () => ({ owner: OWNER, token: "phc_test" });

    const sent = sanitizeDesktopStreamCancelEvent(enriched(stamped), expected);
    expect(sent).toEqual({
      uuid: "0193a5b2-7c41-7a10-8f00-bbbbbbbbbbbb",
      event,
      properties: { ...transport, ...stamped },
      timestamp: new Date(1_794_094_000_000),
    });
    expect(JSON.stringify(sent)).not.toContain("PRIVATE");
    expect(getter).not.toHaveBeenCalled();

    // Fail closed: another or no committed owner, a carrier owner mismatch,
    // a forged field, or a non-hex build commit.
    expect(
      sanitizeDesktopStreamCancelEvent(enriched(stamped), () => ({
        owner: null,
        token: "phc_test",
      })),
    ).toBeNull();
    expect(
      sanitizeDesktopStreamCancelEvent(
        enriched({ ...stamped, distinct_id: "user_01OTHER" }),
        expected,
      ),
    ).toBeNull();
    for (const forged of [
      { caller: "pty_kill" },
      { outcome: "returned_true" },
      { version: 2 },
      { command_id: "PRIVATE-ID" },
    ])
      expect(
        sanitizeDesktopStreamCancelEvent(
          enriched({ ...stamped, ...forged }),
          expected,
        ),
      ).toBeNull();
    expect(
      sanitizeDesktopStreamCancelEvent(
        enriched({ ...stamped, hackerai_frontend_build_commit: "PRIVATE" }),
        expected,
      )?.properties,
    ).toEqual({ ...transport, ...fields });
    // Other events are untouched.
    const other = { event: "pricing_viewed", properties: { a: 1 } };
    expect(sanitizeDesktopStreamCancelEvent(other, expected)).toBe(other);
  });
});

describe("prepareDesktopStreamCancel", () => {
  it("returns the native promise itself and reports each caller once", async () => {
    const { commandId, chatId, runId } = fresh();
    const unregister = registerDesktopCommand(commandId, chatId, runId, OWNER);
    try {
      const result = Promise.resolve(false);
      native.mockReturnValue(result);
      const relay = prepareDesktopStreamCancel(
        commandId,
        "relay_command_cancel",
      );
      expect(relay(invoke)).toBe(result);
      expect(relay(invoke)).toBe(result);
      expect(
        prepareDesktopStreamCancel(commandId, "output_overflow")(invoke),
      ).toBe(result);
      await flush();
      expect(events()).toEqual([
        expect.objectContaining({ caller: "relay_command_cancel" }),
        expect.objectContaining({ caller: "output_overflow" }),
      ]);
    } finally {
      unregister();
    }
  });

  it("captures nothing for an unregistered ID and preserves its rejection", async () => {
    const { commandId } = fresh();
    const failure = new Error("native transport failed");
    native.mockRejectedValue(failure);
    await expect(
      prepareDesktopStreamCancel(commandId, "relay_command_cancel")(invoke),
    ).rejects.toBe(failure);
    expect(native).toHaveBeenCalledWith("cancel_stream_command", {
      commandId,
    });
    expect(events()).toEqual([]);
  });

  it("uses the registration captured before the call, not one made later", async () => {
    const { commandId, chatId, runId } = fresh();
    native.mockResolvedValue(false);
    // Captured while unregistered: a later registration never adopts it.
    const cancel = prepareDesktopStreamCancel(commandId, "output_overflow");
    const unregister = registerDesktopCommand(commandId, chatId, runId, OWNER);
    try {
      await expect(cancel(invoke)).resolves.toBe(false);
      await flush();
      expect(events()).toEqual([]);
    } finally {
      unregister();
    }
  });

  it("never lets a capture failure change the native result", async () => {
    const { commandId, chatId, runId } = fresh();
    const unregister = registerDesktopCommand(commandId, chatId, runId, OWNER);
    jest.mocked(captureAuthenticatedEvent).mockImplementationOnce(() => {
      throw new Error("analytics failed");
    });
    native.mockResolvedValue(false);
    try {
      await expect(
        prepareDesktopStreamCancel(commandId, "relay_command_cancel")(invoke),
      ).resolves.toBe(false);
      await flush();
    } finally {
      unregister();
    }
  });
});
