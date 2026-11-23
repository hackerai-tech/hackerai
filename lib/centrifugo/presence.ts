type PresenceClientInfo = {
  connInfo?: unknown;
  info?: unknown;
};

type PresenceResultLike = {
  clients?: Record<string, unknown>;
  presence?: Record<string, unknown>;
};

// Clients refresh this timestamp independently from Centrifugo token refreshes
// so a brief relay outage remains recoverable. The grace window tolerates four
// missed heartbeats before backend cleanup can make the connection terminal.
export const LOCAL_SANDBOX_HEARTBEAT_INTERVAL_MS = 30_000;
export const LOCAL_SANDBOX_PRESENCE_GRACE_MS = 120_000;
/**
 * How long an Agent run waits for a Desktop host that proved its native
 * session to return on the same connection, and how long that host's bridge
 * keeps the connection instead of registering a new one. It matches the
 * presence grace. The backend keeps an unheard connection for at least that
 * long after its last heartbeat, which can be up to one heartbeat interval
 * before the interruption, so a late return can find it already disconnected.
 * Most relay outages that outlast a few seconds end within it.
 */
export const LOCAL_RUN_HOST_RECOVERY_MS = LOCAL_SANDBOX_PRESENCE_GRACE_MS;

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
