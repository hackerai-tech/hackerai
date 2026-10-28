import {
  defaultGoalCriterion,
  validGoalStart,
  type GoalContract,
} from "./contracts";
export type GoalCommand =
  | ({
      action: "start";
      expectedGeneration?: number;
      objective: string;
      criteria: string[];
    } & GoalContract)
  | { action: "resume"; input?: string }
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
  if (/^resume\s+\+\d+/i.test(content))
    throw new Error("Run extensions are no longer needed. Use /goal resume.");
  const resume = content.match(/^resume(?:\s+([\s\S]*))?$/i);
  if (resume)
    return { action: "resume", ...(resume[1] ? { input: resume[1] } : {}) };
  const contract: GoalContract = {};
  const headline: string[] = [],
    criteria: string[] = [];
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
    const name = field[1].toLowerCase();
    let value = field[2].trim();
    // The composer serializes legacy multiline fields as JSON strings so
    // shell commands and constraints survive a round trip without rewriting.
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        const decoded: unknown = JSON.parse(value);
        if (typeof decoded === "string") value = decoded;
      } catch {
        /* Ordinary quoted text remains unchanged. */
      }
    }
    if (name === "criterion" || name === "criteria") criteria.push(value);
    else if (name === "verify" || name === "verification")
      contract.verificationCommand = value;
    else if (name === "constraints" || name === "preserve")
      contract.constraints = value;
    else if (name === "boundaries" || name === "scope")
      contract.boundaries = value;
    else if (name === "stop when") contract.stopWhen = value;
    else
      throw new Error(
        "Run limits are no longer supported. Remove the runs: field; normal usage limits still apply.",
      );
  }
  const objective = headline.join("\n");
  const result = {
    action: "start" as const,
    objective,
    criteria: criteria.length ? criteria : [defaultGoalCriterion(objective)],
    ...contract,
  };
  if (!validGoalStart(result))
    throw new Error(
      `Use an objective up to 4,000 characters, 1–8 criteria up to 1,000 characters each, and contract fields must be at most 2,000 characters.`,
    );
  return result;
}

export function goalExecutionInstructions(
  goal: { objective: string; criteria: string[] },
  reply = "",
): string {
  return `Resume my current saved goal. This objective replaces earlier goal objectives in this chat. Discard unfinished steps and plans for superseded objectives, even if a previous assistant promised to finish them. Only perform work needed for the current objective and criteria. Preserve existing authorization boundaries and normal usage limits.

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

// Older goals may have explicit constraints. Keep them editable without a
// separate form, while ordinary goals remain just their original request.
export type EditableGoal = GoalContract & {
  objective: string;
  criteria: string[];
  generation: number;
};
export type EditGoalInComposer = (
  goal: EditableGoal,
  prepare: () => Promise<boolean>,
) => Promise<boolean>;
export function goalEditText(goal: EditableGoal): string {
  const lines = [goal.objective];
  if (
    goal.criteria.length !== 1 ||
    goal.criteria[0] !== defaultGoalCriterion(goal.objective)
  ) {
    lines.push(
      ...goal.criteria.map(
        (criterion) => `criterion: ${JSON.stringify(criterion)}`,
      ),
    );
  }
  for (const [label, value] of [
    ["verify", goal.verificationCommand],
    ["preserve", goal.constraints],
    ["scope", goal.boundaries],
    ["stop when", goal.stopWhen],
  ]) {
    if (value) lines.push(`${label}: ${JSON.stringify(value)}`);
  }
  return lines.join("\n");
}
