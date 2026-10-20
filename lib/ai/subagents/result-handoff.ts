/** A result must be verified against the same browser handoff context it began
 * with. Every completed takeover saves a unique note ID, even for blank notes.
 */
export async function verifySubagentResultAfterHandoff<
  T extends { accepted: boolean },
>({
  verify,
  getNotes,
  waitForControl,
  signal,
  modelNoteIds,
}: {
  verify: () => Promise<T>;
  getNotes: () => Promise<Array<{ id: string }>>;
  waitForControl: (signal: AbortSignal) => Promise<boolean>;
  signal: AbortSignal;
  /** Notes actually supplied to the model that produced this result. */
  modelNoteIds?: string[];
}): Promise<T | { accepted: false; error: string }> {
  const changed = {
    accepted: false as const,
    error:
      "Human browser takeover completed. Read the handoff context and take a fresh browser snapshot before submitting the result again.",
  };
  const revision = async () =>
    JSON.stringify((await getNotes()).map(({ id }) => id).sort());
  signal.throwIfAborted();
  const before = await revision();
  // onFinish may already have waited through takeover before structured output
  // reaches this verifier. Compare against the model's context, not only now.
  if (modelNoteIds && before !== JSON.stringify([...modelNoteIds].sort()))
    return changed;
  const result = await verify();
  if (!result.accepted) return result;
  // Keep the child running while the user has control. Finalizing would revoke
  // ownership and make both resume and the wait fail.
  const waited = await waitForControl(signal);
  signal.throwIfAborted();
  const after = await revision();
  if (waited || before !== after) {
    return changed;
  }
  return result;
}
