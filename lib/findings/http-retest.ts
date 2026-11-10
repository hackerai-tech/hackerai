import { z } from "zod";

/**
 * Executable HTTP retests replay a small, typed recipe from the source task's
 * selected computer. The recipe never contains credentials: requests name a
 * runtime credential binding whose value exists only during one run.
 */
export const HTTP_RETEST_RECIPE_VERSION = 1 as const;

export const HTTP_RETEST_LIMITS = {
  maxCredentials: 4,
  maxBaselines: 4,
  maxLiteralHeaders: 4,
  maxIdentityChecks: 4,
  maxBodyContains: 2,
  minRequestTimeoutMs: 1_000,
  maxRequestTimeoutMs: 10_000,
  defaultRequestTimeoutMs: 8_000,
  /** Whole-run budget enforced by the runner, independent of step timeouts. */
  runDeadlineMs: 30_000,
  maxResponseBytes: 1_048_576,
  maxCredentialValueLength: 8_192,
  maxPathLength: 1_024,
} as const;

export const HTTP_RETEST_OUTCOMES = [
  "reproduced",
  "not_reproduced",
  "skipped",
  "error",
] as const;
export type HttpRetestOutcome = (typeof HTTP_RETEST_OUTCOMES)[number];

export const HTTP_RETEST_REASONS = [
  "vulnerable_predicate_matched",
  "nonreproduction_predicate_matched",
  "auth_rejected",
  "baseline_mismatch",
  "unexpected_response",
  "redirect_refused",
  "response_too_large",
  "runtime_unavailable",
  "sandbox_unavailable",
  "target_unreachable",
  "timeout",
  "tls_error",
  "runner_failed",
  "interrupted",
] as const;
export type HttpRetestReason = (typeof HTTP_RETEST_REASONS)[number];

export const HTTP_RETEST_STEP_ERRORS = [
  "none",
  "timeout",
  "connection",
  "tls",
  "redirect",
  "oversized",
  "invalid_response",
] as const;
export type HttpRetestStepError = (typeof HTTP_RETEST_STEP_ERRORS)[number];

/** Probe statuses that may count as "access denied this time". 401 is never
 * a non-reproduction: an expired or wrong credential proves nothing. */
export const NONREPRODUCTION_STATUSES = [400, 403, 404, 405, 410, 422] as const;

/** Header names that could re-route, smuggle or impersonate a request. */
const HOSTILE_HEADER =
  /^(host|forwarded|via|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|content-length|content-encoding|expect|x-forwarded-.*|x-real-ip|x-original-.*|x-rewrite-url|x-host|x-http-method(-override)?|x-method-override|x-client-ip|true-client-ip|cf-connecting-ip)$/i;

/** Literal (non-secret) headers a recipe may set. */
export const LITERAL_HEADER_NAMES = [
  "Accept",
  "Accept-Language",
  "X-Requested-With",
] as const;

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const HEADER_TOKEN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const CREDENTIAL_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const JSON_PATH = /^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}){0,7}$/;

const label = (max: number) => z.string().trim().min(1).max(max);

/** Exact HTTP(S) origin such as `https://app.example.test:8443`. */
export const httpRetestOriginSchema = z
  .string()
  .trim()
  .max(255)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Enter an origin like https://app.example.com",
      });
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      ctx.addIssue({ code: "custom", message: "Use an http or https origin" });
    else if (url.username || url.password)
      ctx.addIssue({
        code: "custom",
        message: "Remove credentials from the origin",
      });
    else if (url.origin !== value)
      ctx.addIssue({
        code: "custom",
        message:
          "Use only the scheme, host and port, with no path, query or fragment",
      });
  });

/** A report may include a description after its explicit HTTP target URL. */
export function httpRetestFindingOrigin(target: string): string | null {
  const address = target.trim().split(/\s+/, 1)[0];
  if (!/^https?:\/\//i.test(address)) return null;
  try {
    const url = new URL(address);
    return url.username || url.password ? null : url.origin;
  } catch {
    return null;
  }
}

/** Same-origin absolute path with an optional query. Never a full URL. */
export const httpRetestPathSchema = z
  .string()
  .max(HTTP_RETEST_LIMITS.maxPathLength)
  .superRefine((value, ctx) => {
    if (
      !value.startsWith("/") ||
      value.startsWith("//") ||
      value.includes("#") ||
      value.includes("\\") ||
      !/^[\x21-\x7e]+$/.test(value)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Paths start with / and contain no spaces, fragments, backslashes or another host",
      });
      return;
    }
    const base = "http://retest.invalid";
    if (new URL(value, base).origin !== base)
      ctx.addIssue({
        code: "custom",
        message: "Paths must stay on the recipe origin",
      });
  });

const credentialSchema = z
  .object({
    name: z
      .string()
      .regex(CREDENTIAL_NAME, "Use lowercase letters, digits and _"),
    label: label(80),
    placement: z.enum(["bearer", "header", "cookie"]),
    header_name: z.string().regex(HEADER_TOKEN).optional(),
  })
  .strict()
  .superRefine((credential, ctx) => {
    if (credential.placement === "header") {
      if (!credential.header_name)
        ctx.addIssue({
          code: "custom",
          message: "Name the header that carries this credential",
        });
      else if (
        HOSTILE_HEADER.test(credential.header_name) ||
        /^(authorization|cookie)$/i.test(credential.header_name)
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Use the bearer or cookie placement, or a custom API key header",
        });
    } else if (credential.header_name !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Only header credentials name a header",
      });
    }
  });

const literalHeaderSchema = z
  .object({
    name: z.enum(LITERAL_HEADER_NAMES),
    value: z
      .string()
      .max(200)
      .regex(PRINTABLE_ASCII, "Use printable characters"),
  })
  .strict();

const identityCheckSchema = z
  .object({
    json_path: z
      .string()
      .regex(JSON_PATH, "Use a dotted field path like data.owner_id"),
    equals: z.union([z.string().max(200), z.number(), z.boolean(), z.null()]),
  })
  .strict();

const bodyContainsSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(PRINTABLE_ASCII, "Use printable characters");

/** Successful response that proves a specific identity or record. */
const identityPredicateSchema = z
  .object({
    status: z.number().int().min(200).max(299),
    json: z
      .array(identityCheckSchema)
      .max(HTTP_RETEST_LIMITS.maxIdentityChecks)
      .default([]),
    body_contains: z
      .array(bodyContainsSchema)
      .max(HTTP_RETEST_LIMITS.maxBodyContains)
      .default([]),
  })
  .strict()
  .refine((p) => p.json.length + p.body_contains.length > 0, {
    message: "Add at least one field or text check that identifies the record",
  });

const requestSchema = z
  .object({
    label: label(80),
    method: z.literal("GET"),
    path: httpRetestPathSchema,
    credential: z.string().regex(CREDENTIAL_NAME).nullable(),
    headers: z
      .array(literalHeaderSchema)
      .max(HTTP_RETEST_LIMITS.maxLiteralHeaders)
      .default([]),
  })
  .strict();

const baselineSchema = requestSchema
  .extend({ expect: identityPredicateSchema })
  .strict();

const probeSchema = requestSchema
  .extend({
    vulnerable: identityPredicateSchema,
    not_reproduced: z
      .object({
        statuses: z
          .array(
            z
              .number()
              .int()
              .refine(
                (status) =>
                  (NONREPRODUCTION_STATUSES as readonly number[]).includes(
                    status,
                  ),
                "Use 400, 403, 404, 405, 410 or 422. A 401 means the token was rejected",
              ),
          )
          .min(1)
          .max(NONREPRODUCTION_STATUSES.length),
      })
      .strict(),
  })
  .strict();

export const httpRetestRecipeSchema = z
  .object({
    version: z.literal(HTTP_RETEST_RECIPE_VERSION),
    title: label(120),
    origin: httpRetestOriginSchema,
    timeout_ms: z
      .number()
      .int()
      .min(HTTP_RETEST_LIMITS.minRequestTimeoutMs)
      .max(HTTP_RETEST_LIMITS.maxRequestTimeoutMs)
      .default(HTTP_RETEST_LIMITS.defaultRequestTimeoutMs),
    credentials: z
      .array(credentialSchema)
      .max(HTTP_RETEST_LIMITS.maxCredentials)
      .default([]),
    baselines: z
      .array(baselineSchema)
      .min(1)
      .max(HTTP_RETEST_LIMITS.maxBaselines),
    probe: probeSchema,
  })
  .strict()
  .superRefine((recipe, ctx) => {
    const names = recipe.credentials.map((c) => c.name);
    if (new Set(names).size !== names.length)
      ctx.addIssue({
        code: "custom",
        path: ["credentials"],
        message: "Credential names must be unique",
      });
    const used = new Set<string>();
    const requests = [
      ...recipe.baselines.map((r, i) => ({
        r,
        path: ["baselines", i, "credential"],
      })),
      { r: recipe.probe, path: ["probe", "credential"] },
    ];
    for (const { r, path } of requests) {
      if (r.credential === null) continue;
      used.add(r.credential);
      if (!names.includes(r.credential))
        ctx.addIssue({
          code: "custom",
          path,
          message: "Choose a credential defined in this recipe",
        });
    }
    for (const [index, name] of names.entries())
      if (!used.has(name))
        ctx.addIssue({
          code: "custom",
          path: ["credentials", index, "name"],
          message: "Remove credentials that no request uses",
        });
    if (
      new Set(recipe.probe.not_reproduced.statuses).size !==
      recipe.probe.not_reproduced.statuses.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["probe", "not_reproduced"],
        message: "List each denied status once",
      });
    if (
      recipe.probe.not_reproduced.statuses.includes(
        recipe.probe.vulnerable.status,
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["probe", "not_reproduced"],
        message: "The vulnerable status cannot also count as not reproduced",
      });
  });

export type HttpRetestRecipe = z.infer<typeof httpRetestRecipeSchema>;
export type HttpRetestRecipeInput = z.input<typeof httpRetestRecipeSchema>;
export type HttpRetestCredentialBinding =
  HttpRetestRecipe["credentials"][number];

export function parseHttpRetestRecipe(
  value: unknown,
):
  | { success: true; recipe: HttpRetestRecipe }
  | { success: false; message: string } {
  const parsed = httpRetestRecipeSchema.safeParse(value);
  if (parsed.success) return { success: true, recipe: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return {
    success: false,
    message: `${where}${issue?.message ?? "Invalid recipe"}`.slice(0, 300),
  };
}

/** Credential values supplied for one run. Never persisted. */
export const httpRetestCredentialValuesSchema = z.record(
  z.string().regex(CREDENTIAL_NAME),
  z
    .string()
    .min(1)
    .max(HTTP_RETEST_LIMITS.maxCredentialValueLength)
    .regex(PRINTABLE_ASCII, "Credentials must be printable text on one line"),
);

/** Observation the runner may report: no bodies, headers or messages. */
export const httpRetestStepSchema = z
  .object({
    kind: z.enum(["baseline", "probe"]),
    index: z.number().int().min(0).max(HTTP_RETEST_LIMITS.maxBaselines),
    status: z.number().int().min(100).max(599).nullable(),
    bytes: z
      .number()
      .int()
      .min(0)
      .max(HTTP_RETEST_LIMITS.maxResponseBytes + 1)
      .nullable(),
    body_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    duration_ms: z.number().int().min(0).max(120_000),
    error: z.enum(HTTP_RETEST_STEP_ERRORS),
    matched: z.boolean(),
    checks: z
      .array(z.boolean())
      .max(
        HTTP_RETEST_LIMITS.maxIdentityChecks +
          HTTP_RETEST_LIMITS.maxBodyContains,
      ),
    nonreproduction_matched: z.boolean().optional(),
  })
  .strict();
export type HttpRetestStep = z.infer<typeof httpRetestStepSchema>;

export const httpRetestRunnerOutputSchema = z
  .object({
    protocol: z.literal(1),
    steps: z
      .array(httpRetestStepSchema)
      .max(HTTP_RETEST_LIMITS.maxBaselines + 1),
    deadline_exceeded: z.boolean(),
  })
  .strict();
export type HttpRetestRunnerOutput = z.infer<
  typeof httpRetestRunnerOutputSchema
>;

export type HttpRetestClassification = {
  outcome: HttpRetestOutcome;
  reason: HttpRetestReason;
};

const transportReason = (
  error: HttpRetestStepError,
): HttpRetestClassification | null => {
  switch (error) {
    case "none":
      return null;
    case "redirect":
      return { outcome: "skipped", reason: "redirect_refused" };
    case "oversized":
      return { outcome: "skipped", reason: "response_too_large" };
    case "invalid_response":
      return { outcome: "skipped", reason: "unexpected_response" };
    case "timeout":
      return { outcome: "error", reason: "timeout" };
    case "tls":
      return { outcome: "error", reason: "tls_error" };
    case "connection":
      return { outcome: "error", reason: "target_unreachable" };
  }
};

/**
 * Decide a run from controlled observations. Only an explicit vulnerable
 * predicate reproduces and only an explicit denial predicate does not; any
 * other response is skipped or an error, never evidence of a fix.
 */
export function classifyHttpRetest(
  recipe: HttpRetestRecipe,
  output: HttpRetestRunnerOutput,
): HttpRetestClassification {
  if (output.deadline_exceeded) return { outcome: "error", reason: "timeout" };
  if (
    output.steps.some((step, index) =>
      index < recipe.baselines.length
        ? step.kind !== "baseline" || step.index !== index
        : index !== recipe.baselines.length ||
          step.kind !== "probe" ||
          step.index !== 0,
    )
  )
    return { outcome: "error", reason: "runner_failed" };
  const matches = (
    step: HttpRetestStep,
    predicate: HttpRetestRecipe["probe"]["vulnerable"],
  ) =>
    step.matched &&
    step.status === predicate.status &&
    step.checks.length ===
      predicate.json.length + predicate.body_contains.length &&
    step.checks.every(Boolean);
  for (let index = 0; index < recipe.baselines.length; index++) {
    const step = output.steps.find(
      (s) => s.kind === "baseline" && s.index === index,
    );
    if (!step)
      return output.deadline_exceeded
        ? { outcome: "error", reason: "timeout" }
        : { outcome: "error", reason: "runner_failed" };
    const transport = transportReason(step.error);
    if (transport) return transport;
    if (step.status === 401 || step.status === 403)
      return { outcome: "skipped", reason: "auth_rejected" };
    if (!matches(step, recipe.baselines[index].expect))
      return { outcome: "skipped", reason: "baseline_mismatch" };
  }
  const probe = output.steps.find((s) => s.kind === "probe");
  if (!probe)
    return output.deadline_exceeded
      ? { outcome: "error", reason: "timeout" }
      : { outcome: "error", reason: "runner_failed" };
  const transport = transportReason(probe.error);
  if (transport) return transport;
  if (probe.status === 401)
    return { outcome: "skipped", reason: "auth_rejected" };
  if (matches(probe, recipe.probe.vulnerable))
    return { outcome: "reproduced", reason: "vulnerable_predicate_matched" };
  if (
    probe.nonreproduction_matched &&
    probe.status !== null &&
    recipe.probe.not_reproduced.statuses.includes(probe.status)
  )
    return {
      outcome: "not_reproduced",
      reason: "nonreproduction_predicate_matched",
    };
  return { outcome: "skipped", reason: "unexpected_response" };
}

export const HTTP_RETEST_REASON_LABELS: Record<HttpRetestReason, string> = {
  vulnerable_predicate_matched:
    "The probe matched the saved vulnerable condition.",
  nonreproduction_predicate_matched:
    "The probe was denied with an expected status this time.",
  auth_rejected:
    "A request was rejected as unauthenticated. The token may be expired or for the wrong account.",
  baseline_mismatch:
    "A baseline request did not match its expected response, so the probe was not sent.",
  unexpected_response:
    "The response matched neither the vulnerable nor the denied condition.",
  redirect_refused: "The target redirected. Retests never follow redirects.",
  response_too_large: "A response exceeded the 1 MB limit.",
  runtime_unavailable:
    "The source task's computer can't run retests (Python 3 or an updated local client is required).",
  sandbox_unavailable:
    "The source task's computer is unavailable. Reconnect it and try again.",
  target_unreachable:
    "The target could not be reached from the source task's computer.",
  timeout: "The run reached its time limit.",
  tls_error: "The target's TLS certificate could not be verified.",
  runner_failed: "The retest runner failed before reporting a result.",
  interrupted: "The run stopped before it could record a result.",
};
