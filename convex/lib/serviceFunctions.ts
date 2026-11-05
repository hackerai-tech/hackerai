import * as generated from "../_generated/server";
import { getFunctionName, type FunctionReference } from "convex/server";
import {
  signServiceArgs,
  verifyServiceArgs,
  type ServiceScope,
} from "../../lib/db/service-proof";
import { ConvexError } from "convex/values";
import { redactSensitiveErrorMessage } from "../../lib/utils/error-redaction";
export type {
  QueryCtx,
  MutationCtx,
  ActionCtx,
  DatabaseReader,
  DatabaseWriter,
} from "../_generated/server";
export { env, httpAction } from "../_generated/server";

// The native argument/return validators stay unchanged. Only the handler and
// outbound service calls are wrapped; the reusable key never enters native RPC.
// These broad implementation types preserve the generated builder's exact
// public generic signature at the cast below.
type Context = generated.QueryCtx | generated.MutationCtx | generated.ActionCtx;
type Definition = {
  handler: (ctx: Context, args: Record<string, unknown>) => unknown;
};

export function serviceContext<T extends Context>(ctx: T): T {
  const wrapped = { ...ctx };
  for (const [method, type] of [
    ["runQuery", "query"],
    ["runMutation", "mutation"],
    ["runAction", "action"],
  ] as const) {
    const invoke = (ctx as unknown as Record<string, unknown>)[method];
    if (typeof invoke !== "function") continue;
    Object.assign(wrapped, {
      [method]: async (
        reference: FunctionReference<typeof type>,
        args: Record<string, unknown> = {},
        ...rest: unknown[]
      ) => {
        const deployment = process.env.CONVEX_CLOUD_URL;
        if ("serviceKey" in args && !deployment)
          throw new Error("Service deployment identity is unavailable");
        const signed =
          "serviceKey" in args
            ? await signServiceArgs(
                {
                  deployment: deployment!,
                  name: getFunctionName(reference),
                  type,
                },
                args,
              )
            : args;
        return invoke.call(ctx, reference, signed, ...rest);
      },
    });
  }
  return wrapped;
}

function wrapBuilder<T>(builder: T): T {
  return ((definition: Definition) => {
    const handler = async (ctx: Context, args: Record<string, unknown>) => {
      let authorizedArgs = args;
      if (args.serviceKey !== undefined) {
        const metadata = await ctx.meta.getFunctionMetadata();
        const deployment = process.env.CONVEX_CLOUD_URL;
        if (!deployment || metadata.componentPath)
          throw new Error("Invalid service deployment identity");
        const secret = metadata.name.startsWith("userResearch:")
          ? process.env.CONVEX_USER_RESEARCH_SERVICE_KEY
          : process.env.CONVEX_SERVICE_ROLE_KEY;
        const scope: ServiceScope = {
          deployment,
          name: metadata.name,
          type: metadata.type,
        };
        // An explicit, expiring rollout window keeps existing workers alive
        // while Vercel and Trigger are replaced. Unset/expired fails closed.
        // Do not consider the leak closed until this window has ended.
        const legacyUntil = Number(
          process.env.CONVEX_SERVICE_AUTH_LEGACY_UNTIL,
        );
        const legacyAllowed =
          secret &&
          args.serviceKey === secret &&
          Number.isFinite(legacyUntil) &&
          Date.now() < legacyUntil;
        if (!legacyAllowed && !(await verifyServiceArgs(scope, args, secret))) {
          throw new Error("Unauthorized: Invalid service request");
        }
        authorizedArgs = { ...args, serviceKey: secret };
      }
      try {
        return await definition.handler(serviceContext(ctx), authorizedArgs);
      } catch (error) {
        // Handlers use the local credential for existing authorization checks.
        // Never let an application-thrown error copy it back into native logs.
        const scrub = (value: unknown): unknown => {
          if (typeof value === "string") {
            let clean = value;
            for (const secret of [
              process.env.CONVEX_SERVICE_ROLE_KEY,
              process.env.CONVEX_USER_RESEARCH_SERVICE_KEY,
            ]) {
              if (secret) clean = clean.split(secret).join("[Redacted]");
            }
            return redactSensitiveErrorMessage(clean);
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
        if (error instanceof ConvexError)
          throw new ConvexError(scrub(error.data) as never);
        const clean = scrub(
          error instanceof Error ? error.message : String(error),
        ) as string;
        if (error instanceof Error && clean === error.message) throw error;
        throw new Error(clean);
      }
    };
    return (builder as (definition: Definition) => unknown)({
      ...definition,
      handler,
    });
  }) as T;
}

export const query = wrapBuilder(generated.query);
export const mutation = wrapBuilder(generated.mutation);
export const action = wrapBuilder(generated.action);
export const internalQuery = wrapBuilder(generated.internalQuery);
export const internalMutation = wrapBuilder(generated.internalMutation);
export const internalAction = wrapBuilder(generated.internalAction);
