/** Offline cutover. See docs/internal/gmail-free-quota-migration.md. */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Redis } from "@upstash/redis";
import {
  createFreeQuotaSubjectWithSecret,
  createCanonicalFreeQuotaSubjectWithSecret,
} from "../lib/auth/free-quota-subject-core";
import {
  FREE_QUOTA_MIGRATION_STATE,
  freeQuotaRedirectKey,
  MIGRATE_FREE_QUOTA_ALIAS_SCRIPT,
} from "../lib/rate-limit/free-quota-migration";
import {
  isExpiredLegacyFreeAgentWindow,
  isFreeQuotaSubjectRateLimitKey,
} from "../lib/rate-limit/key-cleanup";

async function main() {
  const { values } = parseArgs({
    options: {
      action: { type: "string", default: "plan" },
      emails: { type: "string" },
      "expected-redis-host": { type: "string" },
      "all-free-runs-drained": { type: "boolean" },
      "canonical-runtimes-ready": { type: "boolean" },
    },
  });
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const secret = process.env.ACCOUNT_IDENTITY_HMAC_SECRET;
  if (
    !url ||
    !token ||
    !secret ||
    new URL(url).hostname !== values["expected-redis-host"]
  ) {
    throw new Error(
      "Supply verified Redis/HMAC environment and exact expected Redis host",
    );
  }
  const redis = new Redis({ url, token });
  const state = await redis.get<string>(FREE_QUOTA_MIGRATION_STATE);
  if (values.action === "pause") {
    // A later maintenance pause must retain the completed backfill so resume
    // does not require another inventory or replaying the migration.
    const migrationComplete = state === "complete" || state === "migrated";
    await redis.set(
      FREE_QUOTA_MIGRATION_STATE,
      migrationComplete ? "migrated" : "paused",
    );
    console.log(
      migrationComplete
        ? "Free admissions paused; completed migration preserved. Verify canonical runtimes before resuming."
        : "Free admissions paused. Drain all active, queued and approval-waiting free runs before applying.",
    );
    return;
  }
  if (values.action === "resume") {
    if (state !== "migrated" || !values["canonical-runtimes-ready"]) {
      throw new Error(
        "Resume requires completed migration and canonicalization deployed to every runtime",
      );
    }
    await redis.set(FREE_QUOTA_MIGRATION_STATE, "complete");
    console.log("Canonical free quotas enabled.");
    return;
  }
  if (!["plan", "apply"].includes(values.action!))
    throw new Error("Unknown action");
  if (!values.emails)
    throw new Error(
      "Supply a complete private JSON array of current and historical email addresses",
    );
  const emails: unknown = JSON.parse(readFileSync(values.emails, "utf8"));
  if (
    !Array.isArray(emails) ||
    emails.length === 0 ||
    emails.some(
      (email) =>
        typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email.trim()),
    )
  ) {
    throw new Error("Invalid email inventory; no changes made");
  }
  const subjects = new Map<string, string>();
  for (const email of emails) {
    subjects.set(
      createFreeQuotaSubjectWithSecret(email, secret)!,
      createCanonicalFreeQuotaSubjectWithSecret(email, secret)!,
    );
  }
  // Full scan verifies coverage, including keys belonging to deleted accounts.
  const keys = new Set<string>();
  let cursor = "0";
  do {
    const page = await redis.scan(cursor, { match: "free_*", count: 1000 });
    cursor = String(page[0]);
    for (const key of page[1]) keys.add(key);
  } while (cursor !== "0");
  const targets = new Set(subjects.values());
  const bySubject = new Map<string, string[]>();
  let unknown = 0;
  for (const key of keys) {
    // Preserve obsolete daily counters in place; they are not active quotas.
    if (isExpiredLegacyFreeAgentWindow(key)) continue;
    const subject = key.match(/free_quota:v1:[a-f0-9]{64}/)?.[0];
    if (!subject) {
      if (
        /^free_(limit|agent_limit|monthly_cost|referral_bonus|referral_bonus_grant|run_lock):/.test(
          key,
        )
      )
        unknown++;
      continue;
    }
    if (!isFreeQuotaSubjectRateLimitKey(key, subject)) continue;
    if (!subjects.has(subject) && !targets.has(subject)) {
      unknown++;
      continue;
    }
    const list = bySubject.get(subject) ?? [];
    list.push(key);
    bySubject.set(subject, list);
  }
  const aliases = [...subjects].filter(([source, target]) => source !== target);
  const activeLocks = [...keys].filter((key) =>
    key.startsWith("free_run_lock:"),
  ).length;
  console.log(
    JSON.stringify({
      action: values.action,
      accounts: emails.length,
      aliasSubjects: aliases.length,
      unknownQuotaKeys: unknown,
      activeLocks,
    }),
  );
  if (values.action === "plan") return;
  if (
    state !== "paused" ||
    !values["all-free-runs-drained"] ||
    !values["canonical-runtimes-ready"] ||
    activeLocks ||
    unknown
  ) {
    throw new Error(
      "Apply blocked: pause, deploy canonical runtimes, drain every free run, and resolve every unmapped quota key first",
    );
  }
  // Bound request sizes without one network round trip per historical alias.
  for (let offset = 0; offset < aliases.length; offset += 100) {
    const pipeline = redis.pipeline();
    for (const [source, target] of aliases.slice(offset, offset + 100)) {
      const sourceKeys = bySubject.get(source) ?? [];
      const pairs: string[] = [];
      const kinds: string[] = [];
      for (const key of sourceKeys) {
        if (key.startsWith("free_run_lock:"))
          throw new Error("Active free run found");
        pairs.push(key, key.replace(source, target));
        kinds.push(
          key.startsWith("free_referral_bonus_grant:") ||
            key.startsWith("free_usage_budget_started:")
            ? "marker"
            : "counter",
        );
      }
      pipeline.eval(
        MIGRATE_FREE_QUOTA_ALIAS_SCRIPT,
        [FREE_QUOTA_MIGRATION_STATE, freeQuotaRedirectKey(source), ...pairs],
        [target, ...kinds],
      );
    }
    await pipeline.exec();
  }
  await redis.set(FREE_QUOTA_MIGRATION_STATE, "migrated");
  console.log(
    "Migration complete; free admissions remain paused. Verify canonical runtimes, then explicitly resume.",
  );
}

main().catch(() => {
  // SDK errors can contain request credentials or private inventory values.
  console.error(
    "Quota migration stopped. Check the runbook prerequisites; free admissions were not automatically resumed.",
  );
  process.exitCode = 1;
});
