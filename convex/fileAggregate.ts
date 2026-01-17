import { TableAggregate } from "@convex-dev/aggregate";
import { components } from "./_generated/api";
import { DataModel } from "./_generated/dataModel";

/**
 * Aggregate for counting files and summing storage per user using O(log(n)) operations.
 *
 * This replaces the O(n) .collect().length pattern with efficient counting.
 * Files are namespaced by user_id so each user's count is independent.
 *
 * The sortKey is null because we only need counts/sums, not ordering.
 * The sumValue tracks file sizes in bytes for storage quota enforcement.
 */
export const fileCountAggregate = new TableAggregate<{
  Namespace: string;
  Key: null;
  DataModel: DataModel;
  TableName: "files";
}>(components.fileCountByUser, {
  namespace: (doc) => doc.user_id,
  sortKey: () => null,
  sumValue: (doc) => doc.size,
});
