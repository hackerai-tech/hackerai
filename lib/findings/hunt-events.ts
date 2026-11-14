/**
 * Client-only, in-memory signal that a finding's hunt history changed in this
 * tab: a hunt tool part finished successfully. Mounted hunt views for that
 * finding refresh at once instead of waiting for their next idle poll.
 * Carries only the finding ID; it is never persisted or sent anywhere.
 */
type FindingHuntListener = (findingId: string) => void;

const listeners = new Set<FindingHuntListener>();

export function notifyFindingHuntChanged(findingId: string): void {
  for (const listener of [...listeners]) listener(findingId);
}

/** Returns an unsubscribe function. */
export function subscribeFindingHuntChanges(
  listener: FindingHuntListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
