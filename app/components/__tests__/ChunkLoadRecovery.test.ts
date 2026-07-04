import { render } from "@testing-library/react";
import { createElement } from "react";
import {
  ChunkLoadRecovery,
  isChunkLoadFailure,
  maybeRecoverFromChunkLoadFailure,
} from "../ChunkLoadRecovery";

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: jest.fn((key: string) => values.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

describe("ChunkLoadRecovery", () => {
  it("detects stale Next chunk load failures", () => {
    expect(
      isChunkLoadFailure(
        new Error(
          "Failed to load chunk /_next/static/chunks/example.js from module 1",
        ),
      ),
    ).toBe(true);

    expect(
      isChunkLoadFailure({
        name: "ChunkLoadError",
        message: "Loading chunk 123 failed.",
      }),
    ).toBe(true);

    expect(
      isChunkLoadFailure(
        "Failed to fetch dynamically imported module: https://example.com/chunk.js",
      ),
    ).toBe(true);

    expect(isChunkLoadFailure(new Error("Failed to fetch"))).toBe(false);
  });

  it("handles cyclic rejection payloads while checking chunk load failures", () => {
    const reason: { message: string; self?: unknown } = {
      message: "ChunkLoadError",
    };
    reason.self = reason;

    expect(isChunkLoadFailure(reason)).toBe(true);
  });

  it("reloads once for chunk load failures and records the attempt", () => {
    const storage = createStorage();
    const reload = jest.fn();

    expect(
      maybeRecoverFromChunkLoadFailure(new Error("ChunkLoadError"), {
        storage,
        reload,
        now: 1_000,
      }),
    ).toBe(true);

    expect(storage.setItem).toHaveBeenCalledWith(
      "zhacker:chunk-load-reload-at",
      "1000",
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload repeatedly inside the cooldown window", () => {
    const storage = createStorage({
      "zhacker:chunk-load-reload-at": "1000",
    });
    const reload = jest.fn();

    expect(
      maybeRecoverFromChunkLoadFailure(new Error("ChunkLoadError"), {
        storage,
        reload,
        now: 2_000,
        cooldownMs: 5_000,
      }),
    ).toBe(false);

    expect(reload).not.toHaveBeenCalled();
  });

  it("still reloads when storage is unavailable", () => {
    const storage = {
      getItem: jest.fn(() => {
        throw new Error("Storage disabled");
      }),
      setItem: jest.fn(),
    };
    const reload = jest.fn();

    expect(
      maybeRecoverFromChunkLoadFailure(new Error("ChunkLoadError"), {
        storage,
        reload,
      }),
    ).toBe(true);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("registers the global error listener in capture mode", () => {
    const addEventListener = jest.spyOn(window, "addEventListener");
    const removeEventListener = jest.spyOn(window, "removeEventListener");

    const { unmount } = render(createElement(ChunkLoadRecovery));

    expect(addEventListener).toHaveBeenCalledWith(
      "error",
      expect.any(Function),
      true,
    );

    unmount();

    expect(removeEventListener).toHaveBeenCalledWith(
      "error",
      expect.any(Function),
      true,
    );

    addEventListener.mockRestore();
    removeEventListener.mockRestore();
  });
});
