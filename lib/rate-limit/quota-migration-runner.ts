import { createHash, randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";
import {
  createCanonicalFreeQuotaSubjectWithSecret,
  createFreeQuotaSubjectWithSecret,
} from "../auth/free-quota-subject-core";
import {
  isExpiredLegacyFreeAgentWindow,
  isFreeQuotaSubjectRateLimitKey,
} from "./key-cleanup";
import {
  FREE_QUOTA_MIGRATION_STATE,
  freeQuotaRedirectKey,
  MIGRATE_FREE_QUOTA_ALIAS_SCRIPT,
} from "./free-quota-migration";

const PREFIX = "free_quota_runtime_migration:v1";
const META = `${PREFIX}:meta`;
const SUBJECTS = `${PREFIX}:subjects`;
// Keep an existing unsharded inventory readable, but never grow it again.
// New mappings are partitioned by the final HMAC byte below Upstash's record cap.
const SUBJECT_COLLECTIONS = [
  SUBJECTS,
  ...Array.from(
    { length: 256 },
    (_, bucket) => `${SUBJECTS}:${bucket.toString(16).padStart(2, "0")}`,
  ),
];
const SOURCE_KEYS = `${PREFIX}:source_keys`;
const UNKNOWN = `${PREFIX}:unknown`;
const LOCK = `${PREFIX}:lock`;

type Progress = {
  hmacFingerprint?: string;
  inventoryCursor?: string;
  inventoryComplete?: boolean;
  inventoryCanonical?: boolean;
  auditCursor?: string;
  auditComplete?: boolean;
  auditPaused?: boolean;
  auditHasLocks?: boolean;
  applyCursor?: string;
  applyCollection?: number;
  applyStarted?: boolean;
  applied?: boolean;
};

export type MigrationCommand = {
  action:
    | "status"
    | "inventory"
    | "restart-inventory"
    | "restart-audit"
    | "audit"
    | "pause"
    | "apply"
    | "resume"
    | "cleanup";
  allFreeRunsDrained?: boolean;
  canonicalRuntimesReady?: boolean;
};

export type InventoryPage = {
  emails: string[];
  after: string | null;
};

export class MigrationBlocked extends Error {}

export type MigrationRunnerDependencies = {
  redis: Redis;
  hmacSecret: string;
  canonical: boolean;
  listUsers: (after?: string) => Promise<InventoryPage>;
};

// Progress is committed only by the current lease owner. A timed-out request
// can retry its page: inventory writes and the existing alias transfer are
// idempotent. Each request handles one bounded page, never the whole inventory.
const GUARDED_TRANSFER = `
if redis.call("GET", KEYS[#KEYS]) ~= ARGV[#ARGV] then
  return redis.error_reply("Migration lease lost")
end
table.remove(KEYS)
table.remove(ARGV)
${MIGRATE_FREE_QUOTA_ALIAS_SCRIPT}`;

export async function runQuotaMigration(
  command: MigrationCommand,
  deps: MigrationRunnerDependencies,
) {
  const { redis, hmacSecret, canonical } = deps;
  const owner = randomUUID();
  if (!(await redis.set(LOCK, owner, { nx: true, px: 120_000 }))) {
    throw new MigrationBlocked("Another migration request is running");
  }
  try {
    const progress = (await redis.get<Progress>(META)) ?? {};
    const hmacFingerprint = createHash("sha256")
      .update(hmacSecret)
      .digest("hex");
    if (
      progress.hmacFingerprint &&
      progress.hmacFingerprint !== hmacFingerprint
    ) {
      throw new MigrationBlocked(
        "Quota identity secret changed during migration",
      );
    }
    const state = await redis.get<string>(FREE_QUOTA_MIGRATION_STATE);
    const paused = state === "paused" || state === "migrated";
    const commit = async (next: Progress, nextState?: string) => {
      await redis.eval(
        `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return redis.error_reply('Migration lease lost') end
         redis.call('SET', KEYS[2], ARGV[2])
         if ARGV[3] ~= '' then redis.call('SET', KEYS[3], ARGV[3]) end
         return 1`,
        [LOCK, META, FREE_QUOTA_MIGRATION_STATE],
        [owner, JSON.stringify({ ...next, hmacFingerprint }), nextState ?? ""],
      );
    };
    // No work may survive the lease and modify a newer request's inventory.
    const writePage = async (key: string, entries: Record<string, string>) => {
      if (!Object.keys(entries).length) return;
      await redis.eval(
        `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return redis.error_reply('Migration lease lost') end
         for i = 2, #ARGV, 2 do redis.call('HSET', KEYS[2], ARGV[i], ARGV[i+1]) end
         return 1`,
        [LOCK, key],
        [owner, ...Object.entries(entries).flat()],
      );
    };

    if (command.action === "restart-inventory") {
      if (
        progress.applyStarted ||
        state === "migrated" ||
        state === "complete"
      ) {
        throw new MigrationBlocked("Cannot restart after transfers begin");
      }
      // Retain old mappings: they may be the only record of a deleted account.
      await commit({});
    } else if (command.action === "restart-audit") {
      if (
        progress.applyStarted ||
        state === "migrated" ||
        state === "complete"
      ) {
        throw new MigrationBlocked(
          "Cannot restart audit after transfers begin",
        );
      }
      await commit({
        ...progress,
        auditCursor: undefined,
        auditComplete: false,
        auditHasLocks: false,
        auditPaused: false,
      });
    } else if (command.action === "inventory") {
      if (
        progress.applyStarted ||
        state === "complete" ||
        state === "migrated"
      ) {
        throw new MigrationBlocked("Inventory is closed after transfers begin");
      }
      if (!progress.inventoryComplete) {
        if (paused && !canonical) {
          throw new MigrationBlocked(
            "Deploy canonical runtimes before refreshing the paused inventory",
          );
        }
        const page = await deps.listUsers(progress.inventoryCursor);
        const mappings: Record<string, string> = {};
        for (const email of page.emails) {
          const source = createFreeQuotaSubjectWithSecret(email, hmacSecret);
          const target = createCanonicalFreeQuotaSubjectWithSecret(
            email,
            hmacSecret,
          );
          if (!source || !target)
            throw new MigrationBlocked("Invalid inventory identity");
          mappings[source] = target;
          mappings[target] = target;
        }
        await redis.eval(
          `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return redis.error_reply('Migration lease lost') end
           for i = 2, #ARGV, 2 do
             local bucket = tonumber(string.sub(ARGV[i], -2), 16)
             local previous = redis.call('HGET', KEYS[2], ARGV[i])
             local sharded = redis.call('HGET', KEYS[3 + bucket], ARGV[i])
             if (previous and previous ~= ARGV[i+1]) or (sharded and sharded ~= ARGV[i+1]) then
               return redis.error_reply('Inventory mapping changed')
             end
             if not previous and not sharded then
               redis.call('HSET', KEYS[3 + bucket], ARGV[i], ARGV[i+1])
             end
           end
           return 1`,
          [LOCK, ...SUBJECT_COLLECTIONS],
          [owner, ...Object.entries(mappings).flat()],
        );
        await commit({
          inventoryCursor: page.after ?? undefined,
          inventoryComplete: !page.after,
          inventoryCanonical: canonical,
        });
      }
    } else if (command.action === "audit") {
      if (
        !progress.inventoryComplete ||
        progress.applyStarted ||
        state === "complete"
      ) {
        throw new MigrationBlocked(
          "A complete inventory is required before audit",
        );
      }
      if (!progress.auditComplete) {
        if (!progress.auditCursor) {
          await redis.eval(
            `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return redis.error_reply('Migration lease lost') end
             return redis.call('DEL', KEYS[2], KEYS[3])`,
            [LOCK, SOURCE_KEYS, UNKNOWN],
            [owner],
          );
        }
        const [cursor, keys] = await redis.scan(progress.auditCursor ?? "0", {
          match: "free_*",
          count: 1000,
        });
        const relevant = keys.filter(
          (key) =>
            !isExpiredLegacyFreeAgentWindow(key) &&
            /^free_(limit|agent_limit|monthly_cost|referral_bonus|referral_bonus_grant|run_lock|usage_budget_started):/.test(
              key,
            ),
        );
        const subjects = [
          ...new Set(
            relevant
              .map((key) => key.match(/free_quota:v1:[a-f0-9]{64}/)?.[0])
              .filter((s): s is string => !!s),
          ),
        ];
        const targets = subjects.length
          ? await redis.eval<string[], (string | null)[]>(
              `local values = {}
               for i, subject in ipairs(ARGV) do
                 local value = redis.call('HGET', KEYS[1], subject)
                 if not value then
                   local bucket = tonumber(string.sub(subject, -2), 16)
                   value = redis.call('HGET', KEYS[2 + bucket], subject)
                 end
                 values[i] = value
               end
               return values`,
              SUBJECT_COLLECTIONS,
              subjects,
            )
          : [];
        const mappings = Object.fromEntries(
          subjects.map((subject, i) => [subject, targets[i]]),
        );
        const unknown: Record<string, string> = {};
        const aliases = new Map<string, Set<string>>();
        for (const key of relevant) {
          const subject = key.match(/free_quota:v1:[a-f0-9]{64}/)?.[0];
          if (
            !subject ||
            !isFreeQuotaSubjectRateLimitKey(key, subject) ||
            !mappings?.[subject]
          ) {
            unknown[key] = "1";
          } else if (mappings[subject] !== subject) {
            const keysForAlias = aliases.get(subject) ?? new Set<string>();
            keysForAlias.add(key);
            aliases.set(subject, keysForAlias);
          }
        }
        const previous = aliases.size
          ? await redis.hmget<Record<string, string[]>>(
              SOURCE_KEYS,
              ...aliases.keys(),
            )
          : {};
        const updated: Record<string, string> = {};
        for (const [subject, keysForAlias] of aliases) {
          for (const key of previous?.[subject] ?? []) keysForAlias.add(key);
          updated[subject] = JSON.stringify([...keysForAlias]);
        }
        await writePage(SOURCE_KEYS, updated);
        await writePage(UNKNOWN, unknown);
        await commit({
          ...progress,
          auditCursor: String(cursor),
          auditComplete: String(cursor) === "0",
          auditPaused: paused,
          auditHasLocks:
            !!progress.auditHasLocks ||
            relevant.some((key) => key.startsWith("free_run_lock:")),
        });
      }
    } else if (command.action === "pause") {
      if (
        paused ||
        state === "complete" ||
        !progress.auditComplete ||
        (await redis.hlen(UNKNOWN))
      ) {
        throw new MigrationBlocked(
          "Pause requires a complete audit with zero unknown keys",
        );
      }
      // Force a fresh complete inventory after old runtimes are drained.
      await commit({}, "paused");
    } else if (command.action === "apply") {
      if (
        state !== "paused" ||
        !canonical ||
        !progress.inventoryCanonical ||
        !progress.auditComplete ||
        !progress.auditPaused ||
        progress.auditHasLocks ||
        (await redis.hlen(UNKNOWN)) ||
        !command.allFreeRunsDrained ||
        !command.canonicalRuntimesReady
      ) {
        throw new MigrationBlocked(
          "Apply requires paused canonical runtimes, refreshed inventory, complete coverage and drained free work",
        );
      }
      // The paused full audit checked locks across every SCAN page. Admission
      // remains paused; the operator also verifies queued/approval-waiting work.
      await commit({ ...progress, applyStarted: true });
      const collection = progress.applyCollection ?? 0;
      if (
        !Number.isInteger(collection) ||
        collection < 0 ||
        collection >= SUBJECT_COLLECTIONS.length
      )
        throw new MigrationBlocked("Invalid inventory collection cursor");
      const [cursor, entries] = await redis.hscan(
        SUBJECT_COLLECTIONS[collection],
        progress.applyCursor ?? "0",
        { count: 100 },
      );
      for (let i = 0; i < entries.length; i += 2) {
        const source = String(entries[i]);
        const target = String(entries[i + 1]);
        if (source === target) continue;
        const keys = (await redis.hget<string[]>(SOURCE_KEYS, source)) ?? [];
        const pairs: string[] = [];
        const kinds: string[] = [];
        for (const key of keys) {
          if (key.startsWith("free_run_lock:")) continue;
          if (!isFreeQuotaSubjectRateLimitKey(key, source))
            throw new MigrationBlocked("Invalid stored quota key");
          pairs.push(key, key.replace(source, target));
          kinds.push(
            key.startsWith("free_referral_bonus_grant:") ||
              key.startsWith("free_usage_budget_started:")
              ? "marker"
              : "counter",
          );
        }
        await redis.eval(
          GUARDED_TRANSFER,
          [
            FREE_QUOTA_MIGRATION_STATE,
            freeQuotaRedirectKey(source),
            ...pairs,
            LOCK,
          ],
          [target, ...kinds, owner],
        );
      }
      const finishedCollection = String(cursor) === "0";
      const applied =
        finishedCollection && collection === SUBJECT_COLLECTIONS.length - 1;
      await commit(
        {
          ...progress,
          applyStarted: true,
          applyCursor: String(cursor),
          applyCollection:
            finishedCollection && !applied ? collection + 1 : collection,
          applied,
        },
        applied ? "migrated" : undefined,
      );
    } else if (command.action === "resume") {
      if (
        state !== "migrated" ||
        !progress.applied ||
        !canonical ||
        !command.canonicalRuntimesReady
      ) {
        throw new MigrationBlocked(
          "Resume requires completed transfers and verified canonical runtimes",
        );
      }
      await commit(progress, "complete");
    } else if (command.action === "cleanup") {
      if (state !== "complete")
        throw new MigrationBlocked("Cleanup requires completed migration");
      await redis.eval(
        `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return redis.error_reply('Migration lease lost') end
         local deleted = 0
         for i = 2, #KEYS do deleted = deleted + redis.call('DEL', KEYS[i]) end
         return deleted`,
        [LOCK, META, ...SUBJECT_COLLECTIONS, SOURCE_KEYS, UNKNOWN],
        [owner],
      );
    }
    const latest = (await redis.get<Progress>(META)) ?? {};
    return {
      state:
        (await redis.get<string>(FREE_QUOTA_MIGRATION_STATE)) ?? "not_started",
      canonical,
      inventoryComplete: !!latest.inventoryComplete,
      auditComplete: !!latest.auditComplete,
      auditPaused: !!latest.auditPaused,
      auditHasLocks: !!latest.auditHasLocks,
      applyStarted: !!latest.applyStarted,
      applied: !!latest.applied,
      mappedSubjects: await redis.eval<[], number>(
        "local count = 0; for _, key in ipairs(KEYS) do count = count + redis.call('HLEN', key) end; return count",
        SUBJECT_COLLECTIONS,
        [],
      ),
      aliasesWithKeys: await redis.hlen(SOURCE_KEYS),
      unknownQuotaKeys: await redis.hlen(UNKNOWN),
    };
  } finally {
    await redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
      [LOCK],
      [owner],
    );
  }
}
