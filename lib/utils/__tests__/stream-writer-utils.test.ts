import { describe, it, expect, jest } from "@jest/globals";
import type { UIMessageStreamWriter } from "ai";

jest.doMock("server-only", () => ({}));

const { writeAutoContinue, startSummarizationProgress } =
  require("../stream-writer-utils") as typeof import("../stream-writer-utils");

describe("writeAutoContinue", () => {
  it("should write data-auto-continue signal", () => {
    const mockWrite = jest.fn();
    const writer = { write: mockWrite } as unknown as UIMessageStreamWriter;

    writeAutoContinue(writer);

    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite).toHaveBeenCalledWith({
      type: "data-auto-continue",
      data: { shouldContinue: true },
    });
  });
});

describe("summarization progress", () => {
  afterEach(() => jest.useRealTimers());

  it("emits transient heartbeats and retries with one start time, then stops", () => {
    jest.useFakeTimers();
    const write = jest.fn();
    const progress = startSummarizationProgress(
      { write } as unknown as UIMessageStreamWriter,
      2,
    );
    const startedAt = Date.now();
    jest.advanceTimersByTime(15_000);
    progress.retry();
    expect(write).toHaveBeenCalledTimes(3);
    for (const [chunk] of write.mock.calls) {
      expect(chunk).toMatchObject({
        id: "summarization-status-2",
        transient: true,
        data: { status: "started", startedAt },
      });
    }
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ message: "Retrying preparation…" }),
      }),
    );
    progress.stop();
    jest.advanceTimersByTime(60_000);
    expect(write).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("stops heartbeats on cancellation and does not restart for a late retry", () => {
    jest.useFakeTimers();
    const write = jest.fn();
    const controller = new AbortController();
    const progress = startSummarizationProgress(
      { write } as unknown as UIMessageStreamWriter,
      1,
      controller.signal,
    );
    controller.abort();
    progress.retry();
    jest.advanceTimersByTime(60_000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(["initial", "retry"])(
    "contains a disconnected %s write and releases timers",
    (phase) => {
      jest.useFakeTimers();
      const write = jest.fn().mockImplementation(() => {
        throw new Error("closed");
      });
      if (phase === "retry") write.mockImplementationOnce(() => undefined);
      const progress = startSummarizationProgress({
        write,
      } as unknown as UIMessageStreamWriter);
      expect(() => progress.retry()).not.toThrow();
      expect(jest.getTimerCount()).toBe(0);
      const calls = write.mock.calls.length;
      jest.advanceTimersByTime(60_000);
      expect(write).toHaveBeenCalledTimes(calls);
    },
  );

  it("stops safely when a heartbeat writer disconnects", () => {
    jest.useFakeTimers();
    const write = jest
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new Error("closed");
      });
    startSummarizationProgress({ write } as unknown as UIMessageStreamWriter);
    expect(() => jest.advanceTimersByTime(15_000)).not.toThrow();
    expect(jest.getTimerCount()).toBe(0);
  });
});
