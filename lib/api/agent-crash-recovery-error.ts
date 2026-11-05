/** An immutable retained replay cannot fit the existing recovery byte limit. */
export class AgentCrashRecoveryReplayLimitError extends Error {
  constructor() {
    super("Agent crash recovery replay budget exceeded");
    this.name = "AgentCrashRecoveryReplayLimitError";
  }
}
