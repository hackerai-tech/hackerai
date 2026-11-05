import { v } from "convex/values";
export const networkPolicy = v.object({
  mode: v.union(
    v.literal("unrestricted"),
    v.literal("restricted"),
    v.literal("offline"),
  ),
  allow: v.array(v.string()),
});
export const networkSettings = v.object({
  policy: networkPolicy,
  revision: v.number(),
  status: v.union(
    v.literal("ready"),
    v.literal("applying"),
    v.literal("failed"),
  ),
});
