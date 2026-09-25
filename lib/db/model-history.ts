import "server-only";
import { makeFunctionReference } from "convex/server";
import { getConvexClient } from "./convex-client";
import {
  MODEL_HISTORY_MAX_BYTES,
  type ModelHistorySnapshot,
} from "@/lib/chat/model-history";

type Owner = { serviceKey: string; chatId: string; userId: string };
export const MODEL_HISTORY_DEADLINE_MS = 1500;
export class ModelHistoryTimeoutError extends Error {
  constructor() {
    super("Model history storage deadline exceeded");
  }
}

async function withHistoryDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ModelHistoryTimeoutError()),
          MODEL_HISTORY_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const loadReference = makeFunctionReference<
  "mutation",
  Owner,
  { revision: number; payload: string | null } | null
>("modelHistory:load");
const saveReference = makeFunctionReference<
  "mutation",
  Owner & { revision: number; startedAt: number; payload: string },
  boolean
>("modelHistory:save");

export async function loadModelHistory(chatId: string, userId: string) {
  return withHistoryDeadline(
    getConvexClient().mutation(loadReference, {
      chatId,
      userId,
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    }),
  );
}

export async function saveModelHistory(
  chatId: string,
  userId: string,
  revision: number,
  startedAt: number,
  snapshot: ModelHistorySnapshot,
) {
  const payload = JSON.stringify(snapshot);
  if (Buffer.byteLength(payload) > MODEL_HISTORY_MAX_BYTES)
    return "too_large" as const;
  const saved = await withHistoryDeadline(
    getConvexClient().mutation(saveReference, {
      chatId,
      userId,
      revision,
      startedAt,
      payload,
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    }),
  );
  return saved ? ("saved" as const) : ("rejected" as const);
}
