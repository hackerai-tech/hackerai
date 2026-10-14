import { ConvexHttpClient } from "convex/browser";
import { convexToJson, jsonToConvex, type Value } from "convex/values";
import { signServiceArgs, type ServiceScope } from "./service-proof";
import { redactSensitiveErrorMessage } from "../utils/error-redaction";

export function createServiceFetch(
  deployment: string,
  transport: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.split("/").pop();
    const type = endpoint === "query_at_ts" ? "query" : endpoint;
    if (!["query", "mutation", "action"].includes(type ?? "")) {
      // Never silently send credentials through a new/unsupported RPC format.
      if (
        typeof init?.body === "string" &&
        init.body.includes('"serviceKey"')
      ) {
        throw new Error("Unsupported service RPC transport");
      }
      return transport(input, init);
    }
    if (
      url.origin !== new URL(deployment).origin ||
      typeof init?.body !== "string"
    ) {
      throw new Error("Invalid service RPC destination");
    }
    const body = JSON.parse(init.body);
    if (
      body.format !== "convex_encoded_json" ||
      !Array.isArray(body.args) ||
      body.args.length !== 1
    ) {
      throw new Error("Unsupported service RPC format");
    }
    const args = jsonToConvex(body.args[0]) as Record<string, unknown>;
    const secret =
      typeof args.serviceKey === "string" ? args.serviceKey : undefined;
    if ("serviceKey" in args) {
      const signed = await signServiceArgs(
        { deployment, name: body.path, type: type as ServiceScope["type"] },
        args,
      );
      body.args = [convexToJson(signed as Value)];
    }
    const response = await transport(input, {
      ...init,
      body: JSON.stringify(body),
    });
    // Scrub errors and SDK log lines before the SDK can print or rethrow them.
    // Successful result values are preserved byte-for-byte.
    const text = await response.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      return new Response(
        redactSensitiveErrorMessage(
          secret ? text.split(secret).join("[Redacted]") : text,
        ),
        {
          status: response.status,
        },
      );
    }
    if (result.status === "error" || result.logLines?.length) {
      const scrub = (value: unknown): unknown => {
        if (typeof value === "string") {
          return redactSensitiveErrorMessage(
            secret ? value.split(secret).join("[Redacted]") : value,
          );
        }
        if (Array.isArray(value)) return value.map(scrub);
        if (value && typeof value === "object") {
          return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
              key,
              /^(serviceKey|service_key|authorization)$/i.test(key)
                ? "[Redacted]"
                : scrub(child),
            ]),
          );
        }
        return value;
      };
      if (result.status === "error") result = scrub(result);
      else result.logLines = scrub(result.logLines);
      return new Response(JSON.stringify(result), { status: response.status });
    }
    return new Response(text, { status: response.status });
  };
}

export function createServiceConvexClient(url: string): ConvexHttpClient {
  const client = new ConvexHttpClient(url, { fetch: createServiceFetch(url) });
  // SDK serialization happens before fetch and can echo the original arguments.
  return new Proxy(client, {
    get(target, property) {
      const method = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      if (
        ![
          "query",
          "consistentQuery",
          "mutation",
          "action",
          "function",
        ].includes(String(property))
      ) {
        return method.bind(target);
      }
      return async (...parameters: unknown[]) => {
        const secrets = parameters.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const key = (value as Record<string, unknown>).serviceKey;
          return typeof key === "string" && key ? [key] : [];
        });
        try {
          return await method.apply(target, parameters);
        } catch (error) {
          let message = error instanceof Error ? error.message : String(error);
          for (const secret of secrets)
            message = message.split(secret).join("[Redacted]");
          const clean = redactSensitiveErrorMessage(message);
          if (error instanceof Error && clean === error.message) throw error;
          throw new Error(clean);
        }
      };
    },
  });
}
