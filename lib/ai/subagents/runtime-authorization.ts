import type { ToolSet } from "ai";

import { SUBAGENT_TERMINAL_STATUSES, type SubagentStatus } from "./contracts";

const ACTIVE_PARENT_RUN_STATUSES = new Set([
  "DELAYED",
  "DEQUEUED",
  "EXECUTING",
  "PENDING_VERSION",
  "QUEUED",
  "WAITING",
]);

type ChildRunAuthorizationSnapshot = {
  status: SubagentStatus;
  parent_trigger_run_id: string;
  trigger_run_id?: string;
};

type ParentRunAuthorizationSnapshot = {
  status?: string;
};

export class SubagentRuntimeAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentRuntimeAuthorizationError";
  }
}

export async function assertSubagentRuntimeAuthorized(args: {
  subagentId: string;
  childTriggerRunId: string;
  parentTriggerRunId: string;
  loadChild: (
    subagentId: string,
  ) => Promise<ChildRunAuthorizationSnapshot | null>;
  retrieveParent: (
    parentTriggerRunId: string,
  ) => Promise<ParentRunAuthorizationSnapshot>;
}): Promise<void> {
  const child = await args.loadChild(args.subagentId);
  if (
    !child ||
    child.trigger_run_id !== args.childTriggerRunId ||
    child.parent_trigger_run_id !== args.parentTriggerRunId ||
    SUBAGENT_TERMINAL_STATUSES.has(child.status)
  ) {
    throw new SubagentRuntimeAuthorizationError(
      "Subagent execution authorization was revoked",
    );
  }

  const parent = await args.retrieveParent(args.parentTriggerRunId);
  if (
    typeof parent.status !== "string" ||
    !ACTIVE_PARENT_RUN_STATUSES.has(parent.status)
  ) {
    throw new SubagentRuntimeAuthorizationError(
      "Parent Agent run is no longer active",
    );
  }
}

export function guardSubagentToolExecutions(
  tools: ToolSet,
  authorize: () => Promise<void>,
  capabilities?: {
    canWriteFiles: boolean;
    browserCommandsOnly?: boolean;
  },
): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      const execute = definition.execute;
      if (!execute) return [name, definition];

      return [
        name,
        {
          ...definition,
          execute: async (...args: Parameters<typeof execute>) => {
            await authorize();
            if (
              name === "file" &&
              !capabilities?.canWriteFiles &&
              typeof args[0] === "object" &&
              args[0] !== null &&
              "action" in args[0] &&
              !["read", "view"].includes(
                String((args[0] as { action?: unknown }).action),
              )
            ) {
              throw new SubagentRuntimeAuthorizationError(
                "The delegated capability bundle does not permit file writes",
              );
            }
            if (
              name === "run_terminal_cmd" &&
              capabilities?.browserCommandsOnly &&
              typeof args[0] === "object" &&
              args[0] !== null
            ) {
              const command = String(
                (args[0] as { command?: unknown }).command ?? "",
              ).trim();
              if (
                !/^agent-browser(?:\s|$)/.test(command) ||
                /[;&|><`$\n\r]/.test(command)
              ) {
                throw new SubagentRuntimeAuthorizationError(
                  "The browser_qa capability only permits direct agent-browser commands",
                );
              }
            }
            return await execute(...args);
          },
        },
      ];
    }),
  ) as ToolSet;
}
