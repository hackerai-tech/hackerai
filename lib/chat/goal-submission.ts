/** A saved/unknown turn is not proof that its durable Agent start failed. */
export class GoalSubmissionUnconfirmedError extends Error {
  constructor(public readonly messagePersisted: boolean | undefined) {
    super(
      "The goal may have started. Reopen this chat to check before sending again. Your draft is kept.",
    );
    this.name = "GoalSubmissionUnconfirmedError";
  }
}
