import { Migrations } from "@convex-dev/migrations";

import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";

const migrations = new Migrations<DataModel>(components.migrations);

/**
 * Clears redundant and legacy usage-log fields in resumable batches.
 *
 * Run a production dry run first:
 * npx convex run migrations:clearRemovedUsageLogFields '{"dryRun":true}' --prod
 *
 * Then start or resume the migration:
 * npx convex run migrations:clearRemovedUsageLogFields --prod
 */
export const clearRemovedUsageLogFields = migrations.define({
  table: "usage_logs",
  migrateOne: (_ctx, log) => {
    if (
      log.max_mode === undefined &&
      log.byok === undefined &&
      log.total_tokens === undefined &&
      log.usage_deduction_failed === undefined
    ) {
      return;
    }

    return {
      max_mode: undefined,
      byok: undefined,
      total_tokens: undefined,
      usage_deduction_failed: undefined,
      // Preserve any legacy boolean-only failure signal in the retained,
      // queryable reason field before removing the redundant boolean.
      usage_deduction_failure_reason:
        log.usage_deduction_failure_reason ??
        (log.usage_deduction_failed === true ? "deduction_failed" : undefined),
    };
  },
});
