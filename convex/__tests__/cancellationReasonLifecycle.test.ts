import { describe, it, expect, jest } from "@jest/globals";

jest.mock("../lib/serviceFunctions", () => ({
  mutation: (config: any) => config,
  query: (config: any) => config,
  internalQuery: (config: any) => config,
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));

const invoke = async (
  name: keyof typeof import("../cancellationReasons"),
  ctx: any,
  args: any,
) => {
  const functions = await import("../cancellationReasons");
  return (functions[name] as any).handler(ctx, { serviceKey: "test", ...args });
};

function database() {
  const tables: Record<string, any[]> = {};
  let sequence = 0;
  const ctx = {
    db: {
      query(table: string) {
        let rows = [...(tables[table] ?? [])];
        const query: any = {
          withIndex(_name: string, builder: any) {
            const q: any = {};
            for (const [op, test] of Object.entries({
              eq: (a: any, b: any) => a === b,
              gte: (a: any, b: any) => a >= b,
              lte: (a: any, b: any) => a <= b,
            })) {
              q[op] = (field: string, value: any) => {
                rows = rows.filter((row) => test(row[field], value));
                return q;
              };
            }
            builder(q);
            return query;
          },
          order(direction: string) {
            rows.sort((a, b) =>
              direction === "desc"
                ? b._creationTime - a._creationTime
                : a._creationTime - b._creationTime,
            );
            return query;
          },
          take: async (n: number) => rows.slice(0, n),
          first: async () => rows[0] ?? null,
          unique: async () => {
            if (rows.length > 1) throw new Error("Duplicate projection");
            return rows[0] ?? null;
          },
        };
        return query;
      },
      get: async (id: string) =>
        Object.values(tables)
          .flat()
          .find((row) => row._id === id) ?? null,
      insert: async (table: string, value: any) => {
        const row = {
          ...value,
          _id: `${table}-${++sequence}`,
          _creationTime: sequence,
        };
        (tables[table] ??= []).push(row);
        return row._id;
      },
      patch: async (id: string, value: any) => {
        Object.assign(await ctx.db.get(id), value);
      },
      delete: async (id: string) => {
        for (const table of Object.keys(tables))
          tables[table] = tables[table].filter((row) => row._id !== id);
      },
    },
  };
  return { ctx, rows: (table: string) => tables[table] ?? [] };
}
const input = {
  userId: "user",
  organizationId: "org",
  stripeCustomerId: "cus",
  stripeSubscriptionId: "sub",
  reasonCategory: "too_expensive",
  reasonSubcategory: "too_expensive_low_frequency",
  reasonDetails: "Too expensive",
  startedAt: 10_000,
};
const complete = (id?: string, completedAt = 11_000) => ({
  cancellationReasonId: id,
  stripeSubscriptionId: "sub",
  stripeCustomerId: "cus",
  userIds: ["user"],
  organizationId: "org",
  completedAt,
  cancelAtPeriodEnd: true,
});
const reverse = (id: string, reversedAt = 12_000) => ({
  cancellationReasonId: id,
  stripeSubscriptionId: "sub",
  stripeCustomerId: "cus",
  reversedAt,
});

describe("cancellation reason lifecycle", () => {
  it("reuses identical retries and publishes only once after confirmed completion", async () => {
    const { ctx, rows } = database();
    const id = await invoke("recordCancellationStarted", ctx, input);
    expect(
      await invoke("recordCancellationStarted", ctx, {
        ...input,
        startedAt: 10_500,
      }),
    ).toBe(id);
    expect(rows("cancellation_reason_details")).toHaveLength(1);
    expect(rows("current_cancellation_reasons")).toHaveLength(0);
    expect(
      (await invoke("markCancellationCompleted", ctx, complete(id)))
        .updatedCount,
    ).toBe(1);
    expect(
      (await invoke("markCancellationCompleted", ctx, complete(id)))
        .updatedCount,
    ).toBe(0);
    expect(
      await invoke("recordCancellationStarted", ctx, {
        ...input,
        startedAt: 11_500,
      }),
    ).toBe(id);
    expect(rows("current_cancellation_reasons")).toHaveLength(1);
  });

  it("preserves edited submissions but never completes older attempts on webhook retries", async () => {
    const { ctx, rows } = database();
    const old = await invoke("recordCancellationStarted", ctx, input);
    const latest = await invoke("recordCancellationStarted", ctx, {
      ...input,
      reasonDetails: "Latest feedback",
      startedAt: 12_000,
    });
    expect(
      (await invoke("markCancellationCompleted", ctx, complete(old, 13_000)))
        .updatedCount,
    ).toBe(0);
    await invoke("markCancellationCompleted", ctx, complete(latest, 13_000));
    await invoke("markCancellationCompleted", ctx, complete(latest, 14_000));
    expect((await ctx.db.get(old)).status).toBe("started");
    expect(
      rows("cancellation_reason_details").map((r) => r.reason_details),
    ).toEqual(["Too expensive", "Latest feedback"]);
    expect(
      rows("current_cancellation_reasons").map((r) => r.reason_details),
    ).toEqual(["Latest feedback"]);
  });

  it("cancel, keep, cancel creates two historical decisions and one current reason", async () => {
    const { ctx, rows } = database();
    const first = await invoke("recordCancellationStarted", ctx, input);
    await invoke("markCancellationCompleted", ctx, complete(first));
    await invoke("markCancellationReversed", ctx, reverse(first));
    expect(rows("current_cancellation_reasons")).toHaveLength(0);
    const next = await invoke("recordCancellationStarted", ctx, {
      ...input,
      startedAt: 13_000,
    });
    expect(next).not.toBe(first);
    // Delayed events from the first cancellation must not affect the new one.
    await invoke("markCancellationCompleted", ctx, complete(first, 15_000));
    await invoke("markCancellationReversed", ctx, reverse(first, 15_000));
    expect((await ctx.db.get(next)).status).toBe("started");
    expect((await ctx.db.get(next)).reversed_at).toBeUndefined();
    await invoke("markCancellationCompleted", ctx, complete(next, 14_000));
    expect(rows("cancellation_reasons")).toHaveLength(2);
    expect(
      rows("current_cancellation_reasons").map((r) => r.cancellation_reason_id),
    ).toEqual([next]);
  });

  it("does not publish pause feedback even when its webhook beats acceptance", async () => {
    const { ctx, rows } = database();
    const pause = await invoke("recordCancellationStarted", ctx, {
      ...input,
      operation: "pause",
    });
    await invoke("markCancellationCompleted", ctx, complete(pause));
    expect(
      await invoke("recordRetentionOfferAccepted", ctx, {
        cancellationReasonId: pause,
        retentionOffer: "pause",
        acceptedAt: 11_500,
      }),
    ).toEqual({ recorded: true });
    expect(rows("current_cancellation_reasons")).toHaveLength(0);
    await invoke("markCancellationReversed", ctx, reverse(pause));
    const cancel = await invoke("recordCancellationStarted", ctx, {
      ...input,
      startedAt: 13_000,
    });
    await invoke("markCancellationCompleted", ctx, complete(cancel, 14_000));
    expect(rows("cancellation_reason_details")).toHaveLength(2);
    expect(
      rows("current_cancellation_reasons").map((r) => r.cancellation_reason_id),
    ).toEqual([cancel]);
  });

  it("does not complete a retained downgrade or resurrect a reversed cancellation", async () => {
    const { ctx, rows } = database();
    const id = await invoke("recordCancellationStarted", ctx, {
      ...input,
      operation: "downgrade",
    });
    await invoke("recordRetentionOfferAccepted", ctx, {
      cancellationReasonId: id,
      retentionOffer: "downgrade",
    });
    expect(
      (await invoke("markCancellationCompleted", ctx, complete(id)))
        .updatedCount,
    ).toBe(0);
    await invoke("markCancellationReversed", ctx, reverse(id));
    expect(
      (await invoke("markCancellationCompleted", ctx, complete(id, 13_000)))
        .updatedCount,
    ).toBe(0);
    expect(rows("current_cancellation_reasons")).toHaveLength(0);
  });

  it.each([
    { stripeCustomerId: "other" },
    { userIds: ["other"] },
    { organizationId: "other" },
    { cancellationReasonId: undefined },
    { completedAt: 8_000 },
    { stripeCancellationReason: "payment_failed" },
  ])("rejects mismatched or stale completion %j", async (override) => {
    const { ctx, rows } = database();
    const id = await invoke("recordCancellationStarted", ctx, input);
    expect(
      (
        await invoke("markCancellationCompleted", ctx, {
          ...complete(id),
          ...override,
        })
      ).updatedCount,
    ).toBe(0);
    expect(rows("current_cancellation_reasons")).toHaveLength(0);
  });

  it("legacy completion never walks backwards beyond the latest completed row", async () => {
    const { ctx, rows } = database();
    const old = await invoke("recordCancellationStarted", ctx, input);
    const latest = await invoke("recordCancellationStarted", ctx, {
      ...input,
      reasonDetails: "New",
      startedAt: 12_000,
    });
    delete (await ctx.db.get(latest)).operation;
    await invoke("markCancellationCompleted", ctx, complete(undefined, 13_000));
    await invoke("markCancellationCompleted", ctx, complete(undefined, 14_000));
    expect((await ctx.db.get(old)).status).toBe("started");
    expect(rows("current_cancellation_reasons")).toHaveLength(1);
  });

  it("defaults exports and reports to actual current cancellations, with explicit history access", async () => {
    const { ctx } = database();
    const first = await invoke("recordCancellationStarted", ctx, input);
    await invoke("markCancellationCompleted", ctx, complete(first));
    await invoke("markCancellationReversed", ctx, reverse(first));
    const next = await invoke("recordCancellationStarted", ctx, {
      ...input,
      reasonDetails: "Final",
      startedAt: 13_000,
    });
    await invoke("markCancellationCompleted", ctx, complete(next, 14_000));
    const current = await invoke("getCancellationFeedbackForAnalysis", ctx, {});
    expect(current.map((r: any) => r.feedback)).toEqual(["Final"]);
    expect(
      await invoke("getCancellationFeedbackForAnalysis", ctx, {
        includeHistory: true,
      }),
    ).toHaveLength(2);
    expect(
      await invoke("getCancellationFeedbackForAnalysis", ctx, {
        endAt: 12_000,
      }),
    ).toEqual([]);
    const report = await invoke("getCancellationReasonReport", ctx, {});
    expect(report[0].completedCount).toBe(1);
    expect(report[0].pausedCount).toBe(0);
  });

  it("backfill refuses a candidate changed while Stripe was being read", async () => {
    const { ctx, rows } = database();
    const id = await invoke("recordCancellationStarted", ctx, input);
    await invoke("markCancellationCompleted", ctx, complete(id));
    const candidate = await ctx.db.get(id);
    const updatedAt = candidate.updated_at;
    await invoke("markCancellationReversed", ctx, reverse(id));
    expect(
      await invoke("reconcileCurrentCancellationReason", ctx, {
        cancellationReasonId: id,
        expectedUpdatedAt: updatedAt,
        cancellationActive: true,
      }),
    ).toEqual({ applied: false });
    expect(rows("current_cancellation_reasons")).toHaveLength(0);
  });
});
