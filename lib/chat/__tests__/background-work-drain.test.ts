import { describe, expect, it } from "@jest/globals";

import { drainBackgroundWork } from "../background-work-drain";

describe("drainBackgroundWork", () => {
  it("waits for work that settles before the deadline", async () => {
    const work = new Set<Promise<void>>();
    const promise = Promise.resolve().then(() => {
      work.delete(promise);
    });
    work.add(promise);

    await expect(
      drainBackgroundWork(work, { timeoutMs: 100 }),
    ).resolves.toEqual(
      expect.objectContaining({ status: "completed", pendingCount: 0 }),
    );
  });

  it("returns unfinished work after the deadline", async () => {
    const work = new Set<Promise<void>>([new Promise(() => {})]);

    await expect(drainBackgroundWork(work, { timeoutMs: 0 })).resolves.toEqual(
      expect.objectContaining({ status: "timed_out", pendingCount: 1 }),
    );
  });

  it("stops waiting when cancellation is already requested", async () => {
    const controller = new AbortController();
    controller.abort();
    const work = new Set<Promise<void>>([new Promise(() => {})]);

    await expect(
      drainBackgroundWork(work, {
        signal: controller.signal,
        timeoutMs: 100,
      }),
    ).resolves.toEqual(
      expect.objectContaining({ status: "aborted", pendingCount: 1 }),
    );
  });
});
