import type { ScheduleDefinition } from "./recurrence";
export type ScheduleRun = {
  id: string;
  chatId: string;
  hasTask: boolean;
  status: string;
  detail: string | null;
  createdAt: number;
  /** Known saved findings for the latest completed task. */
  findingSummary?: { newCount: number; repeatCount: number };
};
export type AgentSchedule = {
  id: string;
  definition: ScheduleDefinition;
  enabled: boolean;
  consumed: boolean;
  nextRunAt: number | null;
  /** Saved findings from this schedule's tasks, capped at 100. Absent on older responses. */
  findingCount?: number;
  /** More findings exist than `findingCount` reports. */
  findingCountTruncated?: boolean;
  runs: ScheduleRun[];
};
export type SchedulesResponse = {
  enabled: boolean;
  computers?: { preference: string; name: string }[];
  schedules: AgentSchedule[];
};
