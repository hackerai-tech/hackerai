// Delivery recovery is bounded; mailbox retention is managed separately.
export const ABUSE_PAYLOAD_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const ABUSE_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const ABUSE_SEND_LEASE_MS = 120_000;
