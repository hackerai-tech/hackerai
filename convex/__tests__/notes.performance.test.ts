jest.mock("../_generated/server", () => ({
  query: (config: unknown) => config,
  mutation: (config: unknown) => config,
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));

import { getNotesForBackend } from "../notes";

function setup(tokens = 1000) {
  let reads = 0;
  const order = jest.fn(() => ({
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 10_000; i++) {
        reads++;
        yield {
          note_id: `note-${i}`,
          title: "Note",
          content: "context",
          category: "general",
          tags: [],
          updated_at: 10_000 - i,
          tokens,
        };
      }
    },
  }));
  const range = { eq: jest.fn().mockReturnThis() };
  const withIndex = jest.fn(
    (_: string, build: (q: typeof range) => unknown) => {
      build(range);
      return { order };
    },
  );
  return {
    ctx: { db: { query: jest.fn(() => ({ withIndex })) } },
    withIndex,
    range,
    order,
    reads: () => reads,
  };
}

describe("prompt notes read budget", () => {
  it.each([
    ["free", 5],
    ["pro", 15],
  ] as const)(
    "reads only the %s prompt budget out of 10,000 notes",
    async (subscription, count) => {
      const db = setup();
      const result = await (getNotesForBackend as any).handler(db.ctx, {
        serviceKey: "test",
        userId: "user-1",
        subscription,
      });
      expect(result).toHaveLength(count);
      expect(db.reads()).toBe(count);
      expect(db.withIndex).toHaveBeenCalledWith(
        "by_user_and_category_and_updated",
        expect.any(Function),
      );
      expect(db.range.eq.mock.calls).toEqual([
        ["user_id", "user-1"],
        ["category", "general"],
      ]);
      expect(db.order).toHaveBeenCalledWith("desc");
      expect(result[0].note_id).toBe("note-0");
    },
  );

  it.each([0, -1, NaN, 1])(
    "bounds tiny or invalid token counts (%s)",
    async (tokens) => {
      const db = setup(tokens);
      const result = await (getNotesForBackend as any).handler(db.ctx, {
        serviceKey: "test",
        userId: "user-1",
        subscription: "pro",
      });
      expect(result).toHaveLength(100);
      expect(db.reads()).toBe(100);
    },
  );

  it("stops at the first note exceeding the remaining budget", async () => {
    const db = setup(3000);
    expect(
      await (getNotesForBackend as any).handler(db.ctx, {
        serviceKey: "test",
        userId: "user-1",
      }),
    ).toHaveLength(1);
    expect(db.reads()).toBe(2);
  });
});
