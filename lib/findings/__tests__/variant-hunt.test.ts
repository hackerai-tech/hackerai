import {
  countHuntOutcomes,
  huntCandidateKey,
  huntEvidenceBasisLabel,
  parseHuntCandidate,
  parseHuntCompletion,
} from "../variant-hunt";

const candidate = (overrides: Record<string, unknown> = {}) => ({
  candidate_key: "invoice-pdf",
  surface: "GET /api/invoices/{id}/pdf",
  rationale: "Same loader, no owner check.",
  outcome: "reproduced",
  evidence_basis: "runtime_check",
  reproduction_steps: ["Request tester B's PDF as tester A"],
  expected_result: "403",
  observed_result: "200 with tester B's PDF",
  evidence_refs: [],
  limitations: [],
  ...overrides,
});

describe("variant hunt candidate rules", () => {
  it("keeps the check method independent of the outcome", () => {
    expect(parseHuntCandidate(candidate()).success).toBe(true);
    // Reproduced needs a runtime check; code reading alone is inconclusive.
    expect(
      parseHuntCandidate(candidate({ evidence_basis: "source_review_only" })),
    ).toMatchObject({ success: false, message: /evidence_basis/ });
    // A runtime check can rule a surface out as well as reproduce it.
    for (const evidence_basis of ["runtime_check", "source_review_only"])
      expect(
        parseHuntCandidate(
          candidate({
            outcome: "ruled_out",
            evidence_basis,
            observed_result: "403 for tester B's PDF",
            limitations: ["One pair of accounts"],
          }),
        ).success,
      ).toBe(true);
    // Inconclusive is an outcome, not a method: either method plus limits.
    for (const evidence_basis of ["runtime_check", "source_review_only"])
      expect(
        parseHuntCandidate(
          candidate({
            outcome: "inconclusive",
            evidence_basis,
            limitations: ["Access to staging was not available"],
          }),
        ).success,
      ).toBe(true);
    // The seed finding's vocabulary is not accepted for candidates.
    for (const evidence_basis of ["runtime_reproduced", "inconclusive"])
      expect(
        parseHuntCandidate(
          candidate({
            outcome: "inconclusive",
            evidence_basis,
            limitations: ["x"],
          }),
        ).success,
      ).toBe(false);
    expect(
      parseHuntCandidate(candidate({ evidence_basis: undefined })).success,
    ).toBe(false);
    expect(
      parseHuntCandidate(candidate({ outcome: "ruled_out", limitations: [] }))
        .success,
    ).toBe(false);
  });

  it("labels the method honestly in candidate detail", () => {
    expect(huntEvidenceBasisLabel("runtime_check", "reproduced")).toBe(
      "Runtime reproduced",
    );
    expect(huntEvidenceBasisLabel("runtime_check", "ruled_out")).toBe(
      "Runtime checked",
    );
    expect(huntEvidenceBasisLabel("runtime_check", "inconclusive")).toBe(
      "Runtime checked",
    );
    expect(huntEvidenceBasisLabel("source_review_only", "ruled_out")).toBe(
      "Source review only",
    );
  });

  it("keeps not_examined distinct: no basis, no claimed observation", () => {
    const notExamined = candidate({
      outcome: "not_examined",
      evidence_basis: undefined,
      reproduction_steps: [],
      expected_result: undefined,
      observed_result: undefined,
      limitations: ["Found in the route list; not reached before stopping."],
    });
    expect(parseHuntCandidate(notExamined).success).toBe(true);
    expect(
      parseHuntCandidate({ ...notExamined, evidence_basis: "runtime_check" })
        .success,
    ).toBe(false);
    expect(
      parseHuntCandidate({ ...notExamined, limitations: [] }).success,
    ).toBe(false);
  });

  it("rejects secrets in every field, including the key and surface", () => {
    for (const field of ["surface", "rationale", "observed_result"])
      expect(
        parseHuntCandidate(
          candidate({
            [field]: "Authorization: Bearer abcdefghijklmnopqrstuv",
          }),
        ).success,
      ).toBe(false);
    expect(
      parseHuntCandidate(
        candidate({ evidence_refs: ["Cookie: sid=4f9a8b7c6d5e4f3a2b1c"] }),
      ).success,
    ).toBe(false);
    expect(
      parseHuntCandidate(
        candidate({ observed_result: "Authorization: Bearer [REDACTED]" }),
      ).success,
    ).toBe(true);
    expect(
      parseHuntCompletion({
        summary: "-----BEGIN RSA PRIVATE KEY----- leaked",
        limitations: ["x"],
      }).success,
    ).toBe(false);
  });

  it("enforces bounds and unknown fields", () => {
    expect(
      parseHuntCandidate(candidate({ evidence_refs: Array(6).fill("/tmp/a") }))
        .success,
    ).toBe(false);
    expect(
      parseHuntCandidate(candidate({ candidate_key: "has space" })).success,
    ).toBe(false);
    expect(parseHuntCandidate(candidate({ severity: "high" })).success).toBe(
      false,
    );
  });

  it("requires completion limitations: a hunt is never exhaustive", () => {
    expect(
      parseHuntCompletion({ summary: "Done.", limitations: [] }).success,
    ).toBe(false);
    expect(
      parseHuntCompletion({
        summary: "Done.",
        limitations: ["Only invoice routes"],
      }).success,
    ).toBe(true);
  });

  it("compares retries by content and derives counts from saved candidates", () => {
    const parsed = parseHuntCandidate(candidate());
    const reordered = parseHuntCandidate(
      candidate({ evidence_refs: ["/b", "/a"] }),
    );
    const again = parseHuntCandidate(
      candidate({ evidence_refs: ["/a", "/b"] }),
    );
    if (!parsed.success || !reordered.success || !again.success)
      throw new Error("expected valid");
    expect(huntCandidateKey(reordered.value)).toBe(
      huntCandidateKey(again.value),
    );
    expect(huntCandidateKey(parsed.value)).not.toBe(
      huntCandidateKey(again.value),
    );
    expect(
      countHuntOutcomes([
        { outcome: "reproduced" },
        { outcome: "reproduced" },
        { outcome: "not_examined" },
      ]),
    ).toEqual({
      reproduced: 2,
      ruled_out: 0,
      inconclusive: 0,
      not_examined: 1,
    });
  });
});
