import { createWideEventBuilder } from "../logger";

describe("wide event preflight and first-chunk timing", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("records preflight, first chunk, and stream durations", () => {
    const builder = createWideEventBuilder("chat-1", "/api/chat");

    jest.advanceTimersByTime(120);
    builder.startStream();
    jest.advanceTimersByTime(300);
    builder.markFirstChunk();
    jest.advanceTimersByTime(500);
    // Later chunks must not move the first-chunk measurement.
    builder.markFirstChunk();
    builder.setStreamResult({
      finishReason: "stop",
      wasAborted: false,
      wasPreemptiveTimeout: false,
      hadSummarization: false,
    });
    builder.setSuccess();

    const event = builder.build();
    expect(event.preflight).toEqual({ duration_ms: 120 });
    expect(event.stream?.first_chunk_ms).toBe(300);
    expect(event.stream?.duration_ms).toBe(800);
  });

  it("omits first_chunk_ms when no chunk arrived", () => {
    const builder = createWideEventBuilder("chat-1", "/api/chat");
    builder.startStream();
    builder.setStreamResult({
      wasAborted: true,
      wasPreemptiveTimeout: false,
      hadSummarization: false,
    });
    builder.setAborted();

    expect(builder.build().stream).not.toHaveProperty("first_chunk_ms");
  });
});
