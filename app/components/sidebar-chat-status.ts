export type SidebarInputReason = "approval" | "reply" | "goal" | "browser";

export function getSidebarChatStatus(chat: {
  active_agent_approval_pending?: boolean;
  active_agent_user_wait?: { status: "waiting" | "submitting" };
  goal_needs_input?: boolean;
  browser_needs_input?: boolean;
  active_stream_id?: string;
  active_trigger_run_id?: string;
}): { needsInputReason?: SidebarInputReason; isStreaming: boolean } {
  const needsInputReason = chat.active_agent_approval_pending
    ? "approval"
    : chat.active_agent_user_wait?.status === "waiting"
      ? "reply"
      : chat.goal_needs_input
        ? "goal"
        : chat.browser_needs_input
          ? "browser"
          : undefined;
  return {
    needsInputReason,
    isStreaming:
      !needsInputReason &&
      (!!chat.active_stream_id || !!chat.active_trigger_run_id),
  };
}
