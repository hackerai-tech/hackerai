/** @jest-environment node */
import {
  createAuthorizationDiagnostic,
  recordDesktopAuthorizationDecision,
} from "../authorization-diagnostics";

const NOW_MS = 1_800_000_000_000;
const COMMAND_ID = "0f4d1c2e-8b7a-4c3d-9e1f-2a3b4c5d6e7f";

let info: jest.SpyInstance;

beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(NOW_MS);
  jest.spyOn(performance, "now").mockReturnValue(10_000);
  info = jest.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

function events(): unknown[] {
  return info.mock.calls.map(([line]) => JSON.parse(line as string));
}

describe("createAuthorizationDiagnostic", () => {
  it("correlates only an own-data lowercase command UUID", () => {
    expect(
      createAuthorizationDiagnostic({ type: "command", commandId: COMMAND_ID }),
    ).toEqual({ version: 1, commandId: COMMAND_ID, issuedAtMs: NOW_MS });

    const getter = jest.fn(() => COMMAND_ID);
    const proxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("trap");
        },
      },
    );
    for (const payload of [
      { type: "pty_create", sessionId: COMMAND_ID },
      { commandId: "cmd-1" },
      { commandId: COMMAND_ID.toUpperCase() },
      Object.create({ commandId: COMMAND_ID }),
      Object.defineProperty({}, "commandId", { enumerable: true, get: getter }),
      proxy,
    ]) {
      expect(createAuthorizationDiagnostic(payload)).toBeUndefined();
    }
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("recordDesktopAuthorizationDecision", () => {
  const record = (
    commandId: string,
    { ageMs = 0, handlerMs = 0 }: { ageMs?: number; handlerMs?: number } = {},
  ) =>
    recordDesktopAuthorizationDecision(
      { version: 1, commandId, issuedAtMs: NOW_MS - ageMs },
      "approved",
      { handlerStartedAt: 10_000 - handlerMs, lookupStartedAt: 10_000 },
    );

  it("samples by the first command UUID hex digit and slowness at 5 seconds", () => {
    const unsampled = `f${COMMAND_ID.slice(1)}`;
    record(`1${COMMAND_ID.slice(1)}`);
    record(unsampled, { ageMs: 4999, handlerMs: 4999 });
    expect(info).not.toHaveBeenCalled();

    record(COMMAND_ID);
    record(unsampled, { ageMs: 5000 });
    record(unsampled, { handlerMs: 5000 });
    expect(events()).toEqual([
      expect.objectContaining({
        command_id: COMMAND_ID,
        sample_reason: "sampled",
      }),
      expect.objectContaining({
        sample_reason: "slow",
        operation_age_ms: 5000,
      }),
      expect.objectContaining({
        sample_reason: "slow",
        handler_elapsed_ms: 5000,
      }),
    ]);
  });

  it("clamps cross-server clock skew and implausible ages", () => {
    record(COMMAND_ID, { ageMs: -30_000 });
    record(COMMAND_ID, { ageMs: 86_400_000 });
    expect(events()).toEqual([
      expect.objectContaining({
        sample_reason: "sampled",
        operation_age_ms: 0,
        timing_status: "clamped",
      }),
      expect.objectContaining({
        sample_reason: "slow",
        operation_age_ms: 600_000,
        timing_status: "clamped",
      }),
    ]);
  });

  it("never serializes an unvalidated command id", () => {
    recordDesktopAuthorizationDecision(
      { version: 1, commandId: "/home/user/secret", issuedAtMs: NOW_MS },
      "mismatch",
      { handlerStartedAt: 10_000, lookupStartedAt: 10_000 },
    );
    expect(info).not.toHaveBeenCalled();
  });
});
