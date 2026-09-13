const SKILL_ACRONYMS: Readonly<Record<string, string>> = {
  api: "API",
  aws: "AWS",
  csrf: "CSRF",
  gcp: "GCP",
  idor: "IDOR",
  jwt: "JWT",
  llm: "LLM",
  npx: "npx",
  oauth: "OAuth",
  saml: "SAML",
  sqli: "SQLi",
  ssrf: "SSRF",
  xss: "XSS",
  xxe: "XXE",
};

const specialistSkills = (skills: readonly string[]): string[] =>
  skills.filter((skill) => skill !== "security_validation");

export const formatSubagentSkillLabel = (skillId: string): string => {
  const name = skillId.split("/").at(-1) ?? skillId;
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((word, index) => {
      const normalized = word.toLowerCase();
      return (
        SKILL_ACRONYMS[normalized] ??
        (index === 0
          ? normalized.charAt(0).toUpperCase() + normalized.slice(1)
          : normalized)
      );
    })
    .join(" ");
};

export const SubagentSkillBadges = ({
  skills = [],
}: {
  skills?: readonly string[];
}) => {
  const assignedSkills = specialistSkills(skills);
  if (assignedSkills.length === 0) return null;

  return (
    <section className="min-w-0" aria-label="Assigned skills">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Skills <span aria-hidden>·</span>{" "}
        <span className="tabular-nums">{assignedSkills.length}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {assignedSkills.map((skill) => (
          <span
            key={skill}
            title={`${formatSubagentSkillLabel(skill)} · Included when this specialist started`}
            className="inline-flex max-w-full items-center rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
          >
            {formatSubagentSkillLabel(skill)}
          </span>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Included when this specialist started.
      </p>
    </section>
  );
};
