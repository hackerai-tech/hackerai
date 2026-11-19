import "server-only";

import { api } from "@/convex/_generated/api";
import { getConvexClient } from "./convex-client";

import type { UserInputQuestion } from "../chat/user-input-questions";

type WaitIdentity = {
  chatId: string;
  userId: string;
  runId: string;
  toolCallId: string;
};

const serviceKey = () => {
  const key = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Convex service role key is unavailable");
  return key;
};

export const setActiveAgentUserWait = (
  input: WaitIdentity & { tokenId?: string; questions?: UserInputQuestion[] },
) =>
  getConvexClient().mutation(api.chats.setActiveAgentUserWait, {
    serviceKey: serviceKey(),
    ...input,
  });

export const claimAgentUserWaitReply = (
  input: WaitIdentity & { replyId: string; replyHash: string },
) =>
  getConvexClient().mutation(api.chats.claimAgentUserWaitReply, {
    serviceKey: serviceKey(),
    ...input,
  });
