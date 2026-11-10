import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import type { CaptchaKind } from "./detection";

export interface CaptchaJournal {
  reserve(kind: CaptchaKind): Promise<boolean>;
  registerTask(taskId: number): Promise<void>;
  recordCost(taskId: number, costDollars: number): Promise<void>;
}

export function createCaptchaJournal(scope: {
  serviceKey: string;
  userId: string;
  chatId: string;
  runId: string;
}): CaptchaJournal {
  const { chatId, ...identity } = scope;
  return {
    reserve: (kind) =>
      getConvexClient().mutation(api.captchaAttempts.reserve, {
        ...scope,
        kind,
      }),
    async registerTask(taskId) {
      await getConvexClient().mutation(api.captchaAttempts.registerTask, {
        ...identity,
        taskId,
      });
    },
    async recordCost(taskId, costDollars) {
      await getConvexClient().mutation(api.captchaAttempts.recordCost, {
        ...identity,
        taskId,
        costDollars,
      });
    },
  };
}
