import { v } from "convex/values";

export const paidModelEnrollmentFields = {
  user_id: v.string(),
  organization_id: v.string(),
  variant: v.union(v.literal("control"), v.literal("test")),
  enrolled_at: v.number(),
  subscription_tier: v.union(
    v.literal("pro"),
    v.literal("pro-plus"),
    v.literal("ultra"),
  ),
  stripe_subscription_id: v.string(),
  stripe_customer_id: v.string(),
  baseline_renewal_at: v.number(),
  billing_interval: v.string(),
  billing_interval_count: v.number(),
  subscription_started_at: v.number(),
  cancel_at_period_end: v.boolean(),
  subscription_status: v.string(),
};
export const paidModelEnrollmentDocument = v.object({
  ...paidModelEnrollmentFields,
  _id: v.id("paid_model_enrollments"),
  _creationTime: v.number(),
});
