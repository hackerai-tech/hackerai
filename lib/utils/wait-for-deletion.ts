export type DeletionStatus = "pending" | "complete" | "failed";

// A timeout is an unconfirmed operation, never a successful deletion.
export async function waitForDeletion(
  check: () => Promise<DeletionStatus>,
  timeoutMs = 5 * 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const timeoutMessage =
    "Deletion is taking longer than expected. We could not confirm completion. Please check again or contact support.";
  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const status = await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(timeoutMessage)),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (status === "complete") return;
    if (status === "failed")
      throw new Error(
        "Deletion could not be completed. Please contact support.",
      );
    if (status !== "pending")
      throw new Error("Unable to confirm deletion. Please try again.");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))),
    );
  }
  throw new Error(timeoutMessage);
}
