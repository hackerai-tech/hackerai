import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  cancelLocalAutoContinue,
  createDesktopReturnReporter,
  DESKTOP_RETURN_REPORT_DELAYS_MS,
  LocalAutoContinueCancelError,
} from "../local-auto-continue-client";

function reporter() {
  const report = jest.fn(async (_connectionId: string) => undefined);
  // A fake clock: scheduled callbacks run only when drained, and a cancelled
  // one never runs, as with clearTimeout.
  let nextTimer = 0;
  const scheduled = new Map<number, { run: () => void; ms: number }>();
  const instance = createDesktopReturnReporter({
    report,
    schedule: (run, ms) => {
      scheduled.set(++nextTimer, { run, ms });
      return nextTimer as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (timer) => {
      scheduled.delete(timer as unknown as number);
    },
  });
  const delays = () => [...scheduled.values()].map(({ ms }) => ms);
  const runAll = () => {
    const due = [...scheduled.values()];
    scheduled.clear();
    for (const { run } of due) run();
  };
  return { report, delays, instance, runAll };
}

describe("Desktop return reporter", () => {
  it("never reports the page's first connection, which no stop can match", () => {
    const { instance, delays } = reporter();
    // The bridge announces "connected" twice while it starts.
    instance.onState("connecting", null);
    instance.onState("connected", "connection-1");
    instance.onState("connected", "connection-1");

    expect(delays()).toEqual([]);
  });

  it("reports a reconnect of the same connection on a short schedule", () => {
    const { instance, delays, report, runAll } = reporter();
    instance.onState("connected", "connection-1");
    instance.onState("connecting", "connection-1");
    instance.onState("connected", "connection-1");

    expect(delays()).toEqual([...DESKTOP_RETURN_REPORT_DELAYS_MS]);
    runAll();
    expect(report.mock.calls).toEqual(
      DESKTOP_RETURN_REPORT_DELAYS_MS.map(() => ["connection-1"]),
    );
  });

  it("drops pending reports while the bridge is away again", () => {
    const { instance, report, runAll } = reporter();
    instance.onState("connected", "connection-1");
    instance.onState("connecting", "connection-1");
    instance.onState("connected", "connection-1");
    // The server may still list this connection as connected during the
    // second outage; reporting it then could claim a stop too early.
    instance.onState("connecting", "connection-1");
    runAll();
    expect(report).not.toHaveBeenCalled();

    instance.onState("connected", "connection-1");
    runAll();
    expect(report).toHaveBeenCalledTimes(
      DESKTOP_RETURN_REPORT_DELAYS_MS.length,
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

  it("cancels reports already scheduled when the user signs out", () => {
    const { instance, report, runAll } = reporter();
    instance.onState("connected", "connection-1");
    instance.onState("connecting", "connection-1");
    instance.onState("connected", "connection-1");
    instance.reset();
    runAll();
    expect(report).not.toHaveBeenCalled();

    // The next account's first connection is not a return either.
    instance.onState("connected", "connection-2");
    runAll();
    expect(report).not.toHaveBeenCalled();
  });
});

describe("cancelLocalAutoContinue", () => {
  const fetchMock = jest.fn<typeof fetch>();
  const sleep = jest.fn(async (_ms: number) => undefined);
  // Only the status is read.
  const respond = (status: number) => Promise.resolve({ status } as Response);
  globalThis.fetch = fetchMock as typeof fetch;

  afterEach(() => {
    fetchMock.mockReset();
    sleep.mockClear();
  });

  it("resolves once the server stored the cancellation", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockImplementationOnce(() => respond(503))
      .mockImplementationOnce(() => respond(200));

    await expect(
      cancelLocalAutoContinue("chat", "user_stop", { sleep }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects after its retries so the caller can tell the user", async () => {
    fetchMock.mockImplementation(() => respond(503));

    await expect(
      cancelLocalAutoContinue("chat", "environment_switched", { sleep }),
    ).rejects.toBeInstanceOf(LocalAutoContinueCancelError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a refusal", async () => {
    fetchMock.mockImplementation(() => respond(401));

    await expect(
      cancelLocalAutoContinue("chat", "user_stop", { sleep }),
    ).rejects.toBeInstanceOf(LocalAutoContinueCancelError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
