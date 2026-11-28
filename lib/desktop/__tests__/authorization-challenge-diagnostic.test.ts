import {
  isAuthorizationChallengeOrigin,
  uploadNativeAuthorizationChallenge,
  type NativeAuthorizationChallenge,
} from "../authorization-challenge-diagnostic";

const record: NativeAuthorizationChallenge = {
  version: 1,
  capturedAtMs: 1_800_000_000_000,
  requestId: { kind: "present", value: "cle1::abc" },
  retryAfter: { kind: "absent" },
};
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

it("offers the record only on the canonical or an isolated localhost page", () => {
  for (const origin of [
    "https://hackerai.co",
    "http://localhost",
    "http://localhost:3000",
    "https://localhost:8443",
  ])
    expect(isAuthorizationChallengeOrigin(origin)).toBe(true);
  for (const origin of [
    "http://hackerai.co",
    "https://www.hackerai.co",
    "https://hackerai.co:8443",
    "https://hackerai-git-branch.vercel.app",
    "https://localhost.evil.example",
    "http://127.0.0.1:3000",
    "null",
    "",
    undefined,
  ])
    expect(isAuthorizationChallengeOrigin(origin)).toBe(false);
});

it("aborts a pending upload at its short deadline without throwing", async () => {
  jest.useFakeTimers();
  let signal: AbortSignal | undefined;
  global.fetch = jest.fn((_url: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((_, reject) =>
      signal?.addEventListener("abort", () => reject(signal?.reason)),
    );
  }) as unknown as typeof fetch;

  expect(() => uploadNativeAuthorizationChallenge(record)).not.toThrow();
  expect(global.fetch).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(4_999);
  expect(signal?.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  expect(signal?.aborted).toBe(true);
  // No retry follows the abort.
  await jest.advanceTimersByTimeAsync(60_000);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it("never throws when fetch itself is unavailable", () => {
  global.fetch = undefined as unknown as typeof fetch;
  expect(() => uploadNativeAuthorizationChallenge(record)).not.toThrow();
});
