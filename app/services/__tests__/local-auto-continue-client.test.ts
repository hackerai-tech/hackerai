import { describe, expect, it, jest } from "@jest/globals";
import {
  createDesktopReturnReporter,
  DESKTOP_RETURN_REPORT_DELAYS_MS,
} from "../local-auto-continue-client";

function reporter() {
  const report = jest.fn(async (_connectionId: string) => undefined);
  const scheduled: Array<{ run: () => void; ms: number }> = [];
  const instance = createDesktopReturnReporter({
    report,
    schedule: (run, ms) => {
      scheduled.push({ run, ms });
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: () => undefined,
  });
  const runAll = () => {
    for (const { run } of scheduled.splice(0)) run();
  };
  return { report, scheduled, instance, runAll };
}

describe("Desktop return reporter", () => {
  it("never reports the page's first connection, which no stop can match", () => {
    const { instance, scheduled } = reporter();
    // The bridge announces "connected" twice while it starts.
    instance.onState("connecting", null);
    instance.onState("connected", "connection-1");
    instance.onState("connected", "connection-1");

    expect(scheduled).toEqual([]);
  });

  it("reports a reconnect of the same connection on a short schedule", () => {
    const { instance, scheduled, report, runAll } = reporter();
    instance.onState("connected", "connection-1");
    instance.onState("connecting", "connection-1");
    instance.onState("connected", "connection-1");

    expect(scheduled.map(({ ms }) => ms)).toEqual([
      ...DESKTOP_RETURN_REPORT_DELAYS_MS,
    ]);
    runAll();
    expect(report.mock.calls).toEqual(
      DESKTOP_RETURN_REPORT_DELAYS_MS.map(() => ["connection-1"]),
    );
  });

  it("reports the replacement connection after the bridge restarted", () => {
    const { instance, report, runAll } = reporter();
    instance.onState("connected", "connection-1");
    instance.onTerminated();
    instance.onState("connecting", null);
    instance.onState("connected", "connection-2");
    runAll();

    expect(report).toHaveBeenCalledWith("connection-2");
  });

  it("forgets the page's session on sign-out", () => {
    const { instance, scheduled } = reporter();
    instance.onState("connected", "connection-1");
    instance.onState("connecting", "connection-1");
    instance.reset();
    instance.onState("connected", "connection-2");

    expect(scheduled).toEqual([]);
  });
});
