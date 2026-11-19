import { z } from "zod";

export const failureSchema = z.object({
  sandboxId: z.string().min(1),
  region: z.enum(["us-east-1", "us-west-2", "eu-central-1"]),
  template: z.string().min(1),
  sandboxVersion: z.string().min(1),
  attempts: z.array(z.string().uuid()).min(1).max(2),
  uncertain: z.boolean(),
  timeoutOnly: z.boolean().optional(),
  lastFailedAt: z.number(),
});
export type ResumeFailures = z.infer<typeof failureSchema>;
