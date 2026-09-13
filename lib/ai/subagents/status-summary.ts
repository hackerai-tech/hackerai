import { SUBAGENT_ACTIVE_STATUSES, type SubagentStatus } from "./contracts";

type AgentStatusRecord = {
  status?: unknown;
};

export const formatSubagentCountSummary = (agents: unknown): string => {
  const records = Array.isArray(agents) ? agents : [];
  const activeCount = records.reduce((count, record: AgentStatusRecord) => {
    const status = record?.status;
    return typeof status === "string" &&
      SUBAGENT_ACTIVE_STATUSES.has(status as SubagentStatus)
      ? count + 1
      : count;
  }, 0);

  return `${records.length} total · ${activeCount} active`;
};
