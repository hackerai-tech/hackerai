import { beforeEach, describe, expect, it } from "@jest/globals";
import {
  decideExtraUsageResumeRetry,
  EXTRA_USAGE_RESUME_RETRY_GUARD_TTL_MS,
  resetExtraUsageResumeRetryGuardForTests,
} from "../extra-usage-resume-retry";

const createStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    store,
  };
};

const CHAT_URL = "https://hackerai.co/c/chat_1";

describe("decideExtraUsageResumeRetry", () => {
  beforeEach(() => {
    resetExtraUsageResumeRetryGuardForTests();
  });

  it("ignores URLs without a resume flag", () => {
    expect(
      decideExtraUsageResumeRetry({
        href: `${CHAT_URL}?extra-usage-purchased=true&amount=15`,
        storage: createStorage(),
      }),
    ).toEqual({ flagged: false });
  });

  it("retries once and strips both flags from the URL", () => {
    const storage = createStorage();

    expect(
      decideExtraUsageResumeRetry({
        href: `${CHAT_URL}?extra-usage-purchased=true&amount=15&extra-usage-resume=true#x`,
        storage,
        now: 1_000,
      }),
    ).toEqual({
      flagged: true,
      retry: true,
      source: "extra-usage-resume",
      nextUrl: "/c/chat_1?extra-usage-purchased=true&amount=15#x",
    });
    expect(storage.store.size).toBe(1);
  });

  it("does not retry again when the flag reappears in the same page load", () => {
    const storage = createStorage();
    const href = `${CHAT_URL}?extra-usage-resume=true`;

    decideExtraUsageResumeRetry({ href, storage, now: 1_000 });

    expect(
      decideExtraUsageResumeRetry({ href, storage, now: 5 * 60 * 1000 }),
    ).toMatchObject({ flagged: true, retry: false, reason: "already_retried" });
  });

  it("remembers the retry across page loads through storage", () => {
    const storage = createStorage();
    const href = `${CHAT_URL}?extra-usage-payment-retry=true`;

    decideExtraUsageResumeRetry({ href, storage, now: 1_000 });
    resetExtraUsageResumeRetryGuardForTests();

    expect(
      decideExtraUsageResumeRetry({ href, storage, now: 2_000 }),
    ).toMatchObject({
      flagged: true,
      retry: false,
      source: "extra-usage-payment-retry",
    });
  });

  it("retries again once the guard window has passed", () => {
    const storage = createStorage();
    const href = `${CHAT_URL}?extra-usage-resume=true`;

    decideExtraUsageResumeRetry({ href, storage, now: 1_000 });
    resetExtraUsageResumeRetryGuardForTests();

    expect(
      decideExtraUsageResumeRetry({
        href,
        storage,
        now: 1_000 + EXTRA_USAGE_RESUME_RETRY_GUARD_TTL_MS + 1,
      }),
    ).toMatchObject({ flagged: true, retry: true });
  });

  it("keys the guard per chat", () => {
    const storage = createStorage();

    decideExtraUsageResumeRetry({
      href: `${CHAT_URL}?extra-usage-resume=true`,
      storage,
      now: 1_000,
    });

    expect(
      decideExtraUsageResumeRetry({
        href: "https://hackerai.co/c/chat_2?extra-usage-resume=true",
        storage,
        now: 1_000,
      }),
    ).toMatchObject({ flagged: true, retry: true });
  });

  it("still retries once when storage is unavailable or throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const href = `${CHAT_URL}?extra-usage-resume=true`;

    expect(
      decideExtraUsageResumeRetry({ href, storage: throwing }),
    ).toMatchObject({ retry: true });
    expect(
      decideExtraUsageResumeRetry({ href, storage: throwing }),
    ).toMatchObject({ retry: false });
    expect(decideExtraUsageResumeRetry({ href: "not a url" })).toEqual({
      flagged: false,
    });
  });
});
