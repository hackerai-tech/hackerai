import { WorkOS } from "@workos-inc/node";

let workosClient: WorkOS | null = null;

export function getWorkOS(): WorkOS {
  if (workosClient) return workosClient;

  const apiKey = process.env.WORKOS_API_KEY;
  const clientId = process.env.WORKOS_CLIENT_ID;
  if (!apiKey || !clientId) {
    throw new Error("WORKOS_API_KEY and WORKOS_CLIENT_ID must be configured");
  }

  workosClient = new WorkOS(apiKey, { clientId });
  return workosClient;
}

export const workos = new Proxy({} as WorkOS, {
  get(_target, prop) {
    const client = getWorkOS();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
