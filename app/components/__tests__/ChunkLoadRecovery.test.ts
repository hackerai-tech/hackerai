import { render } from "@testing-library/react";
import { createElement } from "react";
import {
  ChunkLoadRecovery,
  isChunkLoadFailure,
  isStaleServerActionFailure,
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

  it("detects stale Server Action deployment failures", () => {
    expect(
      isStaleServerActionFailure(
        new Error(
          'Failed to find Server Action "008d652c1c1a320304c0f5508bce36145a66bf6c11". This request might be from an older or newer deployment.',
        ),
      ),
    ).toBe(true);

    expect(
      isStaleServerActionFailure(
        new Error(
          'Server Action "00b3ff60fce156a3bb78260aa8fa56550dc48b7f77" was not found on the server. Read more: https://nextjs.org/docs/messages/failed-to-find-server-action',
        ),
      ),
    ).toBe(true);

    expect(
      isStaleServerActionFailure({
        message: "This request might be from an older or newer deployment.",
      }),
    ).toBe(true);

    expect(isStaleServerActionFailure(new Error("Failed to fetch"))).toBe(
      false,
    );
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
      "hackerai:chunk-load-reload-at",
      "1000",
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads once for stale Server Action failures", () => {
    const storage = createStorage();
    const reload = jest.fn();

    expect(
      maybeRecoverFromChunkLoadFailure(
        new Error("Failed to find Server Action"),
        {
          storage,
          reload,
          now: 1_500,
        },
      ),
    ).toBe(true);

    expect(storage.setItem).toHaveBeenCalledWith(
      "hackerai:chunk-load-reload-at",
      "1500",
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload repeatedly inside the cooldown window", () => {
    const storage = createStorage({
      "hackerai:chunk-load-reload-at": "1000",
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
