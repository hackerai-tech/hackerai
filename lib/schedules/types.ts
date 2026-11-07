import type { ScheduleDefinition } from "./recurrence";
export type ScheduleRun = {
  id: string;
  chatId: string;
  hasTask: boolean;
  status: string;
  detail: string | null;
  createdAt: number;
};
export type AgentSchedule = {
  id: string;
  definition: ScheduleDefinition;
  enabled: boolean;
  nextRunAt: number | null;
  runs: ScheduleRun[];
};
export type SchedulesResponse = {
  enabled: boolean;
  schedules: AgentSchedule[];
};
