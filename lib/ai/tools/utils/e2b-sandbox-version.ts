// Template tags describe the image used for NEW workspaces. A generation change
// never authorizes replacing an existing workspace or rewriting its metadata.
export const CURRENT_E2B_SANDBOX_VERSION = "v13";

export const isRecoverableE2BSandboxVersion = (
  version: unknown,
): version is "v12" | "v13" => version === "v12" || version === "v13";

// Keep the version discovered during acquisition on the exact SDK client. This
// also makes prompt selection synchronous, without booting a sandbox for a prompt.
const versions = new WeakMap<object, string>();

export function rememberE2BSandboxVersion(
  sandbox: object,
  version: string | undefined,
): void {
  if (version) versions.set(sandbox, version);
  else versions.delete(sandbox);
}

export function getE2BSandboxVersion(
  sandbox: object | null,
): string | undefined {
  return sandbox ? versions.get(sandbox) : undefined;
}
