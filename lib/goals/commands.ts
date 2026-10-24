import {
  defaultGoalCriterion,
  GOAL_DEFAULT_RUNS,
  GOAL_MAX_RUNS,
  validGoalStart,
  type GoalContract,
} from "./contracts";
export type GoalCommand =
  | ({
      action: "start";
      objective: string;
      criteria: string[];
      maxRuns: number;
    } & GoalContract)
  | { action: "resume"; additionalRuns?: number; input?: string }
  | { action: "status" | "pause" | "stop" | "clear" };
export function parseGoalCommand(text: string): GoalCommand | null {
  const match = text.trim().match(/^\/goal(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const content = (match[1] ?? "").trim();
  if (
    !content ||
    content.toLowerCase() === "status" ||
    content.toLowerCase() === "show"
  )
    return { action: "status" };
  if (/^(pause|stop|clear)$/i.test(content))
    return { action: content.toLowerCase() as "pause" | "stop" | "clear" };
  if (
    /^resume\s+\+\d+/i.test(content) &&
    !/^resume\s+\+[1-8](?:\s|$)/i.test(content)
  )
    throw new Error(
      "Add between 1 and 8 runs, within the cumulative goal budget.",
    );
  const resume = content.match(/^resume(?:\s+\+([1-8]))?(?:\s+([\s\S]*))?$/i);
  if (resume)
    return {
      action: "resume",
      ...(resume[1] ? { additionalRuns: Number(resume[1]) } : {}),
      ...(resume[2] ? { input: resume[2] } : {}),
    };
  const contract: GoalContract = {};
  const headline: string[] = [],
    criteria: string[] = [];
  let maxRuns = GOAL_DEFAULT_RUNS;
  for (const line of content.replace(/^(?:--|start)\s+/i, "").split("\n")) {
    const field = line
      .trim()
      .match(
        /^(criterion|criteria|verify|verification|constraints|preserve|boundaries|scope|stop when|runs):\s*(.+)$/i,
      );
    if (!field) {
      if (line.trim()) headline.push(line.trim());
      continue;
    }
    const name = field[1].toLowerCase(),
      value = field[2].trim();
    if (name === "criterion" || name === "criteria") criteria.push(value);
    else if (name === "verify" || name === "verification")
      contract.verificationCommand = value;
    else if (name === "constraints" || name === "preserve")
      contract.constraints = value;
    else if (name === "boundaries" || name === "scope")
      contract.boundaries = value;
    else if (name === "stop when") contract.stopWhen = value;
    else maxRuns = Number(value);
  }
  const objective = headline.join("\n");
  const result = {
    action: "start" as const,
    objective,
    criteria: criteria.length ? criteria : [defaultGoalCriterion(objective)],
    maxRuns,
    ...contract,
  };
  if (!validGoalStart(result))
    throw new Error(
      `Use an objective up to 4,000 characters, 1–8 criteria up to 1,000 characters each, and 1–${GOAL_MAX_RUNS} runs. Contract fields must be at most 2,000 characters.`,
    );
  return result;
}

export function goalExecutionInstructions(
  goal: { objective: string; criteria: string[] },
  reply = "",
): string {
  return `Resume my current saved goal. This objective replaces earlier goal objectives in this chat. Discard unfinished steps and plans for superseded objectives, even if a previous assistant promised to finish them. Only perform work needed for the current objective and criteria. Preserve existing authorization boundaries and the remaining run budget.

Goal: ${goal.objective}
Success criteria:
${goal.criteria.map((criterion, i) => `${i + 1}. ${criterion}`).join("\n")}${reply.trim() ? `\n\nAdditional information: ${reply.trim()}` : ""}`;
}

export function goalResumeMessage(
  goal: { objective: string },
  reply = "",
): string {
  return `Resume goal: ${goal.objective}${reply.trim() ? `\n\n${reply.trim()}` : ""}`;
}
