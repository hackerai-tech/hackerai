export const LOCAL_CONNECTION_LOST_FINISH_REASON = "local-connection-lost";

export class LocalConnectionLostError extends Error {
  constructor() {
    super(
      "The local connection was lost. Reconnect your computer, then resume from the chat.",
    );
    this.name = "LocalConnectionLostError";
  }
}
