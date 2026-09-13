import {
  getSafeErrorEventCause,
  getSafeErrorEventMessage,
} from "../error-event";

const blockedAccessor = (property: "error" | "message") => {
  const event = {} as ErrorEvent;
  Object.defineProperty(event, property, {
    get: () => {
      throw new Error(`Permission denied to access property "${property}"`);
    },
  });
  return event;
};

describe("safe ErrorEvent access", () => {
  it("reads accessible messages", () => {
    expect(getSafeErrorEventMessage({ message: "ChunkLoadError" })).toBe(
      "ChunkLoadError",
    );
  });

  it("reads each message accessor only once", () => {
    const message = jest
      .fn<() => string>()
      .mockReturnValueOnce("ChunkLoadError")
      .mockImplementation(() => {
        throw new Error("message read twice");
      });
    const event = {} as ErrorEvent;
    Object.defineProperty(event, "message", { get: message });

    expect(getSafeErrorEventMessage(event)).toBe("ChunkLoadError");
    expect(message).toHaveBeenCalledTimes(1);
  });

  it("ignores blocked message access", () => {
    expect(
      getSafeErrorEventMessage(blockedAccessor("message")),
    ).toBeUndefined();
  });

  it("prefers an accessible error value", () => {
    const error = new Error("ChunkLoadError");

    expect(getSafeErrorEventCause({ error, message: "fallback message" })).toBe(
      error,
    );
  });

  it("reads each error accessor only once", () => {
    const expected = new Error("ChunkLoadError");
    const error = jest
      .fn<() => Error>()
      .mockReturnValueOnce(expected)
      .mockImplementation(() => {
        throw new Error("error read twice");
      });
    const event = { message: "fallback message" } as ErrorEvent;
    Object.defineProperty(event, "error", { get: error });

    expect(getSafeErrorEventCause(event)).toBe(expected);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("falls back to a separately guarded message", () => {
    const event = blockedAccessor("error");
    Object.defineProperty(event, "message", { value: "ChunkLoadError" });

    expect(getSafeErrorEventCause(event)).toBe("ChunkLoadError");
  });

  it("ignores ErrorEvents whose error and message accessors are blocked", () => {
    const event = blockedAccessor("error");
    Object.defineProperty(event, "message", {
      get: () => {
        throw new Error('Permission denied to access property "message"');
      },
    });

    expect(getSafeErrorEventCause(event)).toBeUndefined();
  });
});
