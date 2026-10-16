import type { ToolSet } from "ai";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { decideUrl, scopePrompt, type ScopeSnapshot } from "./policy";

export type ScopeRuntime = ReturnType<typeof createScopeRuntime>;
export function createScopeRuntime(
  userId: string,
  chatId: string,
  child = false,
) {
  const args = {
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    userId,
    chatId,
  };
  let last: ScopeSnapshot | null = null;
  let promptedRevision: number | undefined;
  let clarificationRevision: number | undefined;
  async function load(): Promise<ScopeSnapshot | null> {
    try {
      last = await getConvexClient().query(
        api.engagementScopes.getForBackend,
        args,
      );
      return last;
    } catch {
      return {
        rules: last?.rules ?? [],
        restrictions: last?.restrictions ?? [],
        revision: last?.revision ?? 0,
        clarification: "",
        clarificationRequested: true,
        status: "unavailable",
      };
    }
  }
  return {
    async prompt(claim = true): Promise<string> {
      const scope = await load();
      promptedRevision = scope?.revision;
      let mayAsk = false;
      if (
        claim &&
        !child &&
        scope?.status === "ambiguous" &&
        !scope.clarificationRequested &&
        clarificationRevision !== scope.revision
      ) {
        try {
          mayAsk = await getConvexClient().mutation(
            api.engagementScopes.claimClarification,
            { ...args, revision: scope.revision },
          );
          clarificationRevision = scope.revision;
        } catch {
          /* The visible scope panel still retains the unresolved detail. */
        }
      }
      return scopePrompt(scope, mayAsk);
    },
    async checkUrl(url: string) {
      return decideUrl(await load(), url);
    },
    async checkTool(name: string) {
      if (
        ![
          "run_terminal_cmd",
          "interact_terminal_session",
          "delegate_task",
          "spawn_subagent",
          "validate_finding",
        ].includes(name)
      )
        return;
      const scope = await load();
      if (
        scope &&
        scope.revision !== promptedRevision &&
        (scope.status === "ready" || scope.status === "ambiguous")
      )
        throw new Error(
          "Saved scope changed. Refresh scope context before another active action; do not ask the user to reconfirm it.",
        );
      if (
        scope &&
        !scope.rules.some(
          (rule) =>
            rule.effect === "allow" && rule.activity !== "passive_discovery",
        ) &&
        scope.status !== "processing" &&
        scope.status !== "unavailable"
      )
        throw new Error(
          "No active targets are saved in this engagement. Continue offline work; use the scope detail already shown to the user without repeating it.",
        );
      if (scope?.status === "processing" || scope?.status === "unavailable")
        throw new Error(
          "Scope is temporarily unavailable. Hold active execution and continue offline work. Do not ask for authorization again.",
        );
    },
  };
}
export function guardScopeTools(tools: ToolSet, scope: ScopeRuntime): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      const execute = definition?.execute;
      if (!execute) return [name, definition];
      return [
        name,
        {
          ...definition,
          execute: async (...args: Parameters<typeof execute>) => {
            await scope.checkTool(name);
            return execute(...args);
          },
        },
      ];
    }),
  ) as ToolSet;
}
