import {
  contextAccuracyFixture,
  scoreContextAccuracy,
} from "../context-accuracy-fixture";
it("rejects plausible but wrong final state, negated markers and malformed answers", () => {
  const fixture = contextAccuracyFixture(17);
  expect(
    scoreContextAccuracy(JSON.stringify(fixture.expected), fixture.expected)
      .passed,
  ).toBe(true);
  const wrong = {
    ...fixture.expected,
    productionAllowed: true,
    credentialLabel: "red-old-17",
    candidateStatus: "confirmed",
    jobState: "completed",
    nextAction: "launch_new_job",
    verifiedTotal: 385,
  };
  expect(
    scoreContextAccuracy(JSON.stringify(wrong), fixture.expected),
  ).toMatchObject({
    passed: false,
    correct: 3,
    failed: [
      "productionAllowed",
      "credentialLabel",
      "candidateStatus",
      "jobState",
      "nextAction",
      "verifiedTotal",
    ],
  });
  expect(
    scoreContextAccuracy(
      "Do not use " + JSON.stringify(fixture.expected),
      fixture.expected,
    ),
  ).toMatchObject({ passed: false, correct: 0, validJson: false });
});
