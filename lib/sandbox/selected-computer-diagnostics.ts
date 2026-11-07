import { ChatSDKError } from "@/lib/errors";

export type SelectedComputerLookup = {
  requestedKind: ReturnType<typeof selectedComputerPreferenceKind>;
  resolvedKind: ReturnType<typeof selectedComputerPreferenceKind>;
  registryMatch: boolean;
  quarantinedMatch: boolean;
  staleMatch: boolean;
  otherAvailable: boolean;
  presence: "not_checked" | "reliable" | "unavailable";
};

export function selectedComputerPreferenceKind(preference: string) {
  if (preference === "desktop") return "desktop_alias" as const;
  if (preference.startsWith("desktop-environment:"))
    return "desktop_environment" as const;
  if (preference.startsWith("environment:"))
    return "remote_environment" as const;
  return "legacy_session" as const;
}

// Server-only evidence stays attached to this exact failure. It is never added
// to ChatSDKError.metadata, which is serialized to the user's message stream.
const diagnostics = new WeakMap<object, ReturnType<typeof diagnosticFields>>();

function diagnosticFields(
  lookup: SelectedComputerLookup | undefined,
  phase: "prompt_context" | "acquisition",
) {
  return {
    selected_computer_diagnostic_version: 1,
    selected_computer_failure_phase: phase,
    selected_computer_requested_kind: lookup?.requestedKind ?? "unavailable",
    selected_computer_resolved_kind: lookup?.resolvedKind ?? "unavailable",
    selected_computer_registry_match: lookup?.registryMatch ?? null,
    selected_computer_quarantined_match: lookup?.quarantinedMatch ?? null,
    selected_computer_stale_match: lookup?.staleMatch ?? null,
    selected_computer_other_available: lookup?.otherAvailable ?? null,
    selected_computer_presence: lookup?.presence ?? "unavailable",
  };
}

export function selectedComputerOfflineError(
  lookup: SelectedComputerLookup | undefined,
  phase: "prompt_context" | "acquisition",
) {
  const error = new ChatSDKError(
    "offline:sandbox",
    "The selected computer is disconnected. Reconnect that computer to continue this task.",
  );
  diagnostics.set(error, Object.freeze(diagnosticFields(lookup, phase)));
  return error;
}

export function selectedComputerFailureDiagnostics(error: unknown) {
  return typeof error === "object" && error !== null
    ? diagnostics.get(error)
    : undefined;
}
