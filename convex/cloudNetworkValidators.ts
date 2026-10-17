import { v } from "convex/values";
export const networkPolicy = v.object({
  mode: v.union(
    v.literal("unrestricted"),
    v.literal("restricted"),
    v.literal("offline"),
  ),
  allow: v.array(v.string()),
});
export const cloudProxy = v.object({
  address: v.string(),
  authenticated: v.boolean(),
  revision: v.string(),
});
export const networkSettings = v.object({
  policy: networkPolicy,
  proxy: v.optional(v.union(v.null(), cloudProxy)),
  proxyManaged: v.optional(v.boolean()),
  revision: v.number(),
  status: v.union(
    v.literal("ready"),
    v.literal("applying"),
    v.literal("failed"),
  ),
});
