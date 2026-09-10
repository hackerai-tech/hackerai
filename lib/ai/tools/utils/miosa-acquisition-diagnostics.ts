import { createHash } from "node:crypto";

export type MiosaAcquisitionStage =
  | "client_init"
  | "lookup_existing"
  | "enrollment"
  | "get_or_create"
  | "readiness"
  | "initialize_runtime";

export type MiosaAcquisitionDiagnostic = {
  stage: MiosaAcquisitionStage;
  outcome: "success" | "not_found" | "failure";
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
]);

type MiosaErrorDiagnostic = {
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
  onDiagnostic?: (diagnostic: MiosaAcquisitionDiagnostic) => void;
}) {
  const startedAt = performance.now();
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
        options.onDiagnostic?.({
          ...common,
          stage,
          runtime,
          outcome,
          stage_duration_ms: Math.round(performance.now() - stageStartedAt),
          acquisition_duration_ms: Math.round(performance.now() - startedAt),
          ...(error === undefined ? {} : miosaErrorDiagnostics(error)),
        });
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
          : "failure",
        error,
      );
      throw error;
    }
  };
}
