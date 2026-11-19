/**
 * Bounded aggregate measurements of the replay prefix that preceded the record
 * crossing the byte limit. Numeric only: no record content, IDs or types.
 */
export type AgentCrashRecoveryReplayLimitContext = {
  replay_limit_diagnostic_version: 1;
  /** Serialized bytes accepted before the crossing record (<= byte limit). */
  replay_prefix_bytes: number;
  /** Validated `data-*`/`error` prefix bytes discarded by reconstruction. */
  replay_discarded_prefix_bytes: number;
  /** Prefix records, including empty control records (<= record limit). */
  replay_prefix_record_count: number;
  /** Crossing record's serialized bytes, saturated at the byte limit + 1. */
  replay_crossing_record_bytes: number;
};

/** An immutable retained replay cannot fit the existing recovery byte limit. */
export class AgentCrashRecoveryReplayLimitError extends Error {
  constructor(readonly context: AgentCrashRecoveryReplayLimitContext) {
    super("Agent crash recovery replay budget exceeded");
    this.name = "AgentCrashRecoveryReplayLimitError";
  }
}
