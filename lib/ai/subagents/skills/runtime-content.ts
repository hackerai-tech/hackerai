// These are upstream orchestration/reporting APIs, not HackerAI worker tools.
const UNSUPPORTED_TOOLS = [
  "create_dependency_report",
  "create_vulnerability_report",
  "create_agent",
  "finish_scan",
  "agent_finish",
  "send_message_to_agent",
  "browser_action",
  "terminal_execute",
  "python_execute",
] as const;
const unsupported = new RegExp(`\\b(?:${UNSUPPORTED_TOOLS.join("|")})\\b`);

// An upstream sync must explicitly review adaptations again, rather than applying
// reporting-section rewrites to an unfamiliar revision of a security playbook.
const reviewedSources: Record<string, string> = {
  "custom/dependency_cve_scanning":
    "6cb4cd828172dda4f8fe89282e53b5f1e52bb4738af74876c7b74fa51f2dfdbe",
  "custom/npx_confusion":
    "a024221c836dda755369d5bc8c51fc6dd5735a2b89044d94e446bd6615cc1b61",
  "custom/source_aware_sast":
    "771a0a54471fe23b91049d84593270061d9ff880a7e311b19539e2f8dad7b931",
  "technologies/llm_applications":
    "84dd66db527ace752b958eb2aa84a51fdcaf5144f8fada72f714388b0cafdb99",
};
const contracts: Record<string, string> = {
  "custom/dependency_cve_scanning": `Return separate evidence for each advisory-matched dependency CVE: lockfile and scanner artifacts, package/ecosystem, installed and fixed versions, all affected manifests and all discovered import and affected-symbol call sites with verified repository-relative file:line references, direct introducer and dependency chain, advisory source and published CVSS, reachability/source-to-sink evidence, and limitations. Keep the published advisory severity separate from observed code-path reachability; lack of a dynamic reproduction is not grounds to drop a known dependency CVE. A pinned vulnerable version is static dependency evidence, not proof of a dynamically exploitable application path. Keep dynamically reproduced application chains separate from the dependency candidate. Return every advisory-matched candidate, including incomplete or inconclusive analysis, to the parent with the remaining proof gap; do not silently drop it or treat missing evidence as a negative verdict. The parent decides what to report and how to rate it.`,
  "custom/source_aware_sast": `Return static candidates with source-to-sink traces, controls and counterevidence, scanner coverage/failures and artifact references. Advisory-matched dependency candidates can use lockfile, scanner and advisory evidence without a dynamic exploit claim; load custom/dependency_cve_scanning through the available skill tool when that methodology is needed. Keep dynamic reproductions distinct from static-only candidates.`,
  "custom/npx_confusion": `A namespace-resolution candidate without an advisory-matched CVE is not a dependency-CVE finding. Return the actual package/bin resolution, registry ownership evidence, triggering command/environment, applicable core condition, observed impact and counterevidence to the parent. Do not claim a verified execution path when only a spelling or namespace lead was found.`,
  "technologies/llm_applications": `Return advisory-matched dependency evidence separately from application/model/RAG/agent candidates. Preserve application/model/prompt/tool/corpus versions, baseline and adversarial trial counts, and external observations of authorization, data origin, downstream effects, persistence and consumption. Group evidence by technical root cause and distinguish static analysis, model behavior and dynamically reproduced effects.`,
};

export const hasUnsupportedWorkerToolReference = (content: string): boolean =>
  unsupported.test(content);

/** Check the output structure after removing foreign reporting paragraphs. */
export function hasBalancedCodeFences(content: string): boolean {
  let fence: { marker: string; length: number } | undefined;
  for (const line of content.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    if (!fence) fence = { marker: match[1][0], length: match[1].length };
    else if (
      match[1][0] === fence.marker &&
      match[1].length >= fence.length &&
      match[2].trim() === ""
    )
      fence = undefined;
  }
  return fence === undefined;
}

type RuntimeContentResult =
  | { success: true; content: string; adapted: boolean }
  | { success: false; error: string };

/** Compile only reviewed reporting adaptations; unfamiliar contracts fail closed. */
export function compileSubagentSkillContent(
  skill: { id: string; sourceSha256: string },
  source: string,
): RuntimeContentResult {
  let content = source;
  const expected = reviewedSources[skill.id];
  if (expected) {
    if (skill.sourceSha256 !== expected)
      return {
        success: false,
        error: "Skill runtime adaptation requires source review",
      };
    if (skill.id === "custom/dependency_cve_scanning") {
      // The foreign report schema/CVSS automation is not a worker result schema.
      const start = content.indexOf("## Reporting\n");
      const end = content.indexOf("## Anti-patterns\n", start);
      if (start < 0 || end < 0)
        return { success: false, error: "Skill reporting section changed" };
      content = content.slice(0, start) + content.slice(end);
      const usageStart = content.indexOf(
        "Every CVE you report carries a verdict",
      );
      const verdictStart = content.indexOf("- **`reachable`**", usageStart);
      if (usageStart < 0 || verdictStart < 0)
        return { success: false, error: "Skill reachability section changed" };
      content =
        content.slice(0, usageStart) +
        `Assess each advisory separately and return the evidence to the parent. Use the following code-path distinctions only when supported. For incomplete or inconclusive analysis, return unknown with the missing evidence and searches attempted; do not force a verdict.

` +
        content.slice(verdictStart);
      content = content.replace(
        "; or the only code that could use it cannot be inspected (a compiled\n  blob, a private bundle with no source) and nothing you can inspect reaches\n  it. Evidence: the search scope and the negative result.",
        ". Evidence: the search scope and the negative result.\n\nIf code cannot be inspected, dynamic loading is unresolved, or a transitive dependency chain cannot be traced, preserve that as unknown rather than evidence of non-applicability.",
      );
      content = content.replace(
        "### Reachability is a verdict on the code path, not on severity",
        "",
      );
      const budgetStart = content.indexOf("Work in severity order");
      // The heading was removed above; the remaining budget paragraph ends at
      // the severity guidance, which is removed with foreign reporting prose.
      const budgetParagraphEnd = content.indexOf("\n\n", budgetStart);
      if (budgetStart < 0 || budgetParagraphEnd < 0)
        return {
          success: false,
          error: "Skill analysis budget section changed",
        };
      content =
        content.slice(0, budgetStart) +
        "Prioritize critical, high and KEV advisories. Return every advisory-matched candidate to the parent, including unfinished analysis, with its scanner/lockfile evidence, searches performed and remaining proof gap. Never guess a verdict or treat an uninspected dependency as safe." +
        content.slice(budgetParagraphEnd);
      content = content
        .replaceAll("`reachability_evidence`", "the returned evidence")
        .replace(
          "the contextual CVSS carries that.",
          "the parent evaluates contextual severity from that evidence.",
        );
      content = content.replace(
        "contains it, then pass to `create_dependency_report`:",
        "contains it, then return the introducer and resolution path as evidence to the parent:",
      );
    }
    // At these pinned revisions the remaining references are prose paragraphs,
    // not scanner commands. Their reporting intent is retained in the contract.
    content = content
      .split(/\n\s*\n/)
      .filter((paragraph) => !hasUnsupportedWorkerToolReference(paragraph))
      .join("\n\n");
    // These sections can lose their entire body with the foreign APIs at the
    // reviewed revisions. Keep sections that still have content.
    content = content.replace(
      /^#{2,3} (?:Why this skill exists|Reachability is a confidence modifier, not a gate|Anti-patterns|High-Signal Patterns|Reproducibility and Reporting)(?:\n\s*)?(?=^#{1,3} |$(?![\s\S]))/gm,
      "",
    );
    if (!hasBalancedCodeFences(content))
      return {
        success: false,
        error: "Skill adaptation left an incomplete code block",
      };
    content += `\n\n## HackerAI worker result contract\n\n${contracts[skill.id]}\nUse the active profile's provided tools and final-result schema. Return evidence to the parent; do not create reports, delegate workers, or expand the assigned scope.`;
  }
  if (hasUnsupportedWorkerToolReference(content))
    return {
      success: false,
      error: "Skill references an unsupported worker tool",
    };
  return { success: true, content, adapted: Boolean(expected) };
}
