export const SUBAGENT_HANDLE_SUFFIX_LENGTH = 8;

const SUBAGENT_ID_PREFIX = "sa_";

/**
 * Compact, parent-scoped reference exposed to the model. The full ID remains
 * the durable identity used by persistence, Trigger, analytics, and the UI.
 */
export const toSubagentHandle = (subagentId: string): string => {
  if (!subagentId.startsWith(SUBAGENT_ID_PREFIX)) return subagentId;
  const suffix = subagentId.slice(SUBAGENT_ID_PREFIX.length);
  if (suffix.length <= SUBAGENT_HANDLE_SUFFIX_LENGTH) return subagentId;
  return `${SUBAGENT_ID_PREFIX}${suffix.slice(0, SUBAGENT_HANDLE_SUFFIX_LENGTH)}`;
};
