import { readBrowserRelay } from "../relay-client";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

it("parses split frames and aborts a stalled connection for reconnect", async () => {
  jest.useFakeTimers();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let requestSignal!: AbortSignal;
  global.fetch = jest.fn(async (_url, options) => {
    requestSignal = options!.signal as AbortSignal;
    return {
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          requestSignal.addEventListener("abort", () =>
            controller.error(new Error("Connection aborted")),
          );
        },
      }),
    } as Response;
  });
  const onFrame = jest.fn();
  const onReady = jest.fn();
  const result = readBrowserRelay(
    "https://relay.example",
    "test-grant",
    new AbortController().signal,
    onFrame,
    onReady,
  ).catch((error: Error) => error.message);
  const frame = {
    image: "data:image/jpeg;base64,/9j/2Q==",
    width: 800,
    height: 600,
    capturedAt: 123,
    browserSessionName: "default",
  };
  const event = `data: ${JSON.stringify({ type: "frame", frame })}\n\n`;
  stream.enqueue(
    new TextEncoder().encode('data: {"type":"ready"}\n\n' + event.slice(0, 40)),
  );
  stream.enqueue(new TextEncoder().encode(event.slice(40)));
  await jest.advanceTimersByTimeAsync(4000);
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(onFrame).toHaveBeenCalledWith(frame);
  expect(requestSignal.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(1001);
  expect(await result).toBe("Connection aborted");
  expect(requestSignal.aborted).toBe(true);
});
