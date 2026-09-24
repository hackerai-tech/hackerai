jest.mock("server-only", () => ({}));
const mockMutation = jest.fn();
jest.mock("../convex-client", () => ({
  getConvexClient: () => ({ mutation: mockMutation }),
}));
import {
  loadModelHistory,
  saveModelHistory,
  MODEL_HISTORY_DEADLINE_MS,
} from "../model-history";

beforeEach(() => {
  jest.useFakeTimers();
  mockMutation.mockReset();
});
afterEach(() => {
  jest.useRealTimers();
});

it.each(["load", "save"])(
  "bounds a hanging %s without leaving a timer behind",
  async (operation) => {
    let finish!: (value: unknown) => void;
    mockMutation.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const request =
      operation === "load"
        ? loadModelHistory("chat", "user")
        : saveModelHistory("chat", "user", 1, 1, {
            version: 1,
            identity: "test",
            source: [],
            messages: [],
            system: "system",
          });
    const assertion = expect(request).rejects.toThrow("deadline exceeded");
    await jest.advanceTimersByTimeAsync(MODEL_HISTORY_DEADLINE_MS);
    await assertion;
    expect(jest.getTimerCount()).toBe(0);
    finish(null); // A late remote result cannot revive the timed-out caller.
  },
);

it("clears the deadline on a successful lookup", async () => {
  mockMutation.mockResolvedValue({ revision: 1, payload: null });
  await expect(loadModelHistory("chat", "user")).resolves.toEqual({
    revision: 1,
    payload: null,
  });
  expect(jest.getTimerCount()).toBe(0);
});
