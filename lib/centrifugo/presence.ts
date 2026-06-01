type PresenceClientInfo = {
  connInfo?: unknown;
  info?: unknown;
};

type PresenceResultLike = {
  clients?: Record<string, unknown>;
  presence?: Record<string, unknown>;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

const getPresenceClients = (
  presence: PresenceResultLike,
): Record<string, unknown> => presence.clients ?? presence.presence ?? {};

const getConnectionIdFromInfo = (info: unknown): string | null => {
  const record = asRecord(info);
  const connectionId = record?.connectionId;
  return typeof connectionId === "string" ? connectionId : null;
};

export const getConnectionIdFromPresenceClient = (
  clientInfo: unknown,
): string | null => {
  const client = asRecord(clientInfo) as PresenceClientInfo | null;
  if (!client) return null;

  return (
    getConnectionIdFromInfo(client.connInfo) ??
    getConnectionIdFromInfo(client.info)
  );
};

export const presenceHasConnectionId = (
  presence: PresenceResultLike,
  connectionId: string,
): boolean =>
  Object.values(getPresenceClients(presence)).some(
    (clientInfo) =>
      getConnectionIdFromPresenceClient(clientInfo) === connectionId,
  );
