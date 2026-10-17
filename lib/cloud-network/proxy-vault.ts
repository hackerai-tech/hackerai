import { WorkOS } from "@workos-inc/node";
import { z } from "zod";
import {
  normalizeProxyInput,
  type ProxyInput,
  type ProxySettings,
  type ProxySecret,
} from "./proxy";

// A stable context avoids creating one KEK per user/rotation (Vault has a finite
// KEK allowance). Ownership is enforced by server-derived names and the payload,
// not by Vault key context, which is an encryption selector rather than ACLs.
const context = { purpose: "hackerai-cloud-proxy" };
const nameFor = (userId: string) => `hackerai-cloud-proxy:${userId}`;
const payloadSchema = z
  .object({
    userId: z.string(),
    revision: z.string(),
    proxy: z
      .object({
        address: z.string(),
        username: z.string().optional(),
        password: z.string().optional(),
      })
      .strict(),
  })
  .strict();
let client: WorkOS | undefined;
function vault() {
  if (!client) {
    if (!process.env.WORKOS_API_KEY || !process.env.WORKOS_CLIENT_ID)
      throw new Error("Cloud proxy secret storage is unavailable.");
    client = new WorkOS(process.env.WORKOS_API_KEY, {
      clientId: process.env.WORKOS_CLIENT_ID,
      timeout: 10_000,
      maxRetries: 0,
    });
  }
  return client.vault;
}
async function read(userId: string) {
  try {
    const object = await vault().readObjectByName({ name: nameFor(userId) });
    const payload = payloadSchema.parse(JSON.parse(object.value ?? ""));
    if (
      object.name !== nameFor(userId) ||
      payload.userId !== userId ||
      object.metadata.context.purpose !== context.purpose
    )
      throw new Error("Ownership mismatch");
    return { object, payload };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 404
    )
      return null;
    throw new Error(
      "Cloud proxy credentials could not be read. Retry or replace them in Settings.",
    );
  }
}
export async function readProxySecret(
  userId: string,
  settings: ProxySettings,
): Promise<ProxySecret> {
  const saved = await read(userId);
  if (
    !saved ||
    saved.payload.revision !== settings.revision ||
    saved.payload.proxy.address !== settings.address ||
    Boolean(saved.payload.proxy.username) !== settings.authenticated
  )
    throw new Error(
      "Cloud proxy credentials need to be saved again in Settings.",
    );
  const proxy = saved.payload.proxy;
  normalizeProxyInput({
    address: proxy.address,
    credentials: proxy.username
      ? { username: proxy.username, password: proxy.password ?? "" }
      : null,
  });
  return proxy;
}
export async function writeProxySecret(
  userId: string,
  settings: ProxySettings,
  input: ProxyInput,
  previous?: ProxySettings | null,
) {
  try {
    const saved = await read(userId);
    let auth = input.credentials;
    if (auth === undefined && previous?.authenticated) {
      if (
        !saved ||
        saved.payload.revision !== previous.revision ||
        previous.address !== input.address
      )
        throw new Error("Credentials must be replaced");
      auth = {
        username: saved.payload.proxy.username!,
        password: saved.payload.proxy.password ?? "",
      };
    }
    const proxy: ProxySecret = {
      address: input.address,
      ...(auth ? auth : {}),
    };
    normalizeProxyInput({ address: proxy.address, credentials: auth ?? null });
    const value = JSON.stringify({
      userId,
      revision: settings.revision,
      proxy,
    });
    if (saved) {
      if (!saved.object.metadata.versionId) throw new Error("Missing version");
      await vault().updateObject({
        id: saved.object.id,
        value,
        versionCheck: saved.object.metadata.versionId,
      });
    } else {
      await vault().createObject({ name: nameFor(userId), value, context });
    }
    // Read back without returning the plaintext to UI or job payloads.
    return await readProxySecret(userId, settings);
  } catch {
    throw new Error(
      "Cloud proxy credentials could not be saved. Retry with the credentials in Settings.",
    );
  }
}
export async function deleteProxySecret(userId: string) {
  try {
    const saved = await read(userId);
    if (!saved) return;
    if (!saved.object.metadata.versionId) throw new Error("Missing version");
    await vault().deleteObject({
      id: saved.object.id,
      versionCheck: saved.object.metadata.versionId,
    });
  } catch {
    throw new Error(
      "Cloud proxy credentials could not be removed. Retry shortly.",
    );
  }
}
