import { putBrowserFile } from "../browser-file-upload";

describe("large browser upload deadlines", () => {
  const originalFetch = global.fetch;
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  it("allows a permitted large upload to complete after the small-file deadline", async () => {
    const file = new File(["fixture"], "capture.pcap");
    Object.defineProperty(file, "size", { value: 250 * 1024 * 1024 });
    let finish!: (response: unknown) => void;
    let requestSignal!: AbortSignal;
    global.fetch = jest.fn().mockImplementation((_url, options) => {
      requestSignal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const pending = putBrowserFile(
      file,
      "https://s3.example/upload",
      new AbortController().signal,
    );
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(requestSignal.aborted).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    finish({ ok: true });
    await pending;
    expect(jest.getTimerCount()).toBe(0);
  });

  it("still cancels a large transfer immediately when its attachment is removed", async () => {
    const file = new File(["fixture"], "capture.pcap");
    Object.defineProperty(file, "size", { value: 250 * 1024 * 1024 });
    const controller = new AbortController();
    global.fetch = jest
      .fn()
      .mockImplementation(
        (_url, options) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener(
              "abort",
              () => reject(options.signal.reason),
              { once: true },
            ),
          ),
      );
    const pending = putBrowserFile(
      file,
      "https://s3.example/upload",
      controller.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejected;
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
