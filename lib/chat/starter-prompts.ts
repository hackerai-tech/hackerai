import type { ChatMode } from "@/types/chat";

/** Bump when the catalog or its per-mode placement changes meaningfully. */
export const CHAT_STARTERS_DEFINITION_VERSION = 2;

export type ChatStarterId =
  | "test_target"
  | "fix_tool_error"
  | "plan_test"
  | "explain_results"
  | "write_up_findings";

export type ChatStarter = {
  /** Stable analytics identifier; never rename an existing ID. */
  id: ChatStarterId;
  label: string;
  description: string;
  prompt: string;
};

export type ChatStarterPresentation = "expanded" | "collapsed";

const CHAT_STARTERS: Record<ChatStarterId, ChatStarter> = {
  test_target: {
    id: "test_target",
    label: "Test a target",
    description: "A URL or IP you're authorized to test, within scope",
    prompt:
      "Test [URL or IP] within [scope]. Start with recon, dig into promising leads, and report what you verified with evidence and useful next steps; ask only if scope details are missing.",
  },
  fix_tool_error: {
    id: "fix_tool_error",
    label: "Fix a tool error",
    description: "Command, output and what you expected",
    prompt:
      "Help me fix this [tool] error on [OS or environment] and explain the fix; ask if you need more details. Command, output and what I expected: [paste]",
  },
  plan_test: {
    id: "plan_test",
    label: "Plan a test",
    description: "The most useful checks first",
    prompt:
      "Help me plan a test of [URL or IP] within [scope]. Prioritize the most useful checks and tell me what you need from me.",
  },
  explain_results: {
    id: "explain_results",
    label: "Explain results",
    description: "Observations vs. possible false positives",
    prompt:
      "Explain these [tool] results and separate solid observations from possible false positives. Then suggest what to verify next: [paste or attach]",
  },
  write_up_findings: {
    id: "write_up_findings",
    label: "Write up findings",
    description: "Test notes into a clear report",
    prompt:
      "Turn these test notes into a clear report with summary, evidence, impact and next steps. Mark anything unverified and don't invent evidence: [paste or attach]",
  },
};

// Ask cannot run live checks, so "Test a target" is Agent-only. Report writing
// mostly follows testing and stays last in both modes. Mobile shows the
// featured entries with the rest in a menu; desktop shows all in this order.
const STARTER_LAYOUT: Record<
  ChatMode,
  { featured: ChatStarterId[]; more: ChatStarterId[] }
> = {
  agent: {
    featured: ["test_target", "fix_tool_error"],
    more: ["plan_test", "explain_results", "write_up_findings"],
  },
  ask: {
    featured: ["fix_tool_error", "plan_test"],
    more: ["explain_results", "write_up_findings"],
  },
};

export function getChatStarterById(id: string): ChatStarter | undefined {
  return Object.prototype.hasOwnProperty.call(CHAT_STARTERS, id)
    ? CHAT_STARTERS[id as ChatStarterId]
    : undefined;
}

export function getChatStartersForMode(mode: ChatMode): {
  featured: ChatStarter[];
  more: ChatStarter[];
} {
  const layout = STARTER_LAYOUT[mode] ?? STARTER_LAYOUT.ask;
  return {
    featured: layout.featured.map((id) => CHAT_STARTERS[id]),
    more: layout.more.map((id) => CHAT_STARTERS[id]),
  };
}
