import { createHash, timingSafeEqual } from "node:crypto";
import { Redis } from "@upstash/redis";
import { WorkOS } from "@workos-inc/node";
import { z } from "zod";
import { NextResponse } from "next/server";
import {
  MigrationBlocked,
  runQuotaMigration,
} from "@/lib/rate-limit/quota-migration-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const commandSchema = z
  .object({
    action: z.enum([
      "status",
      "inventory",
      "restart-inventory",
      "restart-audit",
      "audit",
      "pause",
      "apply",
      "resume",
      "cleanup",
    ]),
    allFreeRunsDrained: z.boolean().optional(),
    canonicalRuntimesReady: z.boolean().optional(),
  })
  .strict();

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: Request) {
  const env = process.env;
  const hash = env.FREE_QUOTA_MIGRATION_OPERATOR_SHA256;
  const expires = Date.parse(
    env.FREE_QUOTA_MIGRATION_OPERATOR_EXPIRES_AT ?? "",
  );
  if (
    !hash ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    !Number.isFinite(expires) ||
    expires <= Date.now() ||
    expires > Date.now() + 86_400_000
  ) {
    return reply({ error: "migration_runner_disabled" }, 404);
  }
  const authorization = request.headers.get("authorization") ?? "";
  if (
    !/^Bearer [a-f0-9]{64}$/.test(authorization) ||
    !timingSafeEqual(
      createHash("sha256").update(authorization.slice(7)).digest(),
      Buffer.from(hash, "hex"),
    )
  ) {
    return reply({ error: "unauthorized" }, 401);
  }
  // Bind each deployment to the independently verified environment. Never
  // accept Redis/WorkOS URLs, secrets, quota hashes or scripts in the request.
  let redisURL: URL;
  try {
    redisURL = new URL(env.UPSTASH_REDIS_REST_URL ?? "");
  } catch {
    return reply({ error: "migration_environment_mismatch" }, 503);
  }
  if (
    env.VERCEL !== "1" ||
    !["preview", "production"].includes(env.VERCEL_ENV ?? "") ||
    env.VERCEL_ENV !== env.FREE_QUOTA_MIGRATION_ENVIRONMENT ||
    redisURL.protocol !== "https:" ||
    redisURL.hostname !== env.FREE_QUOTA_MIGRATION_REDIS_HOST ||
    !env.FREE_QUOTA_MIGRATION_CONVEX_URL ||
    env.NEXT_PUBLIC_CONVEX_URL !== env.FREE_QUOTA_MIGRATION_CONVEX_URL ||
    !env.FREE_QUOTA_MIGRATION_WORKOS_CLIENT_ID ||
    env.WORKOS_CLIENT_ID !== env.FREE_QUOTA_MIGRATION_WORKOS_CLIENT_ID ||
    !env.UPSTASH_REDIS_REST_TOKEN ||
    !env.ACCOUNT_IDENTITY_HMAC_SECRET ||
    !env.WORKOS_API_KEY
  ) {
    return reply({ error: "migration_environment_mismatch" }, 503);
  }
  let input: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) return reply({ error: "invalid_command" }, 400);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1024) {
          await reader.cancel();
          return reply({ error: "invalid_command" }, 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return reply({ error: "invalid_command" }, 400);
  }
  const command = commandSchema.safeParse(input);
  if (!command.success) return reply({ error: "invalid_command" }, 400);
  try {
    const workos = new WorkOS(env.WORKOS_API_KEY, {
      clientId: env.WORKOS_CLIENT_ID,
    });
    const result = await runQuotaMigration(command.data, {
      redis: new Redis({
        url: redisURL.toString(),
        token: env.UPSTASH_REDIS_REST_TOKEN,
        retry: false,
      }),
      hmacSecret: env.ACCOUNT_IDENTITY_HMAC_SECRET,
      canonical: env.FREE_QUOTA_GMAIL_CANONICALIZATION === "true",
      listUsers: async (after) => {
        const page = await workos.userManagement.listUsers({
          limit: 100,
          after,
        });
        return {
          emails: page.data.map((user) => user.email),
          after: page.listMetadata.after ?? null,
        };
      },
    });
    return reply(result);
  } catch (error) {
    // Provider errors may contain credentials, cursors or inventory. No raw
    // provider error, user address, subject, or token enters logs/responses.
    return reply(
      {
        error:
          error instanceof MigrationBlocked
            ? "migration_precondition_failed"
            : "migration_step_failed",
      },
      error instanceof MigrationBlocked ? 409 : 503,
    );
  }
}
