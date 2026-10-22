// Centrifugo v5 accepts at most 64 KiB per WebSocket message by default.
// Keep direct messages and fragment envelopes well below that ceiling so
// Centrifuge's protocol/channel wrapper always has room. Small messages retain
// their existing shape; only oversized client-to-server relay messages use the
// transport_fragment envelope.
const MAX_DIRECT_MESSAGE_BYTES = 32 * 1024;
const MAX_FRAGMENT_DATA_CHARS = 24 * 1024;
const MAX_FRAGMENT_COUNT = 128;
const MAX_REASSEMBLED_BASE64_CHARS =
  MAX_FRAGMENT_DATA_CHARS * MAX_FRAGMENT_COUNT;
const MAX_ACTIVE_TRANSFERS = 16;
const TRANSFER_TTL_MS = 2 * 60 * 1000;

const CORRELATION_KEYS = ["commandId", "requestId", "sessionId"] as const;

type CorrelationKey = (typeof CORRELATION_KEYS)[number];

export interface CentrifugoTransportFragment {
  type: "transport_fragment";
  transferId: string;
  index: number;
  total: number;
  data: string;
  commandId?: string;
  requestId?: string;
  sessionId?: string;
}

interface PendingTransfer {
  total: number;
  chunks: Array<string | undefined>;
  received: number;
  encodedChars: number;
  updatedAt: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const batchSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += batchSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + batchSize),
    );
  }

  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function getCorrelationFields(
  message: Record<string, unknown>,
): Partial<Record<CorrelationKey, string>> {
  const fields: Partial<Record<CorrelationKey, string>> = {};
  for (const key of CORRELATION_KEYS) {
    if (typeof message[key] === "string") {
      fields[key] = message[key];
    }
  }
  return fields;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Centrifuge's client-side RPC deadline expired; delivery is uncertain. */
export function isCentrifugoPublishTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 1
  );
}

export function isCentrifugoTransportFragment(
  value: unknown,
): value is CentrifugoTransportFragment {
  if (typeof value !== "object" || value === null) return false;
  const fragment = value as Record<string, unknown>;
  return (
    fragment.type === "transport_fragment" &&
    typeof fragment.transferId === "string" &&
    fragment.transferId.length > 0 &&
    fragment.transferId.length <= 128 &&
    Number.isInteger(fragment.index) &&
    (fragment.index as number) >= 0 &&
    Number.isInteger(fragment.total) &&
    (fragment.total as number) > 0 &&
    (fragment.total as number) <= MAX_FRAGMENT_COUNT &&
    (fragment.index as number) < (fragment.total as number) &&
    typeof fragment.data === "string" &&
    fragment.data.length <= MAX_FRAGMENT_DATA_CHARS
  );
}

export function fragmentMatchesCorrelation(
  value: unknown,
  key: CorrelationKey,
  expectedId: string,
): boolean {
  if (!isCentrifugoTransportFragment(value)) return true;
  const actualId = value[key];
  if (actualId !== undefined) return actualId === expectedId;
  return !CORRELATION_KEYS.some(
    (correlationKey) => typeof value[correlationKey] === "string",
  );
}

export function fragmentCentrifugoMessage(
  message: Record<string, unknown>,
): Array<Record<string, unknown> | CentrifugoTransportFragment> {
  const serialized = JSON.stringify(message);
  if (encoder.encode(serialized).byteLength <= MAX_DIRECT_MESSAGE_BYTES) {
    return [message];
  }

  const encoded = bytesToBase64(encoder.encode(serialized));
  const total = Math.ceil(encoded.length / MAX_FRAGMENT_DATA_CHARS);
  if (total > MAX_FRAGMENT_COUNT) {
    throw new Error(
      `Centrifugo message requires ${total} fragments; maximum is ${MAX_FRAGMENT_COUNT}`,
    );
  }

  const transferId = crypto.randomUUID();
  const correlation = getCorrelationFields(message);
  const fragments: CentrifugoTransportFragment[] = [];

  for (let index = 0; index < total; index += 1) {
    fragments.push({
      type: "transport_fragment",
      transferId,
      index,
      total,
      data: encoded.slice(
        index * MAX_FRAGMENT_DATA_CHARS,
        (index + 1) * MAX_FRAGMENT_DATA_CHARS,
      ),
      ...correlation,
    });
  }

  return fragments;
}

export class CentrifugoMessageReassembler {
  private readonly transfers = new Map<string, PendingTransfer>();

  accept(value: unknown): unknown | null {
    if (!isCentrifugoTransportFragment(value)) return value;

    const now = Date.now();
    this.removeExpired(now);

    let transfer = this.transfers.get(value.transferId);
    if (!transfer) {
      if (this.transfers.size >= MAX_ACTIVE_TRANSFERS) return null;
      transfer = {
        total: value.total,
        chunks: new Array<string | undefined>(value.total),
        received: 0,
        encodedChars: 0,
        updatedAt: now,
      };
      this.transfers.set(value.transferId, transfer);
    }

    if (transfer.total !== value.total) {
      this.transfers.delete(value.transferId);
      return null;
    }

    const existing = transfer.chunks[value.index];
    if (existing !== undefined) {
      if (existing !== value.data) {
        this.transfers.delete(value.transferId);
      }
      return null;
    }

    transfer.chunks[value.index] = value.data;
    transfer.received += 1;
    transfer.encodedChars += value.data.length;
    transfer.updatedAt = now;

    if (transfer.encodedChars > MAX_REASSEMBLED_BASE64_CHARS) {
      this.transfers.delete(value.transferId);
      return null;
    }
    if (transfer.received !== transfer.total) return null;

    this.transfers.delete(value.transferId);
    try {
      const encoded = transfer.chunks.join("");
      const serialized = decoder.decode(base64ToBytes(encoded));
      const parsed = JSON.parse(serialized) as unknown;
      if (isCentrifugoTransportFragment(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private removeExpired(now: number): void {
    for (const [transferId, transfer] of this.transfers) {
      if (now - transfer.updatedAt > TRANSFER_TTL_MS) {
        this.transfers.delete(transferId);
      }
    }
  }
}

// Per operation, including the publish waiting for acknowledgement. This allows
// a maximum-size file reply plus a burst of output without retaining an
// unlimited number of callbacks when the relay is slow.
export const RELAY_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
export const RELAY_QUEUE_MAX_MESSAGES = 256;

export class RelayOutputOverflowError extends Error {
  constructor() {
    super(
      "Relay output buffer limit exceeded; output is incomplete. Do not treat this operation as successful.",
    );
    this.name = "RelayOutputOverflowError";
  }
}

type PendingPublish = {
  serialized: string;
  bytes: number;
  resolve: () => void;
  reject: (error: Error) => void;
};

export class CentrifugoPublishQueue {
  private pending: PendingPublish[] = [];
  private active: PendingPublish | undefined;
  private bytes = 0;
  private closed = false;
  private closedError: Error | undefined;

  constructor(
    private readonly publishFragment: (message: unknown) => Promise<void>,
    private readonly limits = {
      bytes: RELAY_QUEUE_MAX_BYTES,
      messages: RELAY_QUEUE_MAX_MESSAGES,
    },
  ) {}

  publish(message: Record<string, unknown>): Promise<void> {
    if (this.closed)
      return this.closedError
        ? Promise.reject(this.closedError)
        : Promise.resolve();
    try {
      // Snapshot on admission: later mutation cannot evade accounting or change
      // output which is already queued. Charge UTF-8 JSON, not JS string length.
      const serialized = JSON.stringify(message);
      const bytes = encoder.encode(serialized).byteLength;
      if (
        this.bytes + bytes > this.limits.bytes ||
        this.pending.length + Number(Boolean(this.active)) >=
          this.limits.messages
      ) {
        return Promise.reject(new RelayOutputOverflowError());
      }
      this.bytes += bytes;
      const result = new Promise<void>((resolve, reject) => {
        this.pending.push({ serialized, bytes, resolve, reject });
      });
      void Promise.resolve().then(() => this.drain());
      return result;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Settle waiters and release queued output even if an RPC never settles. */
  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closedError = error;
    const settle = (entry: PendingPublish) =>
      error ? entry.reject(error) : entry.resolve();
    if (this.active) settle(this.active);
    for (const entry of this.pending) settle(entry);
    this.pending = [];
    this.bytes = 0;
  }

  private async drain(): Promise<void> {
    if (this.active || this.closed) return;
    const entry = this.pending.shift();
    if (!entry) return;
    this.active = entry;
    try {
      const fragments = fragmentCentrifugoMessage(JSON.parse(entry.serialized));
      // The serialized copy is no longer needed while publishing fragments.
      entry.serialized = "";
      for (const fragment of fragments) {
        if (this.closed) break;
        await this.publishFragment(fragment);
      }
      if (!this.closed) entry.resolve();
    } catch (error) {
      entry.reject(
        error instanceof Error ? error : new Error(errorMessage(error)),
      );
    } finally {
      this.active = undefined;
      if (!this.closed) {
        this.bytes -= entry.bytes;
        void Promise.resolve().then(() => this.drain());
      }
    }
  }
}
