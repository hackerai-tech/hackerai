import { v } from "convex/values";
export const scopeRule = v.object({
  target: v.string(),
  effect: v.union(v.literal("allow"), v.literal("deny")),
  ports: v.optional(v.literal("any")),
  activity: v.union(
    v.literal("active_testing"),
    v.literal("all_contact"),
    v.literal("passive_discovery"),
  ),
});
export const scopePolicy = v.object({
  rules: v.array(scopeRule),
  restrictions: v.array(v.string()),
});
