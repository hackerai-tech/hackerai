import test from "node:test";
import assert from "node:assert/strict";
import {
  ANALYSIS_KEY,
  CODE_RABBIT_APP,
  ACTIONS_APP,
  planFromFiles,
  reviewResult,
  securityResult,
  policyResult,
  sameTestMerge,
} from "./review-security-policy.mjs";
import {
  evaluatePullRequest,
  resolvePullRequests,
  githubClient,
  pages,
  mergeAliases,
} from "./review-security.mjs";

const head = "a".repeat(40),
  merge = "b".repeat(40),
  base = "c".repeat(40);
const receipt = {
  id: 10,
  name: "CodeRabbit",
  app: { id: CODE_RABBIT_APP },
  head_sha: head,
  status: "completed",
  conclusion: "success",
  output: { summary: "Result: Success - Review completed\nRun ID: example" },
};
const scan = {
  id: 11,
  name: "CodeQL (javascript-typescript)",
  app: { id: ACTIONS_APP },
  head_sha: head,
  status: "completed",
  conclusion: "success",
};
const analysis = (language = "javascript-typescript") => ({
  id: 20,
  commit_sha: merge,
  category: `/language:${language}`,
  analysis_key: ANALYSIS_KEY,
  tool: { name: "CodeQL" },
  rules_count: 87,
  error: "",
});
const alert = (number, severity, commit = merge) => ({
  number,
  state: "open",
  rule: { id: "js/command-line-injection", security_severity_level: severity },
  most_recent_instance: { commit_sha: commit },
});

test("only authenticated current-code reviews pass, including the provider's check-only integration", () => {
  assert.equal(reviewResult(head, [receipt], [], []).state, "pass");
  for (const checks of [
    [],
    [{ ...receipt, head_sha: base }],
    [{ ...receipt, app: { id: ACTIONS_APP } }],
    [{ ...receipt, conclusion: "skipped" }],
    [{ ...receipt, conclusion: "neutral" }],
    [
      {
        ...receipt,
        output: { summary: "Rate limit reached; no review performed" },
      },
    ],
    [receipt, { ...receipt, id: 11, status: "in_progress", conclusion: null }],
  ]) {
    assert.notEqual(reviewResult(head, checks, [], []).state, "pass");
  }
  assert.equal(
    reviewResult(
      head,
      [{ ...receipt, output: {} }],
      [
        {
          id: 1,
          user: { login: "coderabbitai[bot]", type: "Bot" },
          commit_id: head,
          state: "COMMENTED",
          body: "<!-- coderabbit-review-publication v1 -->",
        },
      ],
      [],
    ).state,
    "pass",
  );
  assert.equal(
    reviewResult(
      head,
      [{ ...receipt, output: {} }],
      [
        {
          id: 1,
          user: { login: "coderabbitai[bot]", type: "Bot" },
          commit_id: head,
          state: "COMMENTED",
          body: "",
        },
      ],
      [],
    ).state,
    "fail",
  );
});

test("outdated unresolved bot threads and active change requests still block a successful receipt", () => {
  const thread = {
    isResolved: false,
    isOutdated: true,
    comments: {
      nodes: [{ author: { login: "coderabbitai", __typename: "Bot" } }],
    },
  };
  assert.equal(reviewResult(head, [receipt], [], [thread]).state, "fail");
  assert.equal(
    reviewResult(head, [receipt], [], [{ ...thread, isResolved: true }]).state,
    "pass",
  );
  const request = {
    id: 12,
    state: "CHANGES_REQUESTED",
    user: { login: "coderabbitai[bot]", type: "Bot" },
  };
  assert.equal(reviewResult(head, [receipt], [request], []).state, "fail");
  assert.equal(
    reviewResult(
      head,
      [receipt],
      [request, { ...request, id: 13, state: "APPROVED" }],
      [],
    ).state,
    "pass",
  );
});

test("current selected analyses and new high/critical findings are distinct from legacy/medium findings", () => {
  const languages = ["javascript-typescript", "rust"];
  const analyses = [analysis(), analysis("rust")];
  assert.equal(
    securityResult(merge, languages, analyses, [], []).state,
    "pass",
  );
  assert.equal(
    securityResult(merge, languages, [analysis()], [], []).state,
    "pending",
  );
  assert.equal(
    securityResult(
      merge,
      languages,
      analyses.map((a) => ({ ...a, commit_sha: base })),
      [],
      [],
    ).state,
    "pending",
  );
  assert.equal(
    securityResult(
      merge,
      languages,
      [{ ...analysis(), error: "failure" }, analysis("rust")],
      [],
      [],
    ).state,
    "fail",
  );
  assert.equal(
    securityResult(
      merge,
      languages,
      [{ ...analysis(), rules_count: 0 }, analysis("rust")],
      [],
      [],
    ).state,
    "fail",
  );
  for (const severity of ["high", "critical"]) {
    assert.equal(
      securityResult(merge, languages, analyses, [alert(5, severity)], [])
        .state,
      "fail",
    );
  }
  assert.equal(
    securityResult(merge, languages, analyses, [alert(5, "medium")], []).state,
    "pass",
  );
  assert.equal(
    securityResult(
      merge,
      languages,
      analyses,
      [alert(5, "high")],
      [alert(5, "high", base)],
    ).state,
    "pass",
  );
  assert.equal(
    securityResult(merge, languages, analyses, [alert(5, "high", base)], [])
      .state,
    "pending",
  );
  assert.equal(securityResult(null, [], [], [], []).state, "skip");
  assert.equal(
    policyResult({ state: "pending" }, { state: "fail" }).state,
    "failure",
  );
});

test("docs skip review, while executable skills, runtime prompts, removed code and renamed code do not", () => {
  assert.equal(
    planFromFiles([{ filename: "docs/guide.md", status: "modified" }], 1)
      .docsOnly,
    true,
  );
  assert.equal(
    planFromFiles(
      [{ filename: "lib/ai/subagents/skills/prompt.md", status: "modified" }],
      1,
    ).docsOnly,
    false,
  );
  assert.equal(
    planFromFiles(
      [
        {
          filename: ".agents/skills/hackerai-user-research/scripts/tool.mjs",
          status: "modified",
        },
      ],
      1,
    ).docsOnly,
    false,
  );
  assert.equal(
    planFromFiles(
      [
        {
          filename: "docs/guide.md",
          previous_filename: "app/view.tsx",
          status: "renamed",
        },
      ],
      1,
    ).docsOnly,
    false,
  );
  assert.equal(
    planFromFiles([{ filename: "app/new.tsx", status: "added" }], 1).plan.jest,
    "related",
  );
  assert.equal(
    planFromFiles([{ filename: "app/deleted.tsx", status: "removed" }], 1).plan
      .jest,
    "full",
  );
  assert.throws(() => planFromFiles([], 1));
});

function fixture({
  files = [{ filename: "app/page.tsx", status: "modified" }],
  checks = [receipt, scan],
  alerts = [],
  baseline = [],
  analyses = [analysis()],
  failMetadata = false,
  changeHead = false,
  changeMerge = false,
  sameMergeTree = false,
  failChecks = false,
  failFinalRead = false,
  headRepo = "o/r",
} = {}) {
  const writes = [];
  let reads = 0;
  const pr = {
    number: 1,
    state: "open",
    changed_files: files.length,
    head: { sha: head, repo: { full_name: headRepo } },
    base: { ref: "main", sha: base },
    merge_commit_sha: merge,
  };
  const api = async (path, method = "GET", body) => {
    if (method !== "GET" && path !== "/graphql") {
      writes.push({ path, method, body });
      return { id: 50 };
    }
    if (path === "/repos/o/r/pulls/1") {
      reads++;
      if (failFinalRead && reads > 1) throw new Error("read unavailable");
      if (changeMerge && reads > 1)
        return { ...pr, merge_commit_sha: "d".repeat(40) };
      return changeHead && reads > 1 ? { ...pr, head: { sha: base } } : pr;
    }
    if (path.includes("/git/commits/"))
      return {
        tree: {
          sha:
            path.endsWith(merge) || sameMergeTree
              ? "e".repeat(40)
              : "f".repeat(40),
        },
        parents: [{ sha: base }, { sha: head }],
      };
    if (path.includes("/check-runs?")) {
      if (failChecks) throw new Error("check unavailable");
      return { check_runs: checks };
    }
    if (path.includes("/files?")) {
      if (failMetadata) throw new Error("private-sentinel");
      return files;
    }
    if (path.includes("/analyses?")) return analyses;
    if (path.includes("/alerts?pr=")) return alerts;
    if (path.includes("/alerts?ref=")) return baseline;
    throw new Error("Unexpected fixture request");
  };
  return { api, writes };
}

test("live orchestration publishes docs skips, fails closed on metadata failure and cannot pass a changed head", async () => {
  const docs = fixture({
    files: [{ filename: "README.md", status: "modified" }],
  });
  assert.equal(
    (await evaluatePullRequest(docs.api, "o/r", 1)).state,
    "success",
  );
  assert.equal(docs.writes.at(-1).body.state, "success");
  const unavailable = fixture({ failMetadata: true });
  assert.equal(
    (await evaluatePullRequest(unavailable.api, "o/r", 1)).state,
    "failure",
  );
  assert.equal(unavailable.writes[0].body.state, "pending");
  assert.equal(unavailable.writes.at(-1).body.state, "failure");
  assert.ok(!JSON.stringify(unavailable.writes).includes("private-sentinel"));
  const race = fixture({
    files: [{ filename: "README.md", status: "modified" }],
    changeHead: true,
  });
  assert.equal(
    (await evaluatePullRequest(race.api, "o/r", 1)).state,
    "pending",
  );
  assert.equal(race.writes.at(-1).body.state, "pending");
});

test("orchestration blocks a finding even when the scanner job and review succeed", async () => {
  const clean = fixture();
  assert.equal(
    (await evaluatePullRequest(clean.api, "o/r", 1)).state,
    "success",
  );
  const vulnerable = fixture({ alerts: [alert(99, "critical")] });
  const blocked = await evaluatePullRequest(vulnerable.api, "o/r", 1);
  assert.equal(blocked.state, "failure");
  assert.match(blocked.security.reason, /#99/);
  assert.equal(vulnerable.writes.at(-1).body.state, "failure");
  for (const options of [
    { analyses: [] },
    { checks: [receipt] },
    { checks: [receipt, { ...scan, conclusion: "failure" }] },
  ]) {
    const f = fixture(options);
    assert.notEqual(
      (await evaluatePullRequest(f.api, "o/r", 1)).state,
      "success",
    );
  }
  const legacy = fixture({
    alerts: [alert(15, "high", base)],
    baseline: [alert(15, "high", base)],
  });
  assert.equal(
    (await evaluatePullRequest(legacy.api, "o/r", 1)).state,
    "success",
  );
  const pending = fixture({ checks: [receipt] });
  assert.equal(
    (await evaluatePullRequest(pending.api, "o/r", 1)).state,
    "pending",
  );
  assert.match(
    pending.writes.at(-1).body.description,
    /^Waiting for the selected CodeQL jobs/,
  );
});

test("fresh pending statuses replace old passes before metadata reads; same-name jobs cannot approve code", async () => {
  for (const options of [{ failChecks: true }, { failFinalRead: true }]) {
    const f = fixture(options);
    assert.equal((await evaluatePullRequest(f.api, "o/r", 1)).state, "failure");
    assert.equal(f.writes[0].path, `/repos/o/r/statuses/${head}`);
    assert.equal(f.writes[0].body.state, "pending");
    assert.equal(f.writes.at(-1).body.state, "failure");
  }
  const spoof = fixture({
    checks: [receipt, { ...scan, name: "Review and security" }],
  });
  assert.notEqual(
    (await evaluatePullRequest(spoof.api, "o/r", 1)).state,
    "success",
  );
  const fork = fixture({
    files: [{ filename: ".github/workflows/test.yml", status: "modified" }],
    headRepo: "fork/r",
  });
  assert.equal(
    (await evaluatePullRequest(fork.api, "o/r", 1)).state,
    "failure",
  );
  const safeFork = fixture({ headRepo: "fork/r" });
  assert.equal(
    (await evaluatePullRequest(safeFork.api, "o/r", 1)).state,
    "success",
  );
});

test("a changed test merge cannot pass when the PR head and reported base SHA stay unchanged", async () => {
  const changed = fixture({ changeMerge: true });
  assert.equal(
    (await evaluatePullRequest(changed.api, "o/r", 1)).state,
    "pending",
  );
  assert.equal(changed.writes.at(-1).body.state, "pending");
  const docs = fixture({
    changeMerge: true,
    files: [{ filename: "README.md", status: "modified" }],
  });
  assert.equal(
    (await evaluatePullRequest(docs.api, "o/r", 1)).state,
    "success",
  );
});

test("event routing handles current and late provider/CI events but ignores unrelated checks", async () => {
  const api = async () => [{ number: 7 }];
  assert.deepEqual(
    await resolvePullRequests(api, "o/r", "check_run", {
      check_run: { app: { id: CODE_RABBIT_APP }, head_sha: base },
    }),
    [7],
  );
  assert.deepEqual(
    await resolvePullRequests(api, "o/r", "check_run", {
      check_run: { app: { id: ACTIONS_APP }, head_sha: head },
    }),
    [],
  );
  assert.deepEqual(
    await resolvePullRequests(api, "o/r", "issue_comment", {
      issue: { number: 7 },
    }),
    [],
  );
  assert.deepEqual(
    await resolvePullRequests(api, "o/r", "issue_comment", {
      issue: { number: 7, pull_request: {} },
    }),
    [7],
  );
  await assert.rejects(
    resolvePullRequests(api, "o/r", "workflow_dispatch", {
      inputs: { pr_number: "7;bad" },
    }),
  );
});

test("collections are paginated; provider failures never echo credentials or response text", async () => {
  let calls = 0;
  const rows = await pages(
    async () => (++calls === 1 ? Array(100).fill({}) : [{}]),
    "/test",
  );
  assert.equal(rows.length, 101);
  const api = githubClient(
    "private-token",
    async () => new Response("private-token provider failure", { status: 403 }),
  );
  await assert.rejects(
    api("/test"),
    (error) => !error.message.includes("private-token"),
  );
  await assert.rejects(api("//elsewhere"));
});

test("regenerated test merges reuse scans only with the exact tree and ordered current parents", async () => {
  const pr = {
    base: { sha: base },
    head: { sha: head },
    merge_commit_sha: merge,
  };
  const commit = {
    tree: { sha: "e".repeat(40) },
    parents: [{ sha: base }, { sha: head }],
  };
  assert.equal(sameTestMerge(pr, commit, structuredClone(commit)), true);
  for (const changed of [
    { ...commit, tree: { sha: "f".repeat(40) } },
    { ...commit, parents: [{ sha: head }, { sha: base }] },
    { ...commit, parents: [{ sha: merge }, { sha: head }] },
    { ...commit, parents: [{ sha: base }] },
    { ...commit, tree: {} },
  ])
    assert.equal(sameTestMerge(pr, commit, changed), false);
  const alias = "d".repeat(40),
    unrelated = "f".repeat(40);
  const aliases = await mergeAliases(
    async (path) =>
      path.endsWith(unrelated)
        ? { ...commit, parents: [{ sha: head }] }
        : commit,
    "/repos/o/r",
    pr,
    [{ commit_sha: alias }, { commit_sha: unrelated }],
  );
  assert.deepEqual([...aliases], [merge, alias]);
});

test("live policy accepts identical scan aliases but never an aliased critical finding or changed merge tree", async () => {
  const alias = "d".repeat(40);
  for (const options of [
    { changeMerge: true, sameMergeTree: true },
    { analyses: [{ ...analysis(), commit_sha: alias }], sameMergeTree: true },
  ])
    assert.equal(
      (await evaluatePullRequest(fixture(options).api, "o/r", 1)).state,
      "success",
    );
  const blocked = await evaluatePullRequest(
    fixture({
      analyses: [{ ...analysis(), commit_sha: alias }],
      sameMergeTree: true,
      alerts: [alert(99, "critical", alias)],
    }).api,
    "o/r",
    1,
  );
  assert.equal(blocked.state, "failure");
  assert.match(blocked.security.reason, /#99/);
  assert.equal(
    (
      await evaluatePullRequest(
        fixture({
          analyses: [{ ...analysis(), commit_sha: alias }],
        }).api,
        "o/r",
        1,
      )
    ).state,
    "pending",
  );
});

test("CodeRabbit availability is advisory while selected security evidence remains mandatory", async () => {
  for (const reviewChecks of [
    [],
    [{ ...receipt, status: "in_progress", conclusion: null }],
    [{ ...receipt, conclusion: "skipped" }],
    [
      {
        ...receipt,
        conclusion: "neutral",
        output: { summary: "Rate limited" },
      },
    ],
    [{ ...receipt, conclusion: "failure" }],
  ]) {
    const f = fixture({ checks: [scan, ...reviewChecks] });
    assert.equal((await evaluatePullRequest(f.api, "o/r", 1)).state, "success");
    assert.match(f.writes.at(-1).body.description, /CodeRabbit.*advisory/);
    assert.equal(
      (
        await evaluatePullRequest(
          fixture({
            checks: [scan, ...reviewChecks],
            alerts: [alert(99, "critical")],
          }).api,
          "o/r",
          1,
        )
      ).state,
      "failure",
    );
  }
});
