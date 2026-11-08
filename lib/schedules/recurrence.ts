export const SCHEDULES_FLAG = "scheduled-agent-tasks";

export type ScheduleTiming =
  | { type: "once"; at: number }
  | { type: "interval"; minutes: number }
  | { type: "weekly"; time: string; weekdays: number[]; timezone: string };

export type LocalScheduleExecution = {
  type: "local";
  preference: string;
  name: string;
  workingDirectory: string;
};

export function validateLocalScheduleExecution(
  input: unknown,
): LocalScheduleExecution {
  const value = input as Partial<LocalScheduleExecution> | null;
  if (
    !value ||
    value.type !== "local" ||
    typeof value.preference !== "string" ||
    !/^(desktop-environment|environment):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.preference,
    )
  )
    throw new Error(
      "Choose a connected computer. Update its client if it is missing.",
    );
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const workingDirectory =
    typeof value.workingDirectory === "string"
      ? value.workingDirectory.trim()
      : "";
  if (!name || name.length > 200) throw new Error("Choose a computer.");
  if (
    !workingDirectory ||
    workingDirectory.length > 4096 ||
    /[\x00-\x1f]/.test(workingDirectory) ||
    !/^(\/|[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(workingDirectory)
  )
    throw new Error("Enter an absolute folder path on this computer.");
  return {
    type: "local",
    preference: value.preference,
    name,
    workingDirectory,
  };
}

export type ScheduleDefinition = {
  execution?: LocalScheduleExecution;
  name: string;
  prompt: string;
  timing: ScheduleTiming;
  model: "default" | "pro" | "max";
};

export const MIN_INTERVAL_MINUTES = 15;
export const MAX_SCHEDULES = 20;

/** Database object key order is not part of recurrence identity. */
export function sameScheduleTiming(
  a: ScheduleTiming,
  b: ScheduleTiming,
): boolean {
  if (a.type === "once") return b.type === "once" && a.at === b.at;
  if (a.type === "interval")
    return b.type === "interval" && a.minutes === b.minutes;
  return (
    b.type === "weekly" &&
    a.time === b.time &&
    a.timezone === b.timezone &&
    [...a.weekdays].sort().join() === [...b.weekdays].sort().join()
  );
}

export function validateSchedule(input: unknown): ScheduleDefinition {
  if (!input || typeof input !== "object") throw new Error("Enter a schedule.");
  const value = input as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!name || name.length > 80)
    throw new Error("Use a name between 1 and 80 characters.");
  if (!prompt || prompt.length > 16000)
    throw new Error("Use instructions between 1 and 16,000 characters.");
  if (!["default", "pro", "max"].includes(String(value.model)))
    throw new Error("Choose a model.");
  const timing = value.timing as ScheduleTiming | undefined;
  if (!timing || typeof timing !== "object")
    throw new Error("Choose when to run.");
  let cleanTiming: ScheduleTiming;
  if (timing.type === "interval") {
    if (
      !Number.isInteger(timing.minutes) ||
      timing.minutes < MIN_INTERVAL_MINUTES ||
      timing.minutes > 43200
    ) {
      throw new Error("Choose an interval from 15 minutes to 30 days.");
    }
    cleanTiming = { type: "interval", minutes: timing.minutes };
  } else if (timing.type === "once") {
    if (
      !Number.isFinite(timing.at) ||
      timing.at <= 0 ||
      timing.at > 8640000000000000
    )
      throw new Error("Choose a valid date and time.");
    cleanTiming = { type: "once", at: timing.at };
  } else if (timing.type === "weekly") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timing.time))
      throw new Error("Choose a valid time.");
    if (
      !Array.isArray(timing.weekdays) ||
      !timing.weekdays.length ||
      timing.weekdays.length > 7 ||
      timing.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
    ) {
      throw new Error("Select at least one day.");
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timing.timezone }).format(0);
    } catch {
      throw new Error("Choose a valid time zone, such as America/Chicago.");
    }
    if (typeof timing.timezone !== "string" || timing.timezone.length > 100)
      throw new Error("Choose a valid time zone.");
    cleanTiming = {
      type: "weekly",
      time: timing.time,
      weekdays: [...new Set(timing.weekdays)].sort(),
      timezone: timing.timezone,
    };
  } else throw new Error("Choose a valid schedule.");
  return {
    name,
    prompt,
    ...(value.execution !== undefined
      ? { execution: validateLocalScheduleExecution(value.execution) }
      : {}),
    timing: cleanTiming,
    model: value.model as ScheduleDefinition["model"],
  };
}

/** Clock schedules skip nonexistent DST times and run once at the first repeated time. */
export function nextScheduledTime(
  timing: ScheduleTiming,
  after: number,
): number | null {
  if (timing.type === "once") return timing.at > after ? timing.at : null;
  if (timing.type === "interval") return after + timing.minutes * 60000;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timing.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = (timestamp: number) =>
    Object.fromEntries(
      formatter.formatToParts(timestamp).map((p) => [p.type, p.value]),
    );
  const local = parts(after);
  const date = Date.UTC(
    Number(local.year),
    Number(local.month) - 1,
    Number(local.day),
  );
  const [hour, minute] = timing.time.split(":").map(Number);
  for (let day = 0; day < 9; day++) {
    const calendarDate = new Date(date + day * 86400000);
    if (!timing.weekdays.includes(calendarDate.getUTCDay())) continue;
    const wallTime = calendarDate.getTime() + hour * 3600000 + minute * 60000;
    const offsets = new Set<number>();
    for (const delta of [-86400000, 0, 86400000]) {
      const probe = wallTime + delta;
      const p = parts(probe);
      offsets.add(
        Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) -
          probe,
      );
    }
    const matches = [...offsets]
      .map((offset) => wallTime - offset)
      .filter((candidate) => {
        const p = parts(candidate);
        return (
          +p.year === calendarDate.getUTCFullYear() &&
          +p.month === calendarDate.getUTCMonth() + 1 &&
          +p.day === calendarDate.getUTCDate() &&
          +p.hour === hour &&
          +p.minute === minute
        );
      })
      .sort((a, b) => a - b);
    if (matches.length && matches[0] > after) return matches[0];
  }
  throw new Error("Could not calculate the next run.");
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function describeTiming(timing: ScheduleTiming): string {
  if (timing.type === "once")
    return `Once · ${new Date(timing.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
  if (timing.type === "interval") {
    if (timing.minutes % 1440 === 0)
      return `Every ${timing.minutes / 1440} day${timing.minutes === 1440 ? "" : "s"}`;
    if (timing.minutes % 60 === 0)
      return `Every ${timing.minutes / 60} hour${timing.minutes === 60 ? "" : "s"}`;
    return `Every ${timing.minutes} minutes`;
  }
  const days =
    timing.weekdays.length === 7
      ? "Every day"
      : timing.weekdays.join() === "1,2,3,4,5"
        ? "Weekdays"
        : timing.weekdays.map((d) => DAY_NAMES[d]).join(", ");
  return `${days} at ${timing.time}`;
}
