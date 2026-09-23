import "server-only";
import { makeFunctionReference } from "convex/server";
import { getConvexClient } from "./convex-client";
import {
  MODEL_HISTORY_MAX_BYTES,
  type ModelHistorySnapshot,
} from "@/lib/chat/model-history";

type Owner = { serviceKey: string; chatId: string; userId: string };
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
  return getConvexClient().mutation(loadReference, {
    chatId,
    userId,
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
  });
}

export async function saveModelHistory(
  chatId: string,
  userId: string,
  revision: number,
  startedAt: number,
  snapshot: ModelHistorySnapshot,
) {
  const payload = JSON.stringify(snapshot);
  if (Buffer.byteLength(payload) > MODEL_HISTORY_MAX_BYTES) return false;
  return getConvexClient().mutation(saveReference, {
    chatId,
    userId,
    revision,
    startedAt,
    payload,
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
  });
}
