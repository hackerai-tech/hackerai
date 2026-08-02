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

export class CentrifugoPublishQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly publishFragment: (message: unknown) => Promise<void>,
  ) {}

  publish(message: Record<string, unknown>): Promise<void> {
    const operation = this.tail.then(async () => {
      const fragments = fragmentCentrifugoMessage(message);
      for (const fragment of fragments) {
        try {
          await this.publishFragment(fragment);
        } catch (error) {
          throw error instanceof Error ? error : new Error(errorMessage(error));
        }
      }
    });

    this.tail = operation.catch(() => undefined);
    return operation;
  }
}
