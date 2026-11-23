/**
 * Fresh proof of one Desktop native session over its selected connection.
 *
 * A relay reconnect or renewed presence only shows that some client holding
 * the connection's token is subscribed. It never shows that the same native
 * launch and page document still own the commands this run published. The
 * observer therefore challenges the host on that connection's channel with a
 * random nonce; the host answers with identity read from native code at that
 * moment, plus which of the named commands it still retains output for.
 *
 * Identity is the native launch ID and main-page generation from
 * get_desktop_os_info. A native restart changes the launch; a page load or web
 * process loss advances the generation (and fences that page's commands).
 * Binaries without these fields can never answer, so their hosts keep the
 * existing fail-closed departure behavior.
 */

export const DESKTOP_SESSION_CHALLENGE = "desktop_session_challenge";
export const DESKTOP_SESSION_PROOF = "desktop_session_proof";
/**
 * Published by a bridge that is stopping on purpose (sign-out, quit, switch
 * off). It can only end a run sooner, never keep or revive one.
 */
export const DESKTOP_SESSION_ENDED = "desktop_session_ended";

/** Bounds one challenge's command list; a run never has this many in flight. */
export const MAX_RECONCILED_COMMANDS = 64;
/** The host's bound on its native identity read. */
export const NATIVE_SESSION_READ_TIMEOUT_MS = 2_000;

const NONCE = /^[0-9a-f]{32}$/;
const LAUNCH_ID = /^[0-9a-f]{32}$/;
// The same identity accepted for operation channels.
const COMMAND_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONNECTION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type DesktopSessionIdentity = Readonly<{
  launchId: string;
  pageGeneration: number;
}>;

export type DesktopSessionChallenge = Readonly<{
  type: typeof DESKTOP_SESSION_CHALLENGE;
  nonce: string;
  targetConnectionId: string;
  commandIds: readonly string[];
}>;

export type DesktopSessionProof = Readonly<
  {
    type: typeof DESKTOP_SESSION_PROOF;
    nonce: string;
    connectionId: string;
  } & (
    | {
        unavailable?: undefined;
        launchId: string;
        pageGeneration: number;
        retainedCommandIds: readonly string[];
      }
    | { unavailable: true }
  )
>;

/** A command whose execution request publication began on this run. */
export interface PublishedDesktopCommand {
  readonly commandId: string;
  /** Every output frame through the terminal was received in sequence. */
  outputComplete(): boolean;
  /** Ask the host to replay retained output from this receiver's cursor. */
  resumeOutput(): void;
}

/** Live readiness of the selected host; never a cached admission. */
export interface DesktopDispatchGate {
  /** True only while the selected session is verified and not recovering. */
  isReady(): boolean;
  /** Settles when ready, or rejects on loss, monitoring stop or abort. */
  waitUntilReady(signal?: AbortSignal): Promise<void>;
  /**
   * Call before discarding ownership of an execution whose publication began
   * but whose outcome is unknown (no terminal, no confirmed cancellation).
   * It may still run, so the run stops for manual Resume and no dispatch is
   * admitted again. A no-op once monitoring ended, keeping the first cause.
   * Absent where a host can never recover (CLI), which keeps its behavior.
   */
  failUncertainExecution?(): void;
}

/**
 * Wait for readiness before slow pre-publication work. This is not itself an
 * admission: its caller resumes after an await, so the publication site must
 * read isReady() again in the same tick as its publish.
 */
export async function awaitDispatchReadiness(
  gate: DesktopDispatchGate | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!gate) return;
  while (!gate.isReady()) await gate.waitUntilReady(signal);
  signal?.throwIfAborted();
}

export function newDesktopSessionNonce(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function commandIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_RECONCILED_COMMANDS) return;
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !COMMAND_ID.test(id)) return;
    ids.push(id);
  }
  return ids;
}

/** Only the two authority fields, each strictly; anything else is ignored. */
export function readDesktopSessionIdentity(
  lifecycle: unknown,
): DesktopSessionIdentity | undefined {
  const fields = record(lifecycle);
  const launchId = fields?.launchId;
  const pageGeneration = fields?.pageGeneration;
  if (
    typeof launchId !== "string" ||
    !LAUNCH_ID.test(launchId) ||
    typeof pageGeneration !== "number" ||
    !Number.isSafeInteger(pageGeneration) ||
    pageGeneration < 0
  )
    return;
  return Object.freeze({ launchId, pageGeneration });
}

/**
 * The publisher's connection ID as the relay attached it to a publication:
 * its signed token's conn_info. Missing or malformed is no identity at all.
 */
export function readPublisherConnectionId(info: unknown): string | undefined {
  const connectionId = record(record(info)?.connInfo)?.connectionId;
  return typeof connectionId === "string" && CONNECTION_ID.test(connectionId)
    ? connectionId
    : undefined;
}

export function sameDesktopSession(
  a: DesktopSessionIdentity,
  b: DesktopSessionIdentity,
): boolean {
  return a.launchId === b.launchId && a.pageGeneration === b.pageGeneration;
}

export function parseDesktopSessionChallenge(
  value: unknown,
): DesktopSessionChallenge | undefined {
  const message = record(value);
  if (
    message?.type !== DESKTOP_SESSION_CHALLENGE ||
    typeof message.nonce !== "string" ||
    !NONCE.test(message.nonce) ||
    typeof message.targetConnectionId !== "string" ||
    !CONNECTION_ID.test(message.targetConnectionId)
  )
    return;
  const ids = commandIds(message.commandIds);
  if (!ids) return;
  return Object.freeze({
    type: DESKTOP_SESSION_CHALLENGE,
    nonce: message.nonce,
    targetConnectionId: message.targetConnectionId,
    commandIds: Object.freeze(ids),
  });
}

export function parseDesktopSessionProof(
  value: unknown,
): DesktopSessionProof | undefined {
  const message = record(value);
  if (
    message?.type !== DESKTOP_SESSION_PROOF ||
    typeof message.nonce !== "string" ||
    !NONCE.test(message.nonce) ||
    typeof message.connectionId !== "string" ||
    !CONNECTION_ID.test(message.connectionId)
  )
    return;
  const base = {
    type: DESKTOP_SESSION_PROOF,
    nonce: message.nonce,
    connectionId: message.connectionId,
  } as const;
  if (message.unavailable === true)
    return Object.freeze({ ...base, unavailable: true as const });
  const identity = readDesktopSessionIdentity(message);
  const retained = commandIds(message.retainedCommandIds);
  if (!identity || !retained) return;
  return Object.freeze({
    ...base,
    ...identity,
    retainedCommandIds: Object.freeze(retained),
  });
}

/**
 * The host's answer. Reads native identity freshly, bounded; a hung or failed
 * read answers nothing so the observer may retry within its fixed window. A
 * session that never proved identity at startup, or whose fresh identity
 * differs from it, answers unavailable: it cannot vouch for earlier commands.
 */
export async function answerDesktopSessionChallenge(
  challenge: DesktopSessionChallenge,
  host: {
    connectionId: string;
    /** Validated at the host's own startup, or undefined for older binaries. */
    startup: DesktopSessionIdentity | undefined;
    /** One fresh get_desktop_os_info invocation. */
    readNativeOsInfo: () => Promise<unknown>;
    /** Whether this host still retains acknowledged output for a command. */
    retainsOutput: (commandId: string) => boolean;
  },
): Promise<DesktopSessionProof | undefined> {
  if (challenge.targetConnectionId !== host.connectionId) return;
  const base = {
    type: DESKTOP_SESSION_PROOF,
    nonce: challenge.nonce,
    connectionId: host.connectionId,
  } as const;
  if (!host.startup) return { ...base, unavailable: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let osInfo: unknown;
  try {
    osInfo = await Promise.race([
      host.readNativeOsInfo(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native session read timed out")),
          NATIVE_SESSION_READ_TIMEOUT_MS,
        );
      }),
    ]);
  } catch {
    return;
  } finally {
    clearTimeout(timer);
  }
  const fresh = readDesktopSessionIdentity(record(osInfo)?.lifecycle);
  if (!fresh || !sameDesktopSession(fresh, host.startup))
    return { ...base, unavailable: true };
  // Read after the native call: ownership is current as of this answer.
  return {
    ...base,
    ...fresh,
    retainedCommandIds: challenge.commandIds.filter((id) =>
      host.retainsOutput(id),
    ),
  };
}

/**
 * Whether a publication is the selected connection's own end notice. Only the
 * relay's record of the publisher counts as authority, as for proofs.
 */
export function isDesktopSessionEnded(
  data: unknown,
  info: unknown,
  connectionId: string,
): boolean {
  const message = record(data);
  return (
    message?.type === DESKTOP_SESSION_ENDED &&
    message.connectionId === connectionId &&
    readPublisherConnectionId(info) === connectionId
  );
}
