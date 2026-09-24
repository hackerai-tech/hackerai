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
import { MODEL_HISTORY_MAX_BYTES } from "@/lib/chat/model-history";

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

it.each([
  [true, "saved"],
  [false, "rejected"],
])("reports save result %s", async (result, expected) => {
  mockMutation.mockResolvedValue(result);
  await expect(
    saveModelHistory("chat", "user", 1, 1, {
      version: 1,
      identity: "test",
      source: [],
      messages: [],
      system: "system",
    }),
  ).resolves.toBe(expected);
});

it("reports the local size limit without calling storage", async () => {
  await expect(
    saveModelHistory("chat", "user", 1, 1, {
      version: 1,
      identity: "test",
      source: [],
      messages: [],
      system: "x".repeat(MODEL_HISTORY_MAX_BYTES),
    }),
  ).resolves.toBe("too_large");
  expect(mockMutation).not.toHaveBeenCalled();
});
