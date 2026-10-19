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
}: {
  verify: () => Promise<T>;
  getNotes: () => Promise<Array<{ id: string }>>;
  waitForControl: (signal: AbortSignal) => Promise<boolean>;
  signal: AbortSignal;
}): Promise<T | { accepted: false; error: string }> {
  const revision = async () =>
    JSON.stringify((await getNotes()).map(({ id }) => id).sort());
  signal.throwIfAborted();
  const before = await revision();
  const result = await verify();
  if (!result.accepted) return result;
  // Keep the child running while the user has control. Finalizing would revoke
  // ownership and make both resume and the wait fail.
  const waited = await waitForControl(signal);
  signal.throwIfAborted();
  const after = await revision();
  if (waited || before !== after) {
    return {
      accepted: false,
      error:
        "Human browser takeover completed. Read the handoff context and take a fresh browser snapshot before submitting the result again.",
    };
  }
  return result;
}
