import { ConvexHttpClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import { convexToJson, jsonToConvex, type Value } from "convex/values";
import { signServiceArgs, type ServiceScope } from "./service-proof";
import { redactSensitiveErrorMessage } from "../utils/error-redaction";

const safeFunctionName = (name: unknown, secrets: string[]) =>
  typeof name === "string" &&
  name.length <= 128 &&
  /^[a-zA-Z0-9_/.-]+:[a-zA-Z0-9_$]+$/.test(name) &&
  !secrets.some((secret) => name.includes(secret))
    ? name
    : undefined;

/** Wrap SDK RPCs with scoped service proofs, error redaction and bounded diagnostics. */
export function createServiceFetch(
  deployment: string,
  transport: typeof fetch = globalThis.fetch,
  clientInstanceId?: string,
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
    const functionName = safeFunctionName(body.path, secret ? [secret] : []);
    const clientId =
      clientInstanceId &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(clientInstanceId) &&
      (!secret || !clientInstanceId.includes(secret))
        ? clientInstanceId
        : undefined;
    const startedAt = Date.now();
    let stage: "request" | "response_body" = "request";
    let statusCode: number | undefined;
    let reported = false;
    const reportFailure = (
      reason: "http_5xx" | "transport_error",
      error?: unknown,
    ) => {
      if (reported) return;
      reported = true;
      // At most one failure diagnostic attempt per RPC. Never include arguments,
      // headers, URLs, response bodies or arbitrary error messages/codes.
      // Reporting must not replace the original transport result or error.
      try {
        const code =
          error instanceof Error && error.cause instanceof Error
            ? (error.cause as NodeJS.ErrnoException).code
            : (error as NodeJS.ErrnoException | undefined)?.code;
        console.warn(
          JSON.stringify({
            event: "convex_service_rpc_failed",
            ...(clientId ? { client_instance_id: clientId } : {}),
            rpc_kind: type,
            ...(functionName ? { function_name: functionName } : {}),
            stage,
            reason,
            ...(statusCode !== undefined ? { status_code: statusCode } : {}),
            ...([
              "ECONNRESET",
              "ECONNREFUSED",
              "ETIMEDOUT",
              "ENOTFOUND",
              "EAI_AGAIN",
              "UND_ERR_CONNECT_TIMEOUT",
              "UND_ERR_HEADERS_TIMEOUT",
              "UND_ERR_BODY_TIMEOUT",
              "UND_ERR_SOCKET",
            ].includes(code ?? "")
              ? { transport_code: code }
              : {}),
            transport_elapsed_ms: Math.max(0, Date.now() - startedAt),
          }),
        );
      } catch {
        // Diagnostics are best effort, including when logging itself fails.
      }
    };
    let response: Response;
    let text: string;
    // A platform timeout can kill the request before transport rejects. Record
    // which await is still pending once, without aborting or retrying the RPC.
    const pendingWarning = setTimeout(() => {
      try {
        console.warn(
          JSON.stringify({
            event: "convex_service_rpc_pending",
            ...(clientId ? { client_instance_id: clientId } : {}),
            rpc_kind: type,
            ...(functionName ? { function_name: functionName } : {}),
            stage,
            ...(statusCode !== undefined ? { status_code: statusCode } : {}),
            transport_elapsed_ms: Math.max(0, Date.now() - startedAt),
          }),
        );
      } catch {
        // A diagnostic must not interrupt the pending RPC.
      }
    }, 10_000);
    pendingWarning.unref?.();
    try {
      response = await transport(input, {
        ...init,
        body: JSON.stringify(body),
      });
      statusCode = response.status;
      if (statusCode >= 500 && statusCode <= 599) reportFailure("http_5xx");
      stage = "response_body";
      text = await response.text();
    } catch (error) {
      reportFailure("transport_error", error);
      throw error;
    } finally {
      clearTimeout(pendingWarning);
    }
    // Scrub errors and SDK log lines before the SDK can print or rethrow them.
    // Successful result values are preserved byte-for-byte.
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

export function createServiceConvexClient(
  url: string,
  options?: { signal?: AbortSignal },
): ConvexHttpClient {
  let clientInstanceId: string | undefined;
  try {
    clientInstanceId = globalThis.crypto?.randomUUID();
  } catch {
    // Correlation is optional; it must not prevent creating the client.
  }
  let pendingMutations = 0;
  let mutationSequence = 0;
  let oldestPending:
    { id: number; startedAt: number; functionName?: string } | undefined;
  let warningTimes: number[] = [];
  const observeMutation = (reference: unknown, secrets: string[]) => {
    const startedAt = Date.now();
    let warningAttempted = false;
    const callId = ++mutationSequence;
    const pendingAtStart = pendingMutations++;
    const clientId =
      clientInstanceId &&
      !secrets.some((secret) => clientInstanceId.includes(secret))
        ? clientInstanceId
        : undefined;
    let functionName: string | undefined;
    try {
      functionName = safeFunctionName(
        getFunctionName(reference as Parameters<typeof getFunctionName>[0]),
        secrets,
      );
    } catch {
      // Preserve the SDK's own validation result for unsupported references.
    }
    if (pendingAtStart === 0) {
      oldestPending = { id: callId, startedAt, functionName };
    }
    const timer = setTimeout(() => {
      const now = Date.now();
      warningTimes = warningTimes.filter((time) => now - time < 60_000);
      if (warningTimes.length >= 2) return;
      warningTimes.push(now);
      warningAttempted = true;
      try {
        console.warn(
          JSON.stringify({
            event: "convex_service_mutation_wait_pending",
            ...(clientId ? { client_instance_id: clientId } : {}),
            sdk_call_id: callId,
            ...(functionName ? { function_name: functionName } : {}),
            sdk_elapsed_ms: Math.max(0, now - startedAt),
            pending_mutations_at_start: pendingAtStart,
            pending_mutations_now: pendingMutations,
            ...(oldestPending
              ? {
                  oldest_pending_call_id: oldestPending.id,
                  oldest_pending_function_name: safeFunctionName(
                    oldestPending.functionName,
                    secrets,
                  ),
                  oldest_pending_elapsed_ms: Math.max(
                    0,
                    now - oldestPending.startedAt,
                  ),
                }
              : {}),
          }),
        );
      } catch {
        // Sample at most twice per client per minute, even if logging fails.
      }
    }, 10_000);
    timer.unref?.();
    return (outcome: "fulfilled" | "rejected") => {
      clearTimeout(timer);
      pendingMutations--;
      // Do not guess the oldest remaining call after the tracked one settles.
      if (oldestPending?.id === callId) oldestPending = undefined;
      if (!warningAttempted) return;
      try {
        console.info(
          JSON.stringify({
            event: "convex_service_mutation_wait_settled",
            ...(clientId ? { client_instance_id: clientId } : {}),
            sdk_call_id: callId,
            ...(functionName ? { function_name: functionName } : {}),
            sdk_elapsed_ms: Math.max(0, Date.now() - startedAt),
            outcome,
            pending_mutations_now: pendingMutations,
          }),
        );
      } catch {
        // Diagnostics must not replace the SDK's result or rejection.
      }
    };
  };
  const signal = options?.signal;
  const transport: typeof fetch = signal
    ? (input, init) => {
        signal.throwIfAborted();
        return globalThis.fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, signal])
            : signal,
        });
      }
    : globalThis.fetch;
  const client = new ConvexHttpClient(url, {
    fetch: createServiceFetch(url, transport, clientInstanceId),
  });
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
        const finishObservation =
          property === "mutation"
            ? observeMutation(parameters[0], secrets)
            : undefined;
        let outcome: "fulfilled" | "rejected" = "rejected";
        try {
          const result = await method.apply(target, parameters);
          outcome = "fulfilled";
          return result;
        } catch (error) {
          let message = error instanceof Error ? error.message : String(error);
          for (const secret of secrets)
            message = message.split(secret).join("[Redacted]");
          const clean = redactSensitiveErrorMessage(message);
          if (error instanceof Error && clean === error.message) throw error;
          throw new Error(clean);
        } finally {
          finishObservation?.(outcome);
        }
      };
    },
  });
}
