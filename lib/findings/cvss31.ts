export const CVSS31_METRIC_VALUES = {
  attack_vector: ["N", "A", "L", "P"],
  attack_complexity: ["L", "H"],
  privileges_required: ["N", "L", "H"],
  user_interaction: ["N", "R"],
  scope: ["U", "C"],
  confidentiality: ["N", "L", "H"],
  integrity: ["N", "L", "H"],
  availability: ["N", "L", "H"],
} as const;

export type Cvss31Breakdown = {
  [
    K in keyof typeof CVSS31_METRIC_VALUES
  ]: (typeof CVSS31_METRIC_VALUES)[K][number];
};

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

const WEIGHTS = {
  attack_vector: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  attack_complexity: { L: 0.77, H: 0.44 },
  user_interaction: { N: 0.85, R: 0.62 },
  confidentiality: { N: 0, L: 0.22, H: 0.56 },
  integrity: { N: 0, L: 0.22, H: 0.56 },
  availability: { N: 0, L: 0.22, H: 0.56 },
  privileges_required: {
    U: { N: 0.85, L: 0.62, H: 0.27 },
    C: { N: 0.85, L: 0.68, H: 0.5 },
  },
} as const;

const roundUpToOneDecimal = (value: number): number => {
  const fiveDecimalInteger = Math.round(value * 100_000);
  if (fiveDecimalInteger % 10_000 === 0) {
    return fiveDecimalInteger / 100_000;
  }
  return (Math.floor(fiveDecimalInteger / 10_000) + 1) / 10;
};

export const getCvss31Severity = (score: number): FindingSeverity => {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  if (score > 0) return "low";
  return "info";
};

export const getCvss31Vector = (metrics: Cvss31Breakdown): string =>
  `CVSS:3.1/AV:${metrics.attack_vector}/AC:${metrics.attack_complexity}/PR:${metrics.privileges_required}/UI:${metrics.user_interaction}/S:${metrics.scope}/C:${metrics.confidentiality}/I:${metrics.integrity}/A:${metrics.availability}`;

export const calculateCvss31BaseScore = (metrics: Cvss31Breakdown): number => {
  const scope = metrics.scope;
  const impactSubScore =
    1 -
    (1 - WEIGHTS.confidentiality[metrics.confidentiality]) *
      (1 - WEIGHTS.integrity[metrics.integrity]) *
      (1 - WEIGHTS.availability[metrics.availability]);

  const impact =
    scope === "U"
      ? 6.42 * impactSubScore
      : 7.52 * (impactSubScore - 0.029) -
        3.25 * Math.pow(impactSubScore - 0.02, 15);

  if (impact <= 0) return 0;

  const exploitability =
    8.22 *
    WEIGHTS.attack_vector[metrics.attack_vector] *
    WEIGHTS.attack_complexity[metrics.attack_complexity] *
    WEIGHTS.privileges_required[scope][metrics.privileges_required] *
    WEIGHTS.user_interaction[metrics.user_interaction];

  const capped =
    scope === "U"
      ? Math.min(impact + exploitability, 10)
      : Math.min(1.08 * (impact + exploitability), 10);

  return roundUpToOneDecimal(capped);
};

export const calculateCvss31 = (metrics: Cvss31Breakdown) => {
  const score = calculateCvss31BaseScore(metrics);
  return {
    score,
    severity: getCvss31Severity(score),
    vector: getCvss31Vector(metrics),
  };
};
