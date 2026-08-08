import type { WorkOS } from "@workos-inc/node";

const PROXY_CONFIG_OBJECT_PREFIX = "hackerai-agent-proxy";

type WorkOSWithVault = Pick<WorkOS, "vault">;

export function getProxyConfigVaultObjectName(userId: string): string {
  return `${PROXY_CONFIG_OBJECT_PREFIX}:${userId}`;
}

export function isMissingVaultObjectError(error: unknown): boolean {
  return error instanceof Error && error.name === "NotFoundException";
}

export async function readProxyConfigVaultObject(
  workos: WorkOSWithVault,
  userId: string,
) {
  try {
    return await workos.vault.readObjectByName(
      getProxyConfigVaultObjectName(userId),
    );
  } catch (error) {
    if (isMissingVaultObjectError(error)) return null;
    throw error;
  }
}

export async function deleteProxyConfigVaultObject(
  workos: WorkOSWithVault,
  userId: string,
): Promise<boolean> {
  const existing = await readProxyConfigVaultObject(workos, userId);
  if (!existing) return false;

  await workos.vault.deleteObject({
    id: existing.id,
    ...(existing.metadata.versionId
      ? { versionCheck: existing.metadata.versionId }
      : {}),
  });
  return true;
}
