import {
  calculateCvss31,
  calculateCvss31BaseScore,
  getCvss31Severity,
  getCvss31Vector,
  type Cvss31Breakdown,
} from "../cvss31";

describe("CVSS 3.1 base scoring", () => {
  test.each<{
    vector: Cvss31Breakdown;
    score: number;
  }>([
    {
      vector: {
        attack_vector: "N",
        attack_complexity: "L",
        privileges_required: "N",
        user_interaction: "N",
        scope: "U",
        confidentiality: "H",
        integrity: "H",
        availability: "H",
      },
      score: 9.8,
    },
    {
      vector: {
        attack_vector: "N",
        attack_complexity: "L",
        privileges_required: "N",
        user_interaction: "N",
        scope: "U",
        confidentiality: "H",
        integrity: "N",
        availability: "N",
      },
      score: 7.5,
    },
    {
      vector: {
        attack_vector: "N",
        attack_complexity: "L",
        privileges_required: "N",
        user_interaction: "R",
        scope: "C",
        confidentiality: "L",
        integrity: "L",
        availability: "N",
      },
      score: 6.1,
    },
    {
      vector: {
        attack_vector: "L",
        attack_complexity: "L",
        privileges_required: "H",
        user_interaction: "N",
        scope: "U",
        confidentiality: "L",
        integrity: "L",
        availability: "L",
      },
      score: 4.2,
    },
  ])("matches FIRST vector score $score", ({ vector, score }) => {
    expect(calculateCvss31BaseScore(vector)).toBe(score);
  });

  it("rounds up to one decimal instead of rounding to nearest", () => {
    const vector: Cvss31Breakdown = {
      attack_vector: "N",
      attack_complexity: "L",
      privileges_required: "N",
      user_interaction: "R",
      scope: "C",
      confidentiality: "L",
      integrity: "L",
      availability: "N",
    };

    expect(calculateCvss31BaseScore(vector)).toBe(6.1);
  });

  it("returns zero when all impact metrics are none", () => {
    const result = calculateCvss31({
      attack_vector: "N",
      attack_complexity: "L",
      privileges_required: "N",
      user_interaction: "N",
      scope: "U",
      confidentiality: "N",
      integrity: "N",
      availability: "N",
    });

    expect(result).toEqual({
      score: 0,
      severity: "info",
      vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N",
    });
  });

  it("serializes metrics in canonical CVSS 3.1 order", () => {
    expect(
      getCvss31Vector({
        attack_vector: "A",
        attack_complexity: "H",
        privileges_required: "L",
        user_interaction: "R",
        scope: "C",
        confidentiality: "L",
        integrity: "H",
        availability: "N",
      }),
    ).toBe("CVSS:3.1/AV:A/AC:H/PR:L/UI:R/S:C/C:L/I:H/A:N");
  });

  test.each([
    [0, "info"],
    [0.1, "low"],
    [3.9, "low"],
    [4, "medium"],
    [6.9, "medium"],
    [7, "high"],
    [8.9, "high"],
    [9, "critical"],
    [10, "critical"],
  ] as const)("maps %s to %s", (score, severity) => {
    expect(getCvss31Severity(score)).toBe(severity);
  });
});
