import { v } from "convex/values";

// Storage shapes for executable HTTP retests. Semantic validation (origins,
// paths, header policy, credential references) lives in
// lib/findings/http-retest.ts and runs before every write.

const identityPredicate = v.object({
  status: v.number(),
  json: v.array(
    v.object({
      json_path: v.string(),
      equals: v.union(v.string(), v.number(), v.boolean(), v.null()),
    }),
  ),
  body_contains: v.array(v.string()),
});

const requestFields = {
  label: v.string(),
  method: v.literal("GET"),
  path: v.string(),
  credential: v.union(v.string(), v.null()),
  headers: v.array(v.object({ name: v.string(), value: v.string() })),
};

export const httpRetestRecipeValidator = v.object({
  version: v.literal(1),
  title: v.string(),
  origin: v.string(),
  timeout_ms: v.number(),
  credentials: v.array(
    v.object({
      name: v.string(),
      label: v.string(),
      placement: v.union(
        v.literal("bearer"),
        v.literal("header"),
        v.literal("cookie"),
      ),
      header_name: v.optional(v.string()),
    }),
  ),
  baselines: v.array(v.object({ ...requestFields, expect: identityPredicate })),
  probe: v.object({
    ...requestFields,
    vulnerable: identityPredicate,
    not_reproduced: v.object({ statuses: v.array(v.number()) }),
  }),
});

export const httpRetestOutcomeValidator = v.union(
  v.literal("reproduced"),
  v.literal("not_reproduced"),
  v.literal("skipped"),
  v.literal("error"),
);

export const httpRetestReasonValidator = v.union(
  v.literal("vulnerable_predicate_matched"),
  v.literal("nonreproduction_predicate_matched"),
  v.literal("auth_rejected"),
  v.literal("baseline_mismatch"),
  v.literal("unexpected_response"),
  v.literal("redirect_refused"),
  v.literal("response_too_large"),
  v.literal("runtime_unavailable"),
  v.literal("sandbox_unavailable"),
  v.literal("target_unreachable"),
  v.literal("timeout"),
  v.literal("tls_error"),
  v.literal("runner_failed"),
  v.literal("interrupted"),
);

export const httpRetestStepValidator = v.object({
  kind: v.union(v.literal("baseline"), v.literal("probe")),
  index: v.number(),
  status: v.union(v.number(), v.null()),
  bytes: v.union(v.number(), v.null()),
  body_sha256: v.union(v.string(), v.null()),
  duration_ms: v.number(),
  error: v.union(
    v.literal("none"),
    v.literal("timeout"),
    v.literal("connection"),
    v.literal("tls"),
    v.literal("redirect"),
    v.literal("oversized"),
    v.literal("invalid_response"),
  ),
  matched: v.boolean(),
  checks: v.array(v.boolean()),
  nonreproduction_matched: v.optional(v.boolean()),
});

export const httpRetestEnvironmentValidator = v.object({
  kind: v.union(v.literal("cloud"), v.literal("local"), v.literal("desktop")),
  name: v.optional(v.string()),
});

export const httpRetestRunViewValidator = v.object({
  run_id: v.string(),
  request_id: v.string(),
  status: v.union(v.literal("running"), v.literal("finished")),
  recipe_version: v.number(),
  recipe: httpRetestRecipeValidator,
  started_at: v.number(),
  finished_at: v.optional(v.number()),
  outcome: v.optional(httpRetestOutcomeValidator),
  reason: v.optional(httpRetestReasonValidator),
  steps: v.optional(v.array(httpRetestStepValidator)),
  environment: v.optional(httpRetestEnvironmentValidator),
  evidence_sha256: v.optional(v.string()),
});

export const httpRetestRecipeViewValidator = v.object({
  version: v.number(),
  recipe: httpRetestRecipeValidator,
  source: v.union(v.literal("user"), v.literal("agent")),
  created_at: v.number(),
});
