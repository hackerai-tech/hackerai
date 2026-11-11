import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ACTIONS_APP,
  CODE_RABBIT_APP,
  POLICY_CHECK,
  planFromFiles,
  reviewResult,
  securityResult,
  policyResult,
  sameTestMerge,
} from "./review-security-policy.mjs";

/** Only exact tree+ordered-parent aliases can stand in for a regenerated test merge. */
export async function mergeAliases(api, root, pr, analyses) {
  const aliases = new Set([pr.merge_commit_sha]);
  const candidates = [...new Set(analyses.map((item) => item.commit_sha))]
    .filter(
      (sha) => /^[a-f0-9]{40}$/.test(sha ?? "") && sha !== pr.merge_commit_sha,
    )
    .slice(0, 20);
  if (!candidates.length) return aliases;
  const current = await api(`${root}/git/commits/${pr.merge_commit_sha}`);
  for (const sha of candidates) {
    const previous = await api(`${root}/git/commits/${sha}`);
    if (sameTestMerge(pr, current, previous)) aliases.add(sha);
  }
  return aliases;
}

const pageSize = 100;
const validNumber = (value) =>
  Number.isSafeInteger(Number(value)) &&
  Number(value) > 0 &&
  Number(value) <= 2147483647;

/** Token stays in process memory; neither HTTP bodies nor provider errors are logged. */
export function githubClient(token, fetcher = fetch) {
  return async (path, method = "GET", body) => {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error("Invalid GitHub API path");
    const response = await fetcher(`https://api.github.com${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error("GitHub metadata request failed");
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("GitHub response exceeded its bound");
      }
      chunks.push(Buffer.from(part.value));
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (data.errors) throw new Error("GitHub GraphQL request failed");
    return data;
  };
}

export async function pages(api, path, field) {
  const rows = [];
  for (let page = 1; page <= 40; page++) {
    const data = await api(
      `${path}${path.includes("?") ? "&" : "?"}per_page=${pageSize}&page=${page}`,
    );
    const items = field ? data[field] : data;
    if (!Array.isArray(items)) throw new Error("Invalid GitHub collection");
    rows.push(...items);
    if (items.length < pageSize) return rows;
  }
  throw new Error("GitHub pagination is incomplete");
}

/** Events are wake-ups only: each serialized evaluation reads the current PR. */
export async function resolvePullRequests(api, repo, eventName, event) {
  let candidates = [];
  if (eventName === "workflow_dispatch") {
    if (!validNumber(event.inputs?.pr_number))
      throw new Error("Invalid PR number");
    candidates = [Number(event.inputs.pr_number)];
  } else if (eventName === "pull_request_target") candidates = [event.number];
  else if (eventName === "issue_comment" && event.issue?.pull_request)
    candidates = [event.issue.number];
  else {
    const check = eventName === "check_run" ? event.check_run : null;
    if (check && ![CODE_RABBIT_APP, 57789].includes(check.app?.id)) return [];
    const run = eventName === "workflow_run" ? event.workflow_run : check;
    if (!run) return [];
    if (eventName === "workflow_run" && run.event === "merge_group") return [];
    if (
      eventName === "workflow_run" &&
      run.path !== ".github/workflows/test.yml"
    )
      return [];
    const attached = run.pull_requests ?? run.check_suite?.pull_requests ?? [];
    if (attached.length) candidates = attached.map((pr) => pr.number);
    else {
      if (!/^[a-f0-9]{40}$/.test(run.head_sha ?? ""))
        throw new Error("Invalid event commit");
      candidates = (
        await pages(api, `/repos/${repo}/commits/${run.head_sha}/pulls`)
      ).map((pr) => pr.number);
    }
  }
  if (candidates.some((number) => !validNumber(number)))
    throw new Error("Invalid PR number");
  return [...new Set(candidates.map(Number))];
}

const queueLanguages = [
  "actions",
  "go",
  "javascript-typescript",
  "python",
  "rust",
];
const queueBranch = /^gh-readonly-queue\/main\/pr-[\w-]+$/;

/** The queue head is the latest combined tree; this status is attached to that SHA. */
export async function evaluateMergeGroup(
  api,
  repo,
  run,
  { publish = true, detailsUrl = "https://github.com" } = {},
) {
  const root = `/repos/${repo}`;
  if (
    run?.event !== "merge_group" ||
    run.path !== ".github/workflows/test.yml" ||
    run.repository?.full_name !== repo ||
    !queueBranch.test(run.head_branch ?? "") ||
    !/^[a-f0-9]{40}$/.test(run.head_sha ?? "")
  )
    throw new Error("Invalid merge-group CI run");
  const head = run.head_sha;
  const ref = encodeURIComponent(`refs/heads/${run.head_branch}`);
  let decision;
  if (run.status !== "completed" || run.conclusion !== "success") {
    decision = {
      state: run.status === "completed" ? "failure" : "pending",
      reason: "Merge-group CI did not pass.",
    };
  } else {
    const [analyses, alerts, baseline] = await Promise.all([
      pages(api, `${root}/code-scanning/analyses?ref=${ref}&tool_name=CodeQL`),
      pages(
        api,
        `${root}/code-scanning/alerts?ref=${ref}&state=open&tool_name=CodeQL`,
      ),
      pages(
        api,
        `${root}/code-scanning/alerts?ref=${encodeURIComponent("refs/heads/main")}&state=open&tool_name=CodeQL`,
      ),
    ]);
    const security = securityResult(
      head,
      queueLanguages,
      analyses,
      alerts,
      baseline,
    );
    decision = {
      state:
        security.state === "pass"
          ? "success"
          : security.state === "fail"
            ? "failure"
            : "pending",
      reason: security.reason,
    };
  }
  if (publish)
    await publishStatus(
      api,
      root,
      head,
      decision.state,
      detailsUrl,
      decision.reason,
    );
  return decision;
}

/** Commit statuses cannot be forged by naming a read-only PR Actions job. */
async function publishStatus(api, root, head, state, detailsUrl, description) {
  return api(`${root}/statuses/${head}`, "POST", {
    context: POLICY_CHECK,
    state,
    target_url: detailsUrl,
    description: description.slice(0, 140),
  });
}

export async function evaluatePullRequest(
  api,
  repo,
  number,
  { publish = true, detailsUrl = "https://github.com" } = {},
) {
  const root = `/repos/${repo}`;
  const pr = await api(`${root}/pulls/${number}`);
  if (pr.state !== "open" || pr.base?.ref !== "main") return null;
  if (!/^[a-f0-9]{40}$/.test(pr.head?.sha ?? ""))
    throw new Error("Invalid PR head");
  if (publish)
    await publishStatus(
      api,
      root,
      pr.head.sha,
      "pending",
      detailsUrl,
      "Verifying selected security evidence; CodeRabbit is advisory.",
    );
  let decision;
  try {
    const checks = await pages(
      api,
      `${root}/commits/${pr.head.sha}/check-runs?filter=all`,
      "check_runs",
    );
    const files = await pages(api, `${root}/pulls/${number}/files`);
    const { docsOnly, plan, paths } = planFromFiles(files, pr.changed_files);
    if (
      pr.head.repo?.full_name !== repo &&
      paths.some(
        (path) => path.startsWith(".github/") || /^\.coderabbit[./]/.test(path),
      )
    ) {
      decision = policyResult(
        {
          state: "fail",
          reason:
            "Fork CI/review configuration changes require a maintainer branch.",
        },
        {
          state: "fail",
          reason:
            "Run the changed scan policy from a trusted maintainer branch.",
        },
      );
    } else if (docsOnly) {
      decision = policyResult(
        {
          state: "skip",
          reason:
            "Inert documentation-only change; code review intentionally not required.",
        },
        {
          state: "skip",
          reason:
            "Documentation-only change; security scans intentionally not selected.",
        },
      );
    } else {
      // Review is informational only. Do not depend on review/thread API availability.
      const review = reviewResult(pr.head.sha, checks, [], []);
      let security;
      if (!plan.languages.length)
        security = securityResult(pr.merge_commit_sha, [], [], [], []);
      else {
        const selected = plan.languages.map(
          (language) =>
            checks
              .filter(
                (item) =>
                  item.app?.id === ACTIONS_APP &&
                  item.head_sha === pr.head.sha &&
                  item.name === `CodeQL (${language})`,
              )
              .sort((a, b) => b.id - a.id)[0],
        );
        if (
          selected.some(
            (run) =>
              run?.status === "completed" && run.conclusion !== "success",
          )
        )
          security = {
            state: "fail",
            reason: "A selected CodeQL job did not succeed.",
          };
        else if (selected.some((run) => !run || run.status !== "completed"))
          security = {
            state: "pending",
            reason:
              "Waiting for the selected CodeQL jobs to complete successfully.",
          };
        else {
          const ref = encodeURIComponent(`refs/pull/${number}/merge`);
          const [analyses, alerts, baseline] = await Promise.all([
            pages(
              api,
              `${root}/code-scanning/analyses?ref=${ref}&tool_name=CodeQL`,
            ),
            pages(
              api,
              `${root}/code-scanning/alerts?pr=${number}&ref=${ref}&state=open&tool_name=CodeQL`,
            ),
            pages(
              api,
              `${root}/code-scanning/alerts?ref=${encodeURIComponent(`refs/heads/${pr.base.ref}`)}&state=open&tool_name=CodeQL`,
            ),
          ]);
          const aliases = await mergeAliases(api, root, pr, analyses);
          const normalize = (sha) =>
            aliases.has(sha) ? pr.merge_commit_sha : sha;
          security = securityResult(
            pr.merge_commit_sha,
            plan.languages,
            analyses.map((item) => ({
              ...item,
              commit_sha: normalize(item.commit_sha),
            })),
            alerts.map((item) => ({
              ...item,
              most_recent_instance: {
                ...item.most_recent_instance,
                commit_sha: normalize(item.most_recent_instance?.commit_sha),
              },
            })),
            baseline,
          );
        }
      }
      decision = policyResult(review, security);
    }
  } catch {
    decision = policyResult(
      {
        state: "fail",
        reason:
          "Review/security metadata could not be verified; failing closed.",
      },
      {
        state: "fail",
        reason:
          "No successful policy decision can be made from incomplete metadata.",
      },
    );
  }
  try {
    const current = await api(`${root}/pulls/${number}`);
    let mergeChanged =
      decision.security.state !== "skip" &&
      current.merge_commit_sha !== pr.merge_commit_sha;
    if (
      mergeChanged &&
      current.head?.sha === pr.head.sha &&
      current.base?.sha === pr.base.sha
    ) {
      const [first, second] = await Promise.all([
        api(`${root}/git/commits/${pr.merge_commit_sha}`),
        api(`${root}/git/commits/${current.merge_commit_sha}`),
      ]);
      mergeChanged = !sameTestMerge(pr, first, second);
    }
    if (
      current.head?.sha !== pr.head.sha ||
      current.base?.sha !== pr.base.sha ||
      mergeChanged ||
      current.state !== "open"
    )
      decision = policyResult(
        { state: "pending", reason: "PR changed during verification." },
        { state: "pending", reason: "Waiting for a fresh evaluation." },
      );
  } catch {
    decision = policyResult(
      { state: "fail", reason: "Current PR revision could not be verified." },
      { state: "fail", reason: "Waiting for authoritative metadata." },
    );
  }
  if (publish)
    await publishStatus(
      api,
      root,
      pr.head.sha,
      decision.state,
      detailsUrl,
      decision.state === "success"
        ? "Selected security scans passed; CodeRabbit is advisory."
        : decision.security.reason,
    );
  return decision;
}

export async function main(action, env = process.env) {
  const repo = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? ""))
    throw new Error("Invalid repository");
  const token =
    env.GH_TOKEN ??
    env.GITHUB_TOKEN ??
    execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (!token) throw new Error("Missing GitHub authentication");
  const api = githubClient(token);
  if (action === "queue-pending") {
    if (env.GITHUB_EVENT_NAME !== "merge_group")
      throw new Error("Invalid merge-group event");
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const group = event.merge_group;
    if (
      group?.base_ref !== "refs/heads/main" ||
      !queueBranch.test(group.head_ref?.replace(/^refs\/heads\//, "") ?? "") ||
      !/^[a-f0-9]{40}$/.test(group.head_sha ?? "")
    )
      throw new Error("Invalid merge-group identity");
    await publishStatus(
      api,
      `/repos/${repo}`,
      group.head_sha,
      "pending",
      `https://github.com/${repo}/actions/runs/${env.GITHUB_RUN_ID ?? ""}`,
      "Waiting for current merge-group CI and CodeQL analysis.",
    );
    return 0;
  }
  if (action === "queue-evaluate") {
    if (env.GITHUB_EVENT_NAME !== "workflow_run")
      throw new Error("Invalid merge-group CI event");
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    let decision;
    for (let attempt = 0; attempt < 10; attempt++) {
      decision = await evaluateMergeGroup(api, repo, event.workflow_run, {
        publish: false,
      });
      if (
        decision.state !== "pending" ||
        event.workflow_run?.status !== "completed"
      )
        break;
      if (attempt < 9)
        await new Promise((resolve) => setTimeout(resolve, 30000));
    }
    if (decision.state === "pending")
      decision = {
        state: "failure",
        reason:
          "Merge-group scan reports were not available within five minutes.",
      };
    await publishStatus(
      api,
      `/repos/${repo}`,
      event.workflow_run.head_sha,
      decision.state,
      `https://github.com/${repo}/actions/runs/${env.GITHUB_RUN_ID ?? ""}`,
      decision.reason,
    );
    console.log(JSON.stringify(decision));
    return decision.state === "success" ? 0 : 1;
  }
  if (action === "resolve") {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const numbers = await resolvePullRequests(
      api,
      repo,
      env.GITHUB_EVENT_NAME,
      event,
    );
    if (env.GITHUB_OUTPUT)
      appendFileSync(
        env.GITHUB_OUTPUT,
        `prs=${JSON.stringify(numbers.length ? numbers : [0])}\nhas_prs=${numbers.length > 0}\n`,
      );
    console.log(`Resolved ${numbers.length} PR evaluations.`);
    return 0;
  }
  if (action !== "evaluate" || !validNumber(env.PR_NUMBER))
    throw new Error("Invalid policy command");
  const publish = env.POLICY_READ_ONLY !== "true";
  const decision = await evaluatePullRequest(api, repo, Number(env.PR_NUMBER), {
    publish,
    detailsUrl: `https://github.com/${repo}/actions/runs/${env.GITHUB_RUN_ID ?? ""}`,
  });
  if (decision) console.log(JSON.stringify(decision));
  return !publish && decision?.state !== "success" ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exitCode = await main(process.argv[2]);
  } catch {
    console.error(
      "Review/security policy could not complete; no passing result was published.",
    );
    process.exitCode = 1;
  }
}
