import { NotFoundException } from "@workos-inc/node";
import { workos } from "@/app/api/workos";

const vaultName = (userId: string) => `byok-openrouter-${userId}`;

const isNotFoundError = (error: unknown): boolean =>
  error instanceof NotFoundException;

export async function getByokApiKey(
  userId: string,
): Promise<string | undefined> {
  try {
    const obj = await workos.vault.readObjectByName(vaultName(userId));
    return obj.value;
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

export async function setByokApiKey(
  userId: string,
  apiKey: string,
): Promise<void> {
  const name = vaultName(userId);
  try {
    const existing = await workos.vault.readObjectByName(name);
    await workos.vault.updateObject({ id: existing.id, value: apiKey });
  } catch (error) {
    if (isNotFoundError(error)) {
      await workos.vault.createObject({
        name,
        value: apiKey,
        context: { userId },
      });
      return;
    }
    throw error;
  }
}

export async function clearByokApiKey(userId: string): Promise<void> {
  try {
    const existing = await workos.vault.readObjectByName(vaultName(userId));
    await workos.vault.deleteObject({ id: existing.id });
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
}

export async function hasByokApiKey(userId: string): Promise<boolean> {
  return !!(await getByokApiKey(userId));
}
