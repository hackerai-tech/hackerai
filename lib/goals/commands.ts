import {
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
  | { action: "status" | "pause" | "stop" };
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
    return { action: content.toLowerCase() === "pause" ? "pause" : "stop" };
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
    const field = line.match(
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
    criteria: criteria.length ? criteria : [objective],
    maxRuns,
    ...contract,
  };
  if (!validGoalStart(result))
    throw new Error(
      `A goal needs an objective, 1–8 criteria, and 1–${GOAL_MAX_RUNS} runs. Contract fields must be at most 2,000 characters.`,
    );
  return result;
}
