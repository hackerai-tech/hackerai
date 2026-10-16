import "server-only";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "./convex-client";
export const stoppedWorkStore = (userId: string, chatId: string) => {
  const owner = {
    userId,
    chatId,
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
  };
  return {
    load: () =>
      getConvexClient().query(api.chats.getStoppedWorkForBackend, owner),
    apply: (
      args: Omit<
        Parameters<typeof getApply>[0],
        "userId" | "chatId" | "serviceKey"
      >,
    ) => getApply({ ...owner, ...args }),
  };
};
function getApply(
  args: import("convex/server").FunctionArgs<
    typeof api.chats.applyStoppedWorkForBackend
  >,
) {
  return getConvexClient().mutation(api.chats.applyStoppedWorkForBackend, args);
}
