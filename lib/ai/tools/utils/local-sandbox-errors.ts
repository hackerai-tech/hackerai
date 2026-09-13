export const LOCAL_COMMAND_RELAY_UNSUBSCRIBED_ERROR_CODE =
  "LOCAL_COMMAND_RELAY_UNSUBSCRIBED" as const;

/** Signals that relay presence rejected a command before it was published. */
export class LocalCommandRelayUnsubscribedError extends Error {
  readonly code = LOCAL_COMMAND_RELAY_UNSUBSCRIBED_ERROR_CODE;

  constructor(readonly connectionId: string) {
    super(
      `Local sandbox connection ${connectionId} is not subscribed to the command relay. Reconnect the local runner or Desktop app, wait until it is ready, then try again.`,
    );
    this.name = "LocalCommandRelayUnsubscribedError";
  }
}

/** Classifies the stable relay error across module or serialization boundaries. */
export const isLocalCommandRelayUnsubscribedError = (
  error: unknown,
): error is LocalCommandRelayUnsubscribedError =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === LOCAL_COMMAND_RELAY_UNSUBSCRIBED_ERROR_CODE &&
  "connectionId" in error &&
  typeof error.connectionId === "string";
