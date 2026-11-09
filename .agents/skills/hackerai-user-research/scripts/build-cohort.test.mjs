import assert from "node:assert/strict";
import { test } from "node:test";
import { buildResearchCohort } from "./build-cohort.mjs";
const row = (userId, extra = {}) => ({
  userId,
  internal: false,
  test: false,
  fraud: false,
  ...extra,
});
const spec = (candidates) => ({
  posthogProjectId: 144137,
  cohortSelectedAt: 1800000000000,
  selectionQuery: "SELECT distinct_id FROM persons",
  candidates,
});

test("deduplicates transitive payer/organization components in ranked order", () => {
  const input = spec([
    row("user_first", { payerId: "cus_one" }),
    row("user_second", { organizationId: "org_one" }),
    row("user_third", { payerId: "cus_one", organizationId: "org_one" }),
    row("user_independent", { payerId: "cus_two" }),
  ]);
  const result = buildResearchCohort(input);
  assert.deepEqual(result.payload.userIds, ["user_first", "user_independent"]);
  assert.equal(result.coverage.duplicates, 2);
  assert.doesNotMatch(JSON.stringify(result), /cus_one|org_one|SELECT/);
  assert.match(result.payload.selectionQueryFingerprint, /^[a-f0-9]{64}$/);
});
test("exclusions apply across connected identities before selecting the cohort limit", () => {
  const input = spec([
    row("user_first", { payerId: "cus_bad" }),
    row("user_later", { payerId: "cus_bad", fraud: true }),
    row("user_test", { test: true }),
    row("user_internal", { internal: true }),
    row("user_unknown", { internal: undefined }),
    row("user_excluded"),
    row("user_good"),
    row("user_overflow"),
  ]);
  input.exclusions = { userIds: ["user_excluded"] };
  input.maxUsers = 1;
  const result = buildResearchCohort(input);
  assert.deepEqual(result.payload.userIds, ["user_good"]);
  assert.equal(result.coverage.excluded, 5);
  assert.equal(result.coverage.unknownClassification, 1);
  assert.equal(result.coverage.missingPayerMapping, 1);
  assert.match(result.payload.selectionLimitations.join(" "), /incomplete/);
});
test("unmapped users are reported or excluded under an explicit strict mapping policy", () => {
  const input = spec([
    row("user_unmapped"),
    row("user_mapped", { payerId: "cus_known" }),
  ]);
  assert.equal(buildResearchCohort(input).coverage.missingPayerMapping, 1);
  const strict = buildResearchCohort({ ...input, requirePayerMapping: true });
  assert.deepEqual(strict.payload.userIds, ["user_mapped"]);
});
test("preserves comparison groups and per-user event anchors", () => {
  const candidates = ["A", "B"].flatMap((group) =>
    [1, 2, 3].map((i) =>
      row(`user_${group}${i}`, {
        group,
        payerId: `cus_${group}${i}`,
        anchorAt: 1799999000000 - i,
      }),
    ),
  );
  const result = buildResearchCohort(spec(candidates));
  assert.equal(result.payload.comparisonGroups.length, 2);
  assert.equal(result.payload.comparisonGroups[0].userIds.length, 3);
  assert.equal(result.payload.samplingMode, "pre_event");
  assert.equal(
    result.payload.evidenceAnchors[0].anchorAt,
    candidates[0].anchorAt,
  );
});
test("does not silently move shared payers across comparison arms", () => {
  const candidates = ["A", "B"].flatMap((group) =>
    [1, 2, 3, 4].map((i) =>
      row(`user_${group}${i}`, {
        group,
        payerId: i === 4 ? "cus_shared" : `cus_${group}${i}`,
      }),
    ),
  );
  const result = buildResearchCohort(spec(candidates));
  assert.equal(result.coverage.conflictingGroups, 2);
  assert.equal(result.payload.userIds.length, 6);
});
test("rejects incomplete cohorts, inconsistent anchors and unauthorized project selections", () => {
  for (const input of [
    { ...spec([row("user_a")]), posthogProjectId: 401167 },
    spec([row("user_a", { fraud: true })]),
    spec([row("user_a", { anchorAt: 1 }), row("user_a", { anchorAt: 2 })]),
    spec([row("user_a", { anchorAt: 1 }), row("user_b")]),
    spec([row("user_a", { group: "A" }), row("user_b", { group: "B" })]),
    spec([row("person@example.com")]),
  ])
    assert.throws(() => buildResearchCohort(input));
});
