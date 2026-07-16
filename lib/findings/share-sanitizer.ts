type SharedFindingPart = {
  type: "data-shared-finding";
  data: {
    title: string;
    target: string;
    severity: "critical" | "high" | "medium" | "low" | "info";
    cvss_score: number;
  };
};

const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);

const sanitizeFindingToolPart = (part: any): SharedFindingPart | null => {
  const output = part?.output?.result ?? part?.output;
  if (output?.success !== true) return null;

  const title = output.title;
  const target = output.target;
  const severity = output.severity;
  const cvssScore = output.cvss_score;

  if (
    typeof title !== "string" ||
    title.trim().length === 0 ||
    typeof target !== "string" ||
    target.trim().length === 0 ||
    typeof severity !== "string" ||
    !VALID_SEVERITIES.has(severity) ||
    typeof cvssScore !== "number" ||
    !Number.isFinite(cvssScore) ||
    cvssScore < 0 ||
    cvssScore > 10
  ) {
    return null;
  }

  return {
    type: "data-shared-finding",
    data: {
      title: title.slice(0, 200),
      target: target.slice(0, 1_000),
      severity: severity as SharedFindingPart["data"]["severity"],
      cvss_score: cvssScore,
    },
  };
};

export const sanitizeFindingPartsForShare = (parts: any[]): any[] =>
  parts.flatMap((part) => {
    if (
      part?.type === "dynamic-tool" &&
      part?.toolName === "create_vulnerability_report"
    ) {
      return [];
    }
    if (part?.type !== "tool-create_vulnerability_report") return [part];
    const safePart = sanitizeFindingToolPart(part);
    return safePart ? [safePart] : [];
  });
