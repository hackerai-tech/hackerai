import { createHash } from "node:crypto";

function check(ok, message) {
  if (!ok) throw new Error(message);
}
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const stamp = (value) =>
  typeof value === "string" ? Date.parse(value) : value;

/** Pure selection from a bounded PostHog export; never opens billing or messages. */
export function buildResearchCohort(spec) {
  check(
    spec?.posthogProjectId === 144137,
    "Cohort must come from the production PostHog project",
  );
  check(
    Array.isArray(spec.candidates) &&
      spec.candidates.length > 0 &&
      spec.candidates.length <= 5000,
    "Supply 1-5000 ranked PostHog candidates",
  );
  check(
    typeof spec.selectionQuery === "string" &&
      spec.selectionQuery.length > 0 &&
      Buffer.byteLength(spec.selectionQuery) <= 65536,
    "Supply the bounded cohort selection query for fingerprinting",
  );
  const selectedAt = stamp(spec.cohortSelectedAt);
  check(
    Number.isSafeInteger(selectedAt) && selectedAt > 0,
    "Invalid cohort selection timestamp",
  );
  check(
    spec.requirePayerMapping === undefined ||
      typeof spec.requirePayerMapping === "boolean",
    "Invalid payer mapping policy",
  );
  const limit = spec.maxUsers ?? 20;
  check(
    Number.isInteger(limit) && limit >= 1 && limit <= 20,
    "Cohort limit must be 1-20",
  );
  const excluded = {};
  for (const key of ["userIds", "payerIds", "organizationIds"]) {
    const values = spec.exclusions?.[key] ?? [];
    check(
      Array.isArray(values) && values.every(id),
      "Invalid cohort exclusions",
    );
    excluded[key] = new Set(values);
  }
  const rows = spec.candidates;
  const parent = rows.map((_, i) => i);
  const root = (i) => {
    let found = i;
    while (parent[found] !== found) found = parent[found];
    while (parent[i] !== i) {
      const next = parent[i];
      parent[i] = found;
      i = next;
    }
    return found;
  };
  const owners = new Map();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    check(
      id(row.userId) && !/^(cus_|org_)/.test(row.userId),
      "Cohort candidates require internal user IDs",
    );
    for (const key of ["payerId", "organizationId"])
      check(row[key] == null || id(row[key]), "Invalid payer mapping");
    if (row.group !== undefined)
      check(
        typeof row.group === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(row.group),
        "Invalid comparison label",
      );
    if (row.anchorAt !== undefined)
      check(
        Number.isSafeInteger(stamp(row.anchorAt)) &&
          stamp(row.anchorAt) > 0 &&
          stamp(row.anchorAt) <= selectedAt,
        "Invalid per-user evidence anchor",
      );
    for (const [kind, value] of [
      ["user", row.userId],
      ["payer", row.payerId],
      ["org", row.organizationId],
    ]) {
      if (!value) continue;
      const key = `${kind}:${value}`;
      if (owners.has(key)) parent[root(i)] = root(owners.get(key));
      else owners.set(key, i);
    }
  }
  const components = new Map();
  rows.forEach((row, i) => {
    const key = root(i);
    if (!components.has(key)) components.set(key, []);
    components.get(key).push({ row, index: i });
  });
  const removed = {
    excluded: 0,
    unknownClassification: 0,
    conflictingGroups: 0,
    unmapped: 0,
    duplicates: 0,
  };
  const eligible = [];
  for (const members of components.values()) {
    const records = members.map((m) => m.row);
    if (
      records.some(
        (r) =>
          r.internal === true ||
          r.test === true ||
          r.fraud === true ||
          excluded.userIds.has(r.userId) ||
          excluded.payerIds.has(r.payerId) ||
          excluded.organizationIds.has(r.organizationId),
      )
    ) {
      removed.excluded += members.length;
      continue;
    }
    if (
      records.some((r) =>
        [r.internal, r.test, r.fraud].some((v) => v !== false),
      )
    ) {
      removed.unknownClassification += members.length;
      continue;
    }
    if (new Set(records.map((r) => r.group)).size !== 1) {
      removed.conflictingGroups += members.length;
      continue;
    }
    const anchorsByUser = new Map();
    for (const r of records) {
      const anchor = r.anchorAt === undefined ? undefined : stamp(r.anchorAt);
      if (anchorsByUser.has(r.userId))
        check(
          anchorsByUser.get(r.userId) === anchor,
          "Resolve multiple event anchors for the same user before selection",
        );
      anchorsByUser.set(r.userId, anchor);
    }
    const representative = members[0];
    if (
      spec.requirePayerMapping === true &&
      !representative.row.payerId &&
      !representative.row.organizationId
    ) {
      removed.unmapped += members.length;
      continue;
    }
    eligible.push(representative);
    removed.duplicates += members.length - 1;
  }
  // Preserve the ranked query's order, including components joined transitively.
  const selected = eligible
    .sort((a, b) => a.index - b.index)
    .slice(0, limit)
    .map((m) => m.row);
  check(
    selected.length > 0,
    "No eligible research users remain after selection",
  );
  const groups = [...new Set(selected.map((r) => r.group))];
  let comparisonGroups;
  if (groups.some((g) => g !== undefined)) {
    check(
      !groups.includes(undefined) && groups.length >= 2 && groups.length <= 4,
      "Comparisons require 2-4 complete groups",
    );
    comparisonGroups = groups.map((label) => ({
      label,
      userIds: selected.filter((r) => r.group === label).map((r) => r.userId),
    }));
    check(
      comparisonGroups.every((g) => g.userIds.length >= 3),
      "Every comparison group needs at least three independent users",
    );
  }
  const anchored = selected.some((r) => r.anchorAt !== undefined);
  check(
    !anchored || selected.every((r) => r.anchorAt !== undefined),
    "Every selected user needs an event anchor",
  );
  const unmapped = selected.filter(
    (r) => !r.payerId && !r.organizationId,
  ).length;
  const selectionLimitations = [];
  if (unmapped)
    selectionLimitations.push(
      `${unmapped} selected users lack payer/organization mapping; cross-user billing deduplication is incomplete.`,
    );
  const reasons = Object.entries(removed)
    .filter(([, count]) => count)
    .map(([reason, count]) => `${reason}=${count}`);
  if (reasons.length)
    selectionLimitations.push(`Removed candidate rows: ${reasons.join(", ")}.`);
  if (eligible.length > limit)
    selectionLimitations.push(
      `Selection retained the first ${limit} eligible users in ranked query order.`,
    );
  return {
    payload: {
      userIds: selected.map((r) => r.userId),
      cohortSource: "posthog",
      posthogProjectId: 144137,
      cohortSelectedAt: selectedAt,
      selectionQueryFingerprint: createHash("sha256")
        .update(spec.selectionQuery)
        .digest("hex"),
      selectionLimitations,
      ...(comparisonGroups ? { comparisonGroups } : {}),
      ...(anchored
        ? {
            samplingMode: "pre_event",
            evidenceAnchors: selected.map((r) => ({
              userId: r.userId,
              anchorAt: stamp(r.anchorAt),
            })),
          }
        : {}),
    },
    coverage: {
      candidates: rows.length,
      selected: selected.length,
      ...removed,
      missingPayerMapping: unmapped,
    },
  };
}
