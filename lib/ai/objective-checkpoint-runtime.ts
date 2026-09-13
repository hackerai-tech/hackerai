import { createHash } from "node:crypto";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  assessObjective,
  checkpointInstruction,
  MAX_CHECKPOINT_ACTIONS,
  objectiveAssessmentSchema,
  reconcileObjective,
  type ObjectiveCheckpoint,
} from "@/lib/chat/objective-checkpoint";

// These tools coordinate existing work or report it; none begins exploration.
function summarizeOutput(output: unknown): string {
  try {
    return (JSON.stringify(output) ?? "No output").slice(0, 2_000);
  } catch {
    return "Tool returned output that could not be summarized; use the saved transcript.";
  }
}

const REPORT_TOOLS = new Set([
  "update_work_ledger",
  "todo_write",
  "report_to_parent",
  "submit_task_result",
  "submit_validation_result",
  "list_agents",
  "wait_for_agents",
  "cancel_agent",
]);

export class ObjectiveCheckpointRuntime {
  private queue: Promise<unknown> = Promise.resolve();
  private storageFailed = false;
  private exposed = false;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    readonly state: ObjectiveCheckpoint,
    private readonly save: (state: ObjectiveCheckpoint) => Promise<void>,
    private readonly environment: () => Promise<string>,
    private readonly signal: AbortSignal,
    private readonly event: (
      name: string,
      fields: Record<string, string | number | boolean | null>,
    ) => void = () => {},
    private readonly priorSpendDollars = 0,
  ) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private persist() {
    const write = this.writes.then(async () => {
      if (this.storageFailed)
        throw new Error(
          "Objective checkpoint storage unavailable; stop before further actions.",
        );
      try {
        await this.save(this.state);
      } catch (error) {
        this.storageFailed = true;
        throw error;
      }
    });
    this.writes = write.catch(() => undefined);
    return write;
  }

  async reconcile() {
    this.signal.throwIfAborted();
    try {
      reconcileObjective(this.state, await this.environment());
    } catch {
      this.state.blocker =
        "The previous sandbox is unavailable; reconcile saved actions and artifacts before continuing.";
    }
    this.signal.throwIfAborted();
    // Artifact references are not evidence of availability or content identity.
    // Without a transport-independent verifier, stop rather than assume survival.
    if (this.state.artifacts.length) {
      this.state.blocker ??=
        "Saved artifacts require availability and content-identity verification before resuming.";
    }
    await this.persist();
  }

  async recordSpend(spend: number) {
    this.state.spendDollars = Math.max(
      this.state.spendDollars,
      this.priorSpendDollars + spend,
    );
    this.event("agent_objective_checkpoint_spend", {
      spend_dollars: this.state.spendDollars,
      run_spend_dollars: Math.max(
        0,
        this.state.spendDollars - this.priorSpendDollars,
      ),
      spend_since_observation_dollars: Math.max(
        0,
        this.state.spendDollars -
          (this.state.spendAtLastObservationDollars ?? 0),
      ),
      checkpoint: !!this.state.blocker,
      completed_actions: this.state.actions.filter(
        (a) => a.state === "completed",
      ).length,
      unknown_actions: this.state.actions.filter(
        (a) => a.state === "outcome_unknown",
      ).length,
      reserved_dollars: null,
    });
    await this.persist().catch(() => {
      this.state.blocker =
        "Checkpoint storage failed; return the saved partial work before further actions.";
    });
  }

  restriction(
    tools: ToolSet,
  ): { activeTools: string[]; instruction: string } | undefined {
    if (this.storageFailed)
      this.state.blocker =
        "Checkpoint storage failed; further actions cannot safely start.";
    if (this.state.blocker)
      return {
        activeTools: [
          ...Object.keys(tools).filter((name) => REPORT_TOOLS.has(name)),
          ...(this.canReconcile(tools) ? ["reconcile_objective_action"] : []),
        ],
        instruction: checkpointInstruction(this.state),
      };
    if (
      this.state.actions.some(
        (action) =>
          !action.assessed && ["completed", "failed"].includes(action.state),
      )
    ) {
      return {
        activeTools: ["assess_objective_progress"],
        instruction: checkpointInstruction(this.state),
      };
    }
  }

  private canReconcile(tools: ToolSet) {
    return (
      !this.storageFailed &&
      !!tools.interact_terminal_session &&
      this.state.actions.some(
        (a) =>
          a.session &&
          ["running", "outcome_unknown"].includes(a.state) &&
          (a.reconciliationAttempts ?? 0) < 2,
      )
    );
  }

  wrap(tools: ToolSet): ToolSet {
    const wrapped = Object.fromEntries(
      Object.entries(tools).map(([name, definition]) => {
        const execute = definition.execute;
        if (!execute || REPORT_TOOLS.has(name)) return [name, definition];
        return [
          name,
          {
            ...definition,
            execute: async (...args: Parameters<typeof execute>) => {
              // Serialize starts as well as writes. A parallel batch cannot step around assessment.
              const operation = this.queue.then(async () => {
                this.signal.throwIfAborted();
                const restriction = this.restriction(tools);
                if (restriction)
                  return {
                    checkpoint: restriction.instruction,
                    executed: false,
                  };
                const id = args[1].toolCallId;
                const normalizedInput =
                  args[0] && typeof args[0] === "object"
                    ? Object.fromEntries(
                        Object.entries(args[0])
                          .filter(
                            ([key]) =>
                              ![
                                "brief",
                                "explanation",
                                "justification",
                              ].includes(key),
                          )
                          .sort(([a], [b]) => a.localeCompare(b)),
                      )
                    : args[0];
                const inputFingerprint = createHash("sha256")
                  .update(JSON.stringify([name, normalizedInput]))
                  .digest("hex");
                const saved = this.state.actions.find(
                  (a) =>
                    a.inputFingerprint === inputFingerprint &&
                    ["completed", "running", "outcome_unknown"].includes(
                      a.state,
                    ),
                );
                if (saved)
                  return {
                    executed: false,
                    action_id: saved.id,
                    state: saved.state,
                    saved_result: saved.resultSummary,
                    instruction:
                      "This action is already recorded. Use its saved result or reconcile its status; do not replay it.",
                  };

                const existing = this.state.actions.find(
                  (action) => action.id === id,
                );
                if (existing)
                  return {
                    executed: false,
                    action_id: id,
                    state: existing.state,
                    instruction:
                      "Use the saved result; do not replay this action.",
                  };
                if (this.state.actions.length >= MAX_CHECKPOINT_ACTIONS) {
                  this.state.blocker =
                    "The bounded action checkpoint is full. Return the completed work before starting a follow-up.";
                  await this.persist();
                  return {
                    executed: false,
                    checkpoint: checkpointInstruction(this.state),
                  };
                }
                const action: ObjectiveCheckpoint["actions"][number] = {
                  id,
                  tool: name,
                  inputFingerprint,
                  state: "pending",
                  assessed: false,
                };
                this.state.actions.push(action);
                await this.persist();
                this.signal.throwIfAborted();
                let identity: string;
                try {
                  identity = await this.environment();
                } catch {
                  this.state.blocker =
                    "The sandbox is unavailable. No new action was started.";
                  await this.persist();
                  return {
                    executed: false,
                    checkpoint: checkpointInstruction(this.state),
                  };
                }
                if (
                  this.state.environment &&
                  this.state.environment !== identity
                ) {
                  this.state.blocker =
                    "Sandbox identity changed before execution; verify earlier work before proceeding.";
                  await this.persist();
                  return {
                    executed: false,
                    checkpoint: checkpointInstruction(this.state),
                  };
                }
                this.state.environment = identity;
                this.signal.throwIfAborted();
                action.state = "running";
                await this.persist();
                this.signal.throwIfAborted();
                if (!this.exposed) {
                  this.exposed = true;
                  this.event("agent_objective_checkpoint_exposed", {
                    threshold: 2,
                  });
                }
                let output: unknown;
                try {
                  output = await execute(...args);
                } catch (error) {
                  action.state = "outcome_unknown";
                  this.state.blocker =
                    "A tool ended without a confirmed result. Its external effects are unknown; verify before retrying.";
                  await this.persist();
                  throw error;
                }
                // A tool returning does not prove a background process has completed.
                const result =
                  output && typeof output === "object" && "result" in output
                    ? output.result
                    : output;
                const record =
                  result && typeof result === "object"
                    ? (result as Record<string, unknown>)
                    : {};
                action.resultSummary = summarizeOutput(output);
                action.state =
                  record.error ||
                  (typeof record.exitCode === "number" && record.exitCode !== 0)
                    ? "failed"
                    : "completed";
                if (
                  (record.session &&
                    !record.exited &&
                    record.exitCode == null) ||
                  record.background === true ||
                  (record.timedOut && record.exitCode == null)
                ) {
                  action.session =
                    typeof record.session === "string"
                      ? record.session
                      : undefined;
                  action.state = action.session ? "running" : "outcome_unknown";
                  this.state.blocker =
                    "A tool returned ongoing work. Reconcile that action's status before starting further work.";
                }
                await this.persist();
                return output;
              });
              this.queue = operation.catch(() => undefined);
              return operation;
            },
          },
        ];
      }),
    );
    return {
      ...wrapped,
      ...(tools.interact_terminal_session?.execute
        ? {
            reconcile_objective_action: tool({
              description:
                "Read the status of a recorded ongoing terminal action, at most twice. Does not send input or replay commands.",
              inputSchema: z
                .object({ action_id: z.string().min(1).max(1_000) })
                .strict(),
              execute: async ({ action_id }, options) =>
                this.serialize(async () => {
                  this.signal.throwIfAborted();
                  const action = this.state.actions.find(
                    (a) => a.id === action_id,
                  );
                  if (
                    !action?.session ||
                    !["running", "outcome_unknown"].includes(action.state) ||
                    (action.reconciliationAttempts ?? 0) >= 2
                  ) {
                    return {
                      reconciled: false,
                      instruction:
                        "Return the unknown outcome and blocker without replaying it.",
                    };
                  }
                  if ((await this.environment()) !== this.state.environment) {
                    return {
                      reconciled: false,
                      instruction:
                        "Sandbox changed; do not inspect a session in a different environment.",
                    };
                  }
                  this.signal.throwIfAborted();
                  action.reconciliationAttempts =
                    (action.reconciliationAttempts ?? 0) + 1;
                  await this.persist();
                  const output = await tools.interact_terminal_session.execute!(
                    { session: action.session, action: "view" },
                    options,
                  );
                  this.signal.throwIfAborted();
                  const result =
                    output && typeof output === "object" && "result" in output
                      ? (output.result as Record<string, unknown>)
                      : {};
                  const exited = result?.exited as
                    { exitCode?: unknown } | undefined;
                  if (typeof exited?.exitCode === "number") {
                    action.state =
                      exited.exitCode === 0 ? "completed" : "failed";
                    action.resultSummary = summarizeOutput(output);
                    if (
                      !this.state.artifacts.length &&
                      this.state.unsuccessfulAttempts < 2 &&
                      !this.state.actions.some((a) =>
                        ["running", "outcome_unknown"].includes(a.state),
                      )
                    )
                      this.state.blocker = undefined;
                  } else if (result?.error) action.state = "outcome_unknown";
                  await this.persist();
                  this.event("agent_objective_action_reconciled", {
                    outcome: action.state,
                    attempts: action.reconciliationAttempts,
                  });
                  return { action_id, state: action.state, output };
                }),
            }),
          }
        : {}),
      assess_objective_progress: tool({
        description:
          "Assess the last tool result against the current objective before taking another action. Preserve useful negative evidence, partial work, blocker and artifact references. This does not verify factual claims.",
        inputSchema: objectiveAssessmentSchema,
        execute: async (input) =>
          this.serialize(async () => {
            this.signal.throwIfAborted();
            if (this.state.blocker)
              return { checkpoint: checkpointInstruction(this.state) };
            assessObjective(this.state, input);
            this.event("agent_objective_progress_assessed", {
              outcome: input.outcome,
              checkpoint: !!this.state.blocker,
              unsuccessful_attempts: this.state.unsuccessfulAttempts,
              spend_dollars: this.state.spendDollars,
              spend_since_observation_dollars: Math.max(
                0,
                this.state.spendDollars -
                  (this.state.spendAtLastObservationDollars ?? 0),
              ),
              reserved_dollars: null,
            });
            await this.persist();
            return {
              checkpoint: this.state.blocker
                ? checkpointInstruction(this.state)
                : undefined,
              unsuccessful_attempts: this.state.unsuccessfulAttempts,
            };
          }),
      }),
    };
  }
}
