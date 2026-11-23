import { NoObjectGeneratedError, NoOutputGeneratedError } from "ai";
import { phLogger } from "@/lib/posthog/server";
import { USER_RESEARCH_MODEL_KEY } from "@/lib/research/user-research";

const STRUCTURED_OUTPUT_FAILED_EVENT = "user_research_structured_output_failed";

const DIAGNOSTIC_FLUSH_TIMEOUT_MS = 1_000;
const MAX_REPORTED_TOKENS = 10_000_000;
const MAX_REPORTED_ATTEMPT = 100;
const FINISH_REASONS = new Set([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
]);
const OPENROUTER_GENERATION_ID_PATTERN = /^gen-\d{10}-[A-Za-z0-9]{10,64}$/;
const TRIGGER_RUN_ID_PATTERN = /^run_[a-z0-9]{20,40}$/;
const TRIGGER_DEPLOYMENT_VERSION_PATTERN = /^20\d{6}\.\d{1,6}$/;

export type ResearchStructuredOutputOperation = "profile" | "synthesis";

/** The model's content filter withheld structured output for this request. */
export class ResearchContentFilterError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("The model content filter withheld research output", options);
    this.name = "ResearchContentFilterError";
  }
}

/**
 * True when the model's content filter refused the request. An empty refusal
 * surfaces from readResearchStructuredOutput; a refusal with text fails
 * structured parsing inside generateText as NoObjectGeneratedError.
 */
export const isResearchContentFilterRefusal = (error: unknown): boolean =>
  error instanceof ResearchContentFilterError ||
  (readSafely(() => NoObjectGeneratedError.isInstance(error)) === true &&
    readSafely(() => (error as { finishReason?: unknown }).finishReason) ===
      "content-filter");

/** The subset of Trigger's task context used for run correlation. */
export type ResearchTaskContext = {
  run: { id: string };
  attempt: { number: number };
  deployment?: { version: string };
};

type StructuredOutputResult<OUTPUT> = {
  readonly output: OUTPUT;
  readonly finishReason: unknown;
  readonly usage: unknown;
  readonly response: { readonly id?: unknown };
};

const readSafely = (read: () => unknown): unknown => {
  try {
    return read();
  } catch {
    return undefined;
  }
};

const tokenCount = (value: unknown) =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= MAX_REPORTED_TOKENS
    ? (value as number)
    : undefined;

const matching = (value: unknown, pattern: RegExp) =>
  typeof value === "string" && pattern.exec(value)?.[0] === value
    ? value
    : undefined;

const withDefinedValues = (fields: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );

// Every property is rebuilt from a closed set or a validated scalar. Never
// spread the result, error, response, or provider metadata: they can carry
// prompts, generated text, headers, or response bodies.
function buildDiagnosticFields(
  result: StructuredOutputResult<unknown>,
  operation: ResearchStructuredOutputOperation,
  ctx: ResearchTaskContext,
) {
  const finishReason = readSafely(() => result.finishReason);
  const usage = readSafely(() => result.usage) as
    | {
        inputTokens?: unknown;
        outputTokens?: unknown;
        totalTokens?: unknown;
        outputTokenDetails?: { reasoningTokens?: unknown };
      }
    | undefined;
  const attempt = readSafely(() => ctx.attempt.number);

  return withDefinedValues({
    diagnostic_version: 1,
    operation,
    finish_reason:
      typeof finishReason === "string" && FINISH_REASONS.has(finishReason)
        ? finishReason
        : "unavailable",
    input_tokens: tokenCount(readSafely(() => usage?.inputTokens)),
    output_tokens: tokenCount(readSafely(() => usage?.outputTokens)),
    total_tokens: tokenCount(readSafely(() => usage?.totalTokens)),
    reasoning_tokens: tokenCount(
      readSafely(() => usage?.outputTokenDetails?.reasoningTokens),
    ),
    // The configured routing key, not the provider or model that served the
    // request. OpenRouter's generation record is the source for that.
    configured_model_key: USER_RESEARCH_MODEL_KEY,
    openrouter_generation_id: matching(
      readSafely(() => result.response.id),
      OPENROUTER_GENERATION_ID_PATTERN,
    ),
    trigger_run_id: matching(
      readSafely(() => ctx.run.id),
      TRIGGER_RUN_ID_PATTERN,
    ),
    trigger_attempt_number:
      Number.isSafeInteger(attempt) &&
      (attempt as number) >= 1 &&
      (attempt as number) <= MAX_REPORTED_ATTEMPT
        ? attempt
        : undefined,
    trigger_deployment_version: matching(
      readSafely(() => ctx.deployment?.version),
      TRIGGER_DEPLOYMENT_VERSION_PATTERN,
    ),
  });
}

// Child task processes have no shared flush on exit, so wait briefly for
// delivery. The flush promise is caught up front so a late rejection after the
// timeout is still handled, and the timer is cleared so it cannot hold the
// process open.
async function flushWithinBound() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flushed = Promise.resolve()
    .then(() => phLogger.flush())
    .catch(() => undefined);
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, DIAGNOSTIC_FLUSH_TIMEOUT_MS);
  });
  try {
    await Promise.race([flushed, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads `result.output` and, only when the SDK getter reports that no output was
 * generated, publishes a privacy-safe diagnostic. A content-filter finish is
 * rethrown as ResearchContentFilterError (original as `cause`); every other
 * error is rethrown unchanged.
 */
export async function readResearchStructuredOutput<OUTPUT>(
  result: StructuredOutputResult<OUTPUT>,
  {
    operation,
    ctx,
  }: {
    operation: ResearchStructuredOutputOperation;
    ctx: ResearchTaskContext;
  },
): Promise<OUTPUT> {
  try {
    return result.output;
  } catch (error) {
    // Metadata and even SDK error-marker access are best effort. Never
    // replace the original output failure with a diagnostic exception.
    if (readSafely(() => NoOutputGeneratedError.isInstance(error)) !== true) {
      throw error;
    }
    try {
      // System event: no userId, so no user or cohort identity is attached.
      phLogger.event(
        STRUCTURED_OUTPUT_FAILED_EVENT,
        buildDiagnosticFields(result, operation, ctx),
      );
      await flushWithinBound();
    } catch {
      // Diagnostics are best effort.
    }
    if (readSafely(() => result.finishReason) === "content-filter") {
      throw new ResearchContentFilterError({ cause: error });
    }
    throw error;
  }
}
