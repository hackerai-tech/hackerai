/**
 * One-off migration: convert extra_usage rows from legacy points to dollars.
 *
 * For each row that still has balance_points but no balance_dollars,
 * copy the value divided by 10,000 into the new dollar field and clear
 * the legacy field. Same for threshold, cap, and spent.
 *
 * Run via Convex dashboard or CLI:
 *   npx convex run migrateExtraUsageToDollars:migrateAll
 *
 * Safe to run multiple times — already-migrated rows are skipped.
 */
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";

const LEGACY_POINTS_PER_DOLLAR = 10_000;

export const migrateAll = mutation({
  args: {
    serviceKey: v.string(),
  },
  returns: v.object({
    migrated: v.number(),
    skipped: v.number(),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const allRows = await ctx.db.query("extra_usage").collect();
    let migrated = 0;
    let skipped = 0;

    for (const row of allRows) {
      // Skip rows that already have the new dollar fields set
      const needsMigration =
        row.balance_dollars === undefined && row.balance_points !== undefined;

      if (!needsMigration) {
        skipped++;
        continue;
      }

      const patch: Record<string, unknown> = {
        updated_at: Date.now(),
      };

      // Balance
      if (row.balance_points !== undefined && row.balance_points !== null) {
        patch.balance_dollars = row.balance_points / LEGACY_POINTS_PER_DOLLAR;
        patch.balance_points = undefined;
      }

      // Auto-reload threshold
      if (
        row.auto_reload_threshold_points !== undefined &&
        row.auto_reload_threshold_points !== null
      ) {
        patch.auto_reload_threshold_dollars =
          row.auto_reload_threshold_points / LEGACY_POINTS_PER_DOLLAR;
        patch.auto_reload_threshold_points = undefined;
      }

      // Monthly cap
      if (
        row.monthly_cap_points !== undefined &&
        row.monthly_cap_points !== null
      ) {
        patch.monthly_cap_dollars =
          row.monthly_cap_points / LEGACY_POINTS_PER_DOLLAR;
        patch.monthly_cap_points = undefined;
      }

      // Monthly spent
      if (
        row.monthly_spent_points !== undefined &&
        row.monthly_spent_points !== null
      ) {
        patch.monthly_spent_dollars =
          row.monthly_spent_points / LEGACY_POINTS_PER_DOLLAR;
        patch.monthly_spent_points = undefined;
      }

      await ctx.db.patch(row._id, patch);
      migrated++;
    }

    return { migrated, skipped, total: allRows.length };
  },
});
