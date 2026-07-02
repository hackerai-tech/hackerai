import {
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

    expect(isChunkLoadFailure(new Error("Failed to fetch"))).toBe(false);
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
});
