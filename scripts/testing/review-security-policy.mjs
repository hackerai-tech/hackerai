import { selectPlan } from "./ci-plan.mjs";

export const POLICY_CHECK = "Review and security";
export const CODE_RABBIT_APP = 347564;
export const ACTIONS_APP = 15368;
export const ANALYSIS_KEY = ".github/workflows/test.yml:codeql";
const bot = (author) =>
  ["coderabbitai", "coderabbitai[bot]"].includes(author?.login) &&
  ["Bot", "bot"].includes(author?.type ?? author?.__typename);
const high = (alert) =>
  ["high", "critical"].includes(alert.rule?.security_severity_level);
const result = (state, reason) => ({ state, reason });
const validPath = (path) =>
  typeof path === "string" &&
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.split("/").includes("..");

/** Only inert engineering Markdown can bypass review; runtime prompts cannot. */
export function documentationOnly(paths) {
  return (
    paths.length > 0 &&
    paths.every(
      (path) =>
        /\.md$/.test(path) &&
        (!path.includes("/") ||
          path.startsWith("docs/") ||
          (path.startsWith(".agents/") && !path.includes("/scripts/"))),
    )
  );
}

/** Include both sides of a rename and use the PR tree, never the base checkout's existence. */
export function planFromFiles(files, expectedCount) {
  if (
    !Array.isArray(files) ||
    files.length !== expectedCount ||
    files.length === 0 ||
    files.length > 3000
  )
    throw new Error("Incomplete PR file inventory");
  const existence = new Map();
  for (const file of files) {
    if (
      !validPath(file.filename) ||
      ![
        "added",
        "modified",
        "removed",
        "renamed",
        "copied",
        "changed",
        "unchanged",
      ].includes(file.status)
    )
      throw new Error("Invalid PR file inventory");
    existence.set(file.filename, file.status !== "removed");
    if (file.status === "renamed") {
      if (!validPath(file.previous_filename))
        throw new Error("Incomplete rename");
      existence.set(file.previous_filename, false);
    }
  }
  const paths = [...existence.keys()];
  return {
    paths,
    docsOnly: documentationOnly(paths),
    plan: selectPlan(paths, { exists: (path) => existence.get(path) === true }),
  };
}

/** Provider-authenticated, exact-head receipt: neutral/skipped/old results never count. */
export function reviewResult(head, checks, reviews, threads) {
  const runs = checks
    .filter(
      (check) =>
        check.name === "CodeRabbit" &&
        check.app?.id === CODE_RABBIT_APP &&
        check.head_sha === head,
    )
    .sort((a, b) => b.id - a.id);
  const latest = runs[0];
  if (!latest || latest.status !== "completed")
    return result(
      "pending",
      "Waiting for CodeRabbit to review the current commit.",
    );
  if (latest.conclusion !== "success")
    return result(
      "fail",
      "CodeRabbit did not complete an actual successful review of the current commit.",
    );
  const formal = reviews.some(
    (review) =>
      bot(review.user) &&
      review.commit_id === head &&
      ["COMMENTED", "APPROVED"].includes(review.state) &&
      review.body?.includes("<!-- coderabbit-review-publication "),
  );
  const receipt = latest.output?.summary
    ?.trimStart()
    .startsWith("Result: Success - Review completed");
  if (!formal && !receipt)
    return result(
      "fail",
      "CodeRabbit completion receipt is unrecognized; review cannot be verified.",
    );
  const decisions = reviews
    .filter(
      (review) =>
        bot(review.user) &&
        ["APPROVED", "CHANGES_REQUESTED"].includes(review.state),
    )
    .sort((a, b) => b.id - a.id);
  if (decisions[0]?.state === "CHANGES_REQUESTED")
    return result("fail", "CodeRabbit still requests changes.");
  if (
    threads.some(
      (thread) =>
        !thread.isResolved && bot(thread.comments?.nodes?.[0]?.author),
    )
  )
    return result("fail", "Unresolved CodeRabbit review threads remain.");
  return result(
    "pass",
    "Actual CodeRabbit review verified for the current commit.",
  );
}

/** Require processed current-merge analyses before judging PR-scoped new findings. */
export function securityResult(
  mergeSha,
  languages,
  analyses,
  alerts,
  baseline,
) {
  if (!languages.length)
    return result("skip", "No security scan is selected for these paths.");
  if (!/^[a-f0-9]{40}$/.test(mergeSha ?? ""))
    return result("pending", "Waiting for the current test merge commit.");
  for (const language of languages) {
    const latest = analyses
      .filter(
        (analysis) =>
          analysis.commit_sha === mergeSha &&
          analysis.category === `/language:${language}` &&
          analysis.analysis_key === ANALYSIS_KEY &&
          analysis.tool?.name === "CodeQL",
      )
      .sort((a, b) => b.id - a.id)[0];
    if (!latest)
      return result(
        "pending",
        "Waiting for all selected CodeQL reports for the current test merge.",
      );
    if (latest.error || !(latest.rules_count > 0))
      return result(
        "fail",
        "A selected CodeQL analysis failed or ran no queries.",
      );
  }
  const existing = new Set(
    baseline
      .filter((alert) => alert.state === "open" && high(alert))
      .map((alert) => `${alert.number}:${alert.rule.id}`),
  );
  for (const alert of alerts) {
    if (alert.state !== "open" || !high(alert)) continue;
    if (existing.has(`${alert.number}:${alert.rule.id}`)) continue;
    if (alert.most_recent_instance?.commit_sha !== mergeSha)
      return result(
        "pending",
        "A high/critical finding is not yet tied to the current test merge.",
      );
    return result(
      "fail",
      `New high/critical CodeQL finding blocks merge: #${alert.number}.`,
    );
  }
  return result(
    "pass",
    "No new high/critical CodeQL findings in the selected scans.",
  );
}

export function policyResult(review, security) {
  const states = [review.state, security.state];
  return {
    state: states.includes("fail")
      ? "failure"
      : states.includes("pending")
        ? "pending"
        : "success",
    review,
    security,
  };
}
