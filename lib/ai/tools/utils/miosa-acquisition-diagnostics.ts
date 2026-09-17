import { createHash, randomUUID } from "node:crypto";

export type MiosaAcquisitionStage =
  | "client_init"
  | "lookup_existing"
  | "enrollment"
  | "get_or_create"
  | "resume_conflict_refresh"
  | "acquisition_reconciliation"
  | "readiness"
  | "initialize_runtime";

export type MiosaAcquisitionDiagnostic = {
  acquisition_id: string;
  sandbox_id?: string;
  sandbox_state?: string;
  provider_operation_id?: string;
  provider_request_id?: string;
  expected_sandbox_id?: string;
  recovery_trigger_code?: string;
  recovery_trigger_request_id?: string;
  stage: MiosaAcquisitionStage;
  outcome: "success" | "not_found" | "denied" | "failure";
  stage_duration_ms: number;
  acquisition_duration_ms: number;
  requested_template: "hackerai-tools" | "miosa-sandbox-docker" | "custom";
  template_fingerprint: string;
  api_target: "default" | "custom";
  workspace_fingerprint: string;
  runtime?: "native" | "docker";
} & ReturnType<typeof miosaErrorDiagnostics>;

const miosaDiagnosticFingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const failures = new WeakMap<object, MiosaAcquisitionDiagnostic>();
export function miosaAcquisitionFailureDiagnostics(error: unknown) {
  const diagnostic =
    error && typeof error === "object" ? failures.get(error) : undefined;
  return diagnostic
    ? {
        acquisition_id: diagnostic.acquisition_id,
        miosa_failure_stage: diagnostic.stage,
        sandbox_id: diagnostic.sandbox_id,
        sandbox_state: diagnostic.sandbox_state,
        provider_operation_id: diagnostic.provider_operation_id,
        provider_request_id: diagnostic.provider_request_id,
        ...(diagnostic.expected_sandbox_id && {
          expected_sandbox_id: diagnostic.expected_sandbox_id,
        }),
        ...(diagnostic.recovery_trigger_code && {
          recovery_trigger_code: diagnostic.recovery_trigger_code,
        }),
        ...(diagnostic.recovery_trigger_request_id && {
          recovery_trigger_request_id: diagnostic.recovery_trigger_request_id,
        }),
      }
    : {};
}

// Never serialize an SDK Error: message/details/cause/stack can include bodies,
// authorization headers, initialization stderr, or files. Request IDs let the
// provider recover the exact server-side message without collecting that data.
function safeToken(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== "string" || value.length > 128 || !pattern.test(value))
    return undefined;
  if (/^(msk_|sk_|phc_|phx_|eyJ)/i.test(value)) return undefined;
  if (
    Object.entries(process.env).some(
      ([name, secret]) =>
        /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) &&
        secret &&
        secret.length >= 4 &&
        value.includes(secret),
    )
  )
    return undefined;
  return value;
}

const VALIDATION_FIELDS = new Set([
  "name",
  "template_id",
  "size",
  "cpu_count",
  "memory_mb",
  "disk_mb",
  "disk_size_mb",
  "persistent",
  "timeout_sec",
  "idle_timeout_sec",
  "snapshot_expiration_sec",
  "keep_last_snapshots",
  "external_workspace_id",
  "external_user_id",
  "workspace_id",
  "project_id",
  "region",
  "metadata",
  "command",
  "cwd",
  "envs",
  "path",
  "content",
]);

type MiosaErrorDiagnostic = {
  sandbox_id?: string;
  sandbox_state?: string;
  error_name?: string;
  error_code?: string;
  error_http_status?: number;
  error_request_id?: string;
  error_retryable?: boolean;
  validation_fields?: string[];
};

export function miosaErrorDiagnostics(error: unknown): MiosaErrorDiagnostic {
  try {
    return readMiosaErrorDiagnostics(error);
  } catch {
    return { error_name: "UnknownError" };
  }
}

function readMiosaErrorDiagnostics(error: unknown): MiosaErrorDiagnostic {
  if (!error || typeof error !== "object")
    return { error_name: "UnknownError" };
  const e = error as Record<string, unknown>;
  const sandboxId = safeToken(e.sandboxId, /^[A-Za-z0-9][A-Za-z0-9_-]*$/);
  const sandboxState = [
    "provisioning",
    "running",
    "pausing",
    "paused",
    "resuming",
    "stopped",
    "destroying",
    "destroyed",
    "error",
  ].includes(String(e.sandboxState))
    ? String(e.sandboxState)
    : undefined;
  // Inspect only known validation paths, never their rejected input or messages.
  const details = e.details;
  const issues = Array.isArray(details)
    ? details
    : details && typeof details === "object"
      ? ((details as Record<string, unknown>).errors ??
        (details as Record<string, unknown>).issues)
      : undefined;
  const fields = new Set<string>();
  if (Array.isArray(issues)) {
    for (const issue of issues.slice(0, 50)) {
      if (!issue || typeof issue !== "object") continue;
      const path = issue.path ?? issue.loc ?? issue.field;
      for (const part of Array.isArray(path) ? path.slice(0, 10) : [path]) {
        if (typeof part === "string" && VALIDATION_FIELDS.has(part))
          fields.add(part);
      }
    }
  }
  return {
    ...(sandboxId && { sandbox_id: sandboxId }),
    ...(sandboxState && { sandbox_state: sandboxState }),
    error_name:
      safeToken(e.name, /^(?:Error|[A-Za-z][A-Za-z0-9]*Error)$/) ??
      "UnknownError",
    error_code: safeToken(e.code, /^[A-Z][A-Z0-9_]{0,79}$/),
    error_http_status:
      typeof e.status === "number" &&
      Number.isInteger(e.status) &&
      e.status >= 400 &&
      e.status <= 599
        ? e.status
        : undefined,
    error_request_id: safeToken(e.requestId, /^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    error_retryable: typeof e.retryable === "boolean" ? e.retryable : undefined,
    validation_fields: fields.size ? [...fields].sort() : undefined,
  };
}

export function createMiosaAcquisitionDiagnostics(options: {
  templateId: string;
  workspaceName: string;
  acquisitionId?: string;
  getExpectedId?: () => string | undefined;
  getRecoveryTrigger?: () => unknown;
  getSandbox?: () =>
    | {
        id: string;
        state: string;
        data: { operation_id?: string | null; request_id?: string | null };
      }
    | undefined;
  onDiagnostic?: (diagnostic: MiosaAcquisitionDiagnostic) => void;
}) {
  const startedAt = performance.now();
  const acquisitionId =
    safeToken(options.acquisitionId, /^[A-Za-z0-9][A-Za-z0-9_-]*$/) ??
    randomUUID();
  const common: Pick<
    MiosaAcquisitionDiagnostic,
    | "requested_template"
    | "template_fingerprint"
    | "workspace_fingerprint"
    | "api_target"
  > = {
    requested_template:
      options.templateId === "hackerai-tools" ||
      options.templateId === "miosa-sandbox-docker"
        ? options.templateId
        : ("custom" as const),
    template_fingerprint: miosaDiagnosticFingerprint(options.templateId),
    workspace_fingerprint: miosaDiagnosticFingerprint(options.workspaceName),
    api_target: process.env.MIOSA_BASE_URL
      ? ("custom" as const)
      : ("default" as const),
  };
  return async <T>(
    stage: MiosaAcquisitionStage,
    operation: () => Promise<T>,
    runtime?: "native" | "docker",
  ): Promise<T> => {
    const stageStartedAt = performance.now();
    const emit = (
      outcome: MiosaAcquisitionDiagnostic["outcome"],
      error?: unknown,
    ) => {
      try {
        const sandbox = options.getSandbox?.();
        const trigger = miosaErrorDiagnostics(options.getRecoveryTrigger?.());
        const diagnostic: MiosaAcquisitionDiagnostic = {
          ...common,
          acquisition_id: acquisitionId,
          expected_sandbox_id: safeToken(
            options.getExpectedId?.(),
            /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
          ),
          recovery_trigger_code: trigger.error_code,
          recovery_trigger_request_id: trigger.error_request_id,
          sandbox_id: safeToken(sandbox?.id, /^[A-Za-z0-9][A-Za-z0-9_-]*$/),
          sandbox_state: [
            "provisioning",
            "running",
            "pausing",
            "paused",
            "resuming",
            "stopped",
            "destroying",
            "destroyed",
            "error",
          ].includes(sandbox?.state ?? "")
            ? sandbox?.state
            : undefined,
          provider_operation_id: safeToken(
            sandbox?.data.operation_id,
            /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
          ),
          provider_request_id: safeToken(
            sandbox?.data.request_id,
            /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
          ),
          stage,
          runtime,
          outcome,
          stage_duration_ms: Math.round(performance.now() - stageStartedAt),
          acquisition_duration_ms: Math.round(performance.now() - startedAt),
          ...(error === undefined ? {} : miosaErrorDiagnostics(error)),
        };
        if (error && typeof error === "object") failures.set(error, diagnostic);
        options.onDiagnostic?.(diagnostic);
      } catch {
        /* Observability must not change enrollment, recovery, or fallback. */
      }
    };
    try {
      const result = await operation();
      emit("success");
      return result;
    } catch (error) {
      emit(
        stage === "lookup_existing" &&
          error instanceof Error &&
          error.name === "NotFoundError"
          ? "not_found"
          : stage === "enrollment" &&
              error instanceof Error &&
              error.name === "MiosaEnrollmentError" &&
              "reason" in error &&
              (error.reason === "not_pro" ||
                error.reason === "existing_e2b_workspace")
            ? "denied"
            : "failure",
        error,
      );
      throw error;
    }
  };
}
