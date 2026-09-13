"use client";

import { useConvex } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { waitForDeletion } from "@/lib/utils/wait-for-deletion";
import { toast } from "sonner";

export function useDeletionConfirmation() {
  const convex = useConvex();
  return async (
    start: () => Promise<unknown>,
    scope: {
      chatId?: string;
      projectId?: Id<"projects">;
      fileId?: Id<"files">;
    },
    label = "Deleting…",
  ) => {
    // The initiating sidebar row can disappear during a batch. A global toast
    // keeps progress visible until storage and database cleanup both finish.
    const toastId = toast.loading(label, { duration: Infinity });
    try {
      await start();
      await waitForDeletion(() =>
        convex.query(api.deletions.getStatusForUser, scope),
      );
    } finally {
      toast.dismiss(toastId);
    }
  };
}
