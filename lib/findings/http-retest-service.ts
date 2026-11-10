import { createHash } from "node:crypto";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { HybridSandboxManager } from "@/lib/ai/tools/utils/hybrid-sandbox-manager";
import { getSandboxWithFallbackGuard } from "@/lib/ai/tools/utils/sandbox-fallback";
import {
  getSandboxInfoForInstance,
  isCentrifugoSandbox,
} from "@/lib/ai/tools/utils/sandbox-types";
import { phLogger } from "@/lib/posthog/server";
import type { AnySandbox, SubscriptionTier } from "@/types";
import {
  classifyHttpRetest,
  httpRetestFindingOrigin,
  parseHttpRetestRecipe,
  type HttpRetestClassification,
  type HttpRetestStep,
} from "./http-retest";
import { runHttpRetestInSandbox } from "./http-retest-runner";
import { validateRunCredentials } from "./http-retest-policy";

const serviceKey = () => process.env.CONVEX_SERVICE_ROLE_KEY!;

/** Acquisition + runner command + Convex writes must fit the route's 100 s
 * maxDuration, which is itself inside the 120 s run lease. */
export const HTTP_RETEST_ACQUISITION_TIMEOUT_MS = 30_000;

export type HttpRetestState = Awaited<ReturnType<typeof getHttpRetestState>>;

export function getHttpRetestState({
  userId,
  findingId,
  chatId,
}: {
  userId: string;
  findingId: string;
  chatId?: string;
}) {
  return getConvexClient().query(api.findingRetests.getStateForBackend, {
    serviceKey: serviceKey(),
    userId,
    findingId,
    ...(chatId !== undefined && { chatId }),
  });
}

export async function saveHttpRetestRecipe({
  userId,
  findingId,
  chatId,
  expectedVersion,
  recipe,
  source,
}: {
  userId: string;
  findingId: string;
  chatId?: string;
  expectedVersion: number;
  recipe: unknown;
  source: "user" | "agent";
}) {
  const parsed = parseHttpRetestRecipe(recipe);
  if (!parsed.success)
    return {
      success: false as const,
      error: "validation" as const,
      message: parsed.message,
    };
  return getConvexClient().mutation(api.findingRetests.saveRecipeForBackend, {
    serviceKey: serviceKey(),
    userId,
    findingId,
    ...(chatId !== undefined && { chatId }),
    expectedVersion,
    recipe: parsed.recipe,
    source,
  });
}

/** Client-visible review fence without exposing the private connection ID. */
export const httpRetestEnvironmentRevision = (
  findingId: string,
  preference: string,
) =>
  createHash("sha256")
    .update(JSON.stringify([findingId, preference]))
    .digest("hex");

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

/** Content address of the immutable run snapshot. Contains no secrets. */
export function httpRetestEvidenceSha256(snapshot: Record<string, unknown>) {
  return createHash("sha256").update(stableJson(snapshot)).digest("hex");
}

type Environment = { kind: "cloud" | "local" | "desktop"; name?: string };

const environmentFor = (sandbox: AnySandbox): Environment => {
  const info = getSandboxInfoForInstance(sandbox);
  const kind =
    info.type === "cloud"
      ? "cloud"
      : info.type === "desktop"
        ? "desktop"
        : "local";
  return { kind, ...(info.name && { name: info.name.slice(0, 80) }) };
};

export type RunHttpRetestError =
  "not_found" | "conflict" | "busy" | "rate_limited" | "validation";

export type RunHttpRetestResult =
  | {
      success: true;
      run: Extract<
        Awaited<ReturnType<typeof startRun>>,
        { success: true }
      >["run"];
    }
  | { success: false; error: RunHttpRetestError; message: string };

function startRun(args: {
  userId: string;
  findingId: string;
  requestId: string;
  recipeVersion: number;
  reviewedSandbox: string;
}) {
  return getConvexClient().mutation(api.findingRetests.startRunForBackend, {
    serviceKey: serviceKey(),
    ...args,
  });
}

/**
 * Execute one deliberate, user-reviewed retest. The run is claimed before any
 * request is sent and always finalized with a controlled outcome. The
 * credentials object lives only for this call and is never logged or stored.
 */
export async function runHttpRetest({
  userId,
  subscription,
  findingId,
  requestId,
  recipeVersion,
  reviewedOrigin,
  reviewedEnvironment,
  credentials: credentialInput,
}: {
  userId: string;
  subscription: SubscriptionTier;
  findingId: string;
  requestId: string;
  recipeVersion: number;
  reviewedOrigin: string;
  reviewedEnvironment: string;
  credentials: unknown;
}): Promise<RunHttpRetestResult> {
  const state = await getHttpRetestState({ userId, findingId });
  if (!state.available)
    return {
      success: false,
      error: "not_found",
      message: "This finding is not available.",
    };
  if (
    !state.recipe ||
    state.recipe.version !== recipeVersion ||
    state.recipe.recipe.origin !== reviewedOrigin ||
    httpRetestFindingOrigin(state.finding.target) !== reviewedOrigin ||
    httpRetestEnvironmentRevision(
      findingId,
      state.finding.sandbox_preference,
    ) !== reviewedEnvironment
  )
    return {
      success: false,
      error: "conflict",
      message: "The recipe, target, or computer changed. Review it again.",
    };
  const parsed = parseHttpRetestRecipe(state.recipe.recipe);
  if (!parsed.success)
    return { success: false, error: "validation", message: parsed.message };
  const credentials = validateRunCredentials(parsed.recipe, credentialInput);
  if (!credentials.success)
    return {
      success: false,
      error: "validation",
      message: credentials.message,
    };

  const started = await startRun({
    userId,
    findingId,
    requestId,
    recipeVersion,
    reviewedSandbox: state.finding.sandbox_preference,
  });
  if (!started.success) return started;
  // A retried request returns the original run; it never executes twice.
  if (started.duplicate) return { success: true, run: started.run };
  const run = started.run;
  const recipe = parseHttpRetestRecipe(run.recipe);
  const startedAt = Date.now();

  let classification: HttpRetestClassification;
  let steps: HttpRetestStep[] = [];
  let environment: Environment | undefined;
  let sandbox: AnySandbox | null = null;
  try {
    if (!recipe.success) {
      classification = { outcome: "error", reason: "runner_failed" };
    } else {
      const preference = started.sandbox_preference;
      try {
        const manager = new HybridSandboxManager(
          userId,
          () => {},
          preference,
          serviceKey(),
          null,
          subscription,
          undefined,
          undefined,
          requestId,
          state.finding.chat_id,
          {
            subscription,
            chatId: state.finding.chat_id,
            signal: AbortSignal.timeout(HTTP_RETEST_ACQUISITION_TIMEOUT_MS),
          },
        );
        // Never fall back from the selected computer to another environment.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const acquired = getSandboxWithFallbackGuard({
          sandboxManager: manager,
          requireLocalSandbox: preference !== "e2b",
        });
        try {
          sandbox = await Promise.race([
            acquired.then((result) => result.sandbox),
            new Promise<null>((resolve) => {
              timer = setTimeout(
                () => resolve(null),
                HTTP_RETEST_ACQUISITION_TIMEOUT_MS,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (!sandbox) {
          // A late local relay must still be released.
          void acquired.then(
            async ({ sandbox: late }) => {
              if (isCentrifugoSandbox(late))
                await late.close().catch(() => undefined);
            },
            () => undefined,
          );
        }
      } catch {
        sandbox = null;
      }
      if (!sandbox) {
        classification = { outcome: "error", reason: "sandbox_unavailable" };
      } else {
        environment = environmentFor(sandbox);
        const result = await runHttpRetestInSandbox({
          sandbox,
          recipe: recipe.recipe,
          credentials: credentials.credentials,
        });
        if (result.kind === "failed") {
          classification =
            result.reason === "runtime_unavailable"
              ? { outcome: "skipped", reason: "runtime_unavailable" }
              : { outcome: "error", reason: result.reason };
        } else {
          steps = result.output.steps;
          classification = classifyHttpRetest(recipe.recipe, result.output);
        }
      }
    }
  } catch {
    classification = { outcome: "error", reason: "runner_failed" };
  } finally {
    // Close only this request's relay to a local computer; never stop a
    // shared cloud workspace.
    if (sandbox && isCentrifugoSandbox(sandbox))
      await sandbox.close().catch(() => undefined);
  }

  const evidenceSha256 = httpRetestEvidenceSha256({
    finding_id: findingId,
    run_id: run.run_id,
    request_id: requestId,
    recipe_version: run.recipe_version,
    recipe: run.recipe,
    started_at: run.started_at,
    outcome: classification.outcome,
    reason: classification.reason,
    steps,
    environment,
  });
  const finished = await getConvexClient().mutation(
    api.findingRetests.finishRunForBackend,
    {
      serviceKey: serviceKey(),
      userId,
      runId: run.run_id,
      requestId,
      outcome: classification.outcome,
      reason: classification.reason,
      steps,
      ...(environment && { environment }),
      evidenceSha256,
    },
  );

  try {
    phLogger.event("finding_http_retest_finished", {
      userId,
      outcome: classification.outcome,
      reason: classification.reason,
      duration_ms: Date.now() - startedAt,
      step_count: steps.length,
      baseline_count: recipe.success ? recipe.recipe.baselines.length : 0,
      environment_kind: environment?.kind ?? "unavailable",
      finalized: finished.success,
    });
  } catch {
    // Analytics must not change the recorded result.
  }

  if (finished.success) return { success: true, run: finished.run };
  // A fenced (late or interrupted) result: report the stored state.
  const latest = await getHttpRetestState({ userId, findingId });
  const stored = latest.available
    ? latest.runs.find((candidate) => candidate.run_id === run.run_id)
    : undefined;
  return stored
    ? { success: true, run: stored }
    : {
        success: false,
        error: "not_found",
        message: "This finding is not available.",
      };
}
