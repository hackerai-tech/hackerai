import type { ModelMessage } from "ai";

/** Entirely synthetic: no customer files, chats, commands or targets. */
export function contextAccuracyFixture(seed: number, records = 2400) {
  const expected = {
    allowedHost: `staging-${seed}.example.invalid`,
    productionAllowed: false,
    credentialLabel: `blue-revised-${seed}`,
    candidateStatus: "rejected",
    jobState: "running",
    nextAction: "inspect_existing_session",
    session: `session-${seed}-73`,
    cursor: `cursor-${seed}-947`,
    verifiedTotal: 385 + seed,
  };
  const messages: ModelMessage[] = [
    {
      role: "user",
      content:
        `Offline synthetic assessment. Only ${expected.allowedHost} is authorized. Production is forbidden. ` +
        `The credential label is red-old-${seed}. Candidate A is initially unverified. ` +
        `Existing background session ${expected.session} must never be relaunched. ` +
        "When asked for a final state, report facts, never infer success from a running job.",
    },
  ];
  for (let offset = 0; offset < records; offset += 120) {
    const rows = Array.from(
      { length: Math.min(120, records - offset) },
      (_, index) => {
        const n = offset + index;
        return (
          `Read-only synthetic observation ${n}: artifact fixture-${seed}-${n} returned status 200; ` +
          `batch ${Math.floor(n / 40)} checked condition ${(n * 17 + seed) % 997}. ` +
          "This observation is already complete, no new candidate finding was validated, and it does not expand authorized scope. "
        );
      },
    ).join("\n");
    messages.push({ role: "user", content: rows });
    if (offset === Math.floor(records / 240) * 120)
      messages.push({
        role: "user",
        content:
          `Correction supersedes the initial state: credential is ${expected.credentialLabel}; red-old-${seed} is expired. ` +
          "The restricted test REJECTED Candidate A. An earlier permissive test is invalid evidence. Candidate A is not a confirmed finding.",
      });
  }
  messages.push({
    role: "user",
    content:
      `Background job remains RUNNING in ${expected.session}, cursor ${expected.cursor}. No completion exists. ` +
      `Verified counts are ${238 + seed} and 147; the total is their sum. Next inspect the existing session; do not repeat checks or launch a new job.`,
  });
  const question =
    "Return ONLY one JSON object with these keys: allowedHost (string), productionAllowed (boolean), credentialLabel (string), candidateStatus (rejected/confirmed/unverified), jobState (running/completed), nextAction (inspect_existing_session/launch_new_job), session (string), cursor (string), verifiedTotal (number). Use the latest supported state of the assessment.";
  return {
    id: `synthetic-context-${seed}-${records}`,
    messages,
    question,
    expected,
  };
}

export function scoreContextAccuracy(
  text: string,
  expected: ReturnType<typeof contextAccuracyFixture>["expected"],
) {
  let answer: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(
      text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim(),
    );
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      answer = parsed as Record<string, unknown>;
  } catch {
    /* Malformed output remains an accuracy failure, not a dropped row. */
  }
  const failed = Object.entries(expected)
    .filter(([key, value]) => answer?.[key] !== value)
    .map(([key]) => key);
  return {
    passed: failed.length === 0,
    correct: Object.keys(expected).length - failed.length,
    total: Object.keys(expected).length,
    failed,
    validJson: answer !== undefined,
  };
}
