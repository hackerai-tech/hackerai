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
  consumed: boolean;
  nextRunAt: number | null;
  runs: ScheduleRun[];
};
export type SchedulesResponse = {
  enabled: boolean;
  computers?: { preference: string; name: string }[];
  schedules: AgentSchedule[];
};
