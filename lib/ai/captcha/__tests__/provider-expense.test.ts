import { readTwoCaptchaExpense } from "../provider-expense";
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});
it.each([
  [
    {
      errorId: 0,
      status: "ready",
      cost: "0.00299",
      solution: { token: "private-token" },
      ip: "private-ip",
    },
    { status: "ready", costDollars: 0.00299 },
  ],
  [
    { errorId: 12, errorDescription: "private-provider-text" },
    { status: "unsolvable" },
  ],
  [{ errorId: 0, status: "processing" }, { status: "pending" }],
  [{ errorId: 0, status: "ready", cost: "NaN" }, { status: "pending" }],
  [{ errorId: 0, status: "ready", cost: "100" }, { status: "pending" }],
  [{ errorId: 0, status: "ready" }, { status: "pending" }],
])("returns only a bounded expense outcome: %j", async (response, expected) => {
  const fetch = jest.fn(async () => ({ ok: true, json: async () => response }));
  global.fetch = fetch as unknown as typeof global.fetch;
  expect(await readTwoCaptchaExpense("private-key", 123)).toEqual(expected);
  expect(fetch.mock.calls).toHaveLength(1);
});
it("never creates or retries a task when provider I/O fails", async () => {
  const fetch = jest
    .fn()
    .mockRejectedValue(new Error("private-key private-token"));
  global.fetch = fetch;
  expect(await readTwoCaptchaExpense("private-key", 123)).toEqual({
    status: "pending",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    "https://api.2captcha.com/getTaskResult",
    expect.objectContaining({ redirect: "error" }),
  );
});
