const BRIDGE_CLOSE_CODES = [
  1000, 1001, 1002, 1003, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012, 1013,
  1014, 1015,
] as const;
const BRIDGE_PHASES = [
  "connecting",
  "awaiting_frame",
  "message_received",
] as const;

// Public Node/Undici reasons only; unknown error messages never leave the helper.
const BRIDGE_ERROR_REASON_LABELS = {
  "Received network error or non-101 status code.": "network_or_handshake",
  "Connection was closed before it was established.": "network_or_handshake",
  "Server did not respond with sent protocols.": "handshake_headers",
  'Server did not set Upgrade header to "websocket".': "handshake_headers",
  'Server did not set Connection header to "upgrade".': "handshake_headers",
  "Incorrect hash received in Sec-WebSocket-Accept header.":
    "handshake_headers",
  "Sec-WebSocket-Extensions header does not match.": "handshake_headers",
  "Protocol was not set in the opening handshake.": "handshake_headers",
  "Invalid opcode received": "protocol_opcode",
  "Frame cannot be masked": "protocol_masked",
  "Expected RSV1 to be clear.": "protocol_reserved_bits",
  "RSV1, RSV2, RSV3 must be clear": "protocol_reserved_bits",
  "Invalid frame type was fragmented.": "protocol_fragmentation",
  "Expected continuation frame": "protocol_fragmentation",
  "Fragmented frame exceeded 125 bytes.": "protocol_fragmentation",
  "Control frame either too large or fragmented": "protocol_fragmentation",
  "Unexpected continuation frame": "protocol_fragmentation",
  "Received payload length > 2^31 bytes.": "protocol_payload",
  "Received invalid UTF-8 in text frame.": "protocol_utf8",
  "Received close frame with a 1-byte body.": "protocol_close",
} as const;
const BRIDGE_ERROR_REASONS = [
  ...new Set(Object.values(BRIDGE_ERROR_REASON_LABELS)),
  "other",
  "unreadable",
] as const;

export type BrowserBridgeFailureContext = {
  capture_bridge_diagnostic_version?: 1 | 2;
  capture_bridge_failure?: "error" | "early_close";
  capture_bridge_phase?: (typeof BRIDGE_PHASES)[number];
  capture_bridge_close_code?:
    (typeof BRIDGE_CLOSE_CODES)[number] | "none" | "other";
  capture_bridge_error_reason?: (typeof BRIDGE_ERROR_REASONS)[number];
  capture_bridge_node_major?: number | "other";
};

/** Read only a bounded exit-6 packet; never successful frames, stderr or getters. */
export function browserBridgeFailureContext(
  result: unknown,
): BrowserBridgeFailureContext {
  try {
    if (
      !result ||
      typeof result !== "object" ||
      Object.getOwnPropertyDescriptor(result, "exitCode")?.value !== 6
    )
      return {};
    const stdout = Object.getOwnPropertyDescriptor(result, "stdout")?.value;
    if (typeof stdout !== "string" || stdout.length > 128) return {};
    const tuple = JSON.parse(stdout)?.bridge_failure;
    if (!Array.isArray(tuple)) return {};
    const legacy = tuple.length === 4 && tuple[0] === 1;
    const reasonPacket =
      tuple.length === 6 &&
      tuple[0] === 2 &&
      tuple[1] === "error" &&
      tuple[3] === "none" &&
      BRIDGE_ERROR_REASONS.includes(tuple[4]) &&
      (tuple[5] === "other" ||
        (Number.isInteger(tuple[5]) && tuple[5] >= 1 && tuple[5] <= 255));
    if (
      (legacy || reasonPacket) &&
      (tuple[1] === "error" || tuple[1] === "early_close") &&
      BRIDGE_PHASES.includes(tuple[2]) &&
      (tuple[1] === "error"
        ? tuple[3] === "none"
        : tuple[3] === "other" || BRIDGE_CLOSE_CODES.includes(tuple[3]))
    )
      return {
        capture_bridge_diagnostic_version: legacy ? 1 : 2,
        capture_bridge_failure: tuple[1],
        capture_bridge_phase: tuple[2],
        capture_bridge_close_code: tuple[3],
        ...(reasonPacket
          ? {
              capture_bridge_error_reason: tuple[4],
              capture_bridge_node_major: tuple[5],
            }
          : {}),
      };
  } catch {
    // Optional diagnostics cannot replace the original capture failure.
  }
  return {};
}

// Executed inside the existing cloud sandbox. The stream WebSocket is bound to
// localhost there; only a single validated frame or input batch crosses the
// authenticated E2B command connection. Never send this port to a client.
export const BROWSER_BRIDGE_PROGRAM = String.raw`
const port = Number(process.argv[1]);
const mode = process.argv[2];
if (!Number.isInteger(port) || port < 1 || port > 65535 ||
    (mode !== 'frame' && mode !== 'input') || typeof WebSocket !== 'function') {
  process.exit(2);
}
let done = false;
let phase = 'connecting';
const closeCodes = ${JSON.stringify(BRIDGE_CLOSE_CODES)};
const errorReasons = ${JSON.stringify(BRIDGE_ERROR_REASON_LABELS)};
const finish = (code, value) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  if (value !== undefined) {
    if (code === 6) {
      try { process.stdout.write(JSON.stringify(value)); } catch {}
    } else process.stdout.write(JSON.stringify(value));
  }
  try { socket.close(); } catch {}
  setTimeout(() => process.exit(code), 20);
};
const timer = setTimeout(() => finish(3), 6500);
let payload = '';
let socket;
if (mode === 'input') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    payload += chunk;
    if (payload.length > 8192) finish(4);
  });
  process.stdin.on('end', connect);
} else {
  connect();
}
function connect() {
  if (done) return;
  socket = new WebSocket('ws://127.0.0.1:' + port);
  socket.addEventListener('open', () => {
    phase = 'awaiting_frame';
    if (mode !== 'input') return;
    try {
      const events = JSON.parse(payload);
      if (!Array.isArray(events) || events.length < 1 || events.length > 64) {
        finish(4); return;
      }
      for (const event of events) socket.send(JSON.stringify(event));
      setTimeout(() => finish(0, { ok: true }), 120);
    } catch { finish(4); }
  });
  socket.addEventListener('message', event => {
    if (mode !== 'frame') return;
    phase = 'message_received';
    try {
      const message = JSON.parse(String(event.data));
      if (message.type !== 'frame') return;
      if (typeof message.data !== 'string' || message.data.length > 900000) {
        finish(5); return;
      }
      const metadata = message.metadata || {};
      const capturedAt = Number(metadata.timestamp);
      finish(0, {
        data: message.data,
        width: Number(metadata.deviceWidth) || 0,
        height: Number(metadata.deviceHeight) || 0,
        // Older producers can omit this value. Keep unknown age explicit;
        // takeover and resume request a separate fresh screenshot.
        capturedAt: Number.isFinite(capturedAt) && capturedAt > 0 ? capturedAt : 0,
      });
    } catch { finish(5); }
  });
  socket.addEventListener('error', event => {
    if (done) return;
    if (mode !== 'frame') { finish(6); return; }
    let reason = 'other';
    let nodeMajor = 'other';
    try {
      const error = event.error;
      const message = error && typeof error === 'object'
        ? Object.getOwnPropertyDescriptor(error, 'message')?.value : undefined;
      if (typeof message === 'string' && message.length <= 256 &&
          Object.prototype.hasOwnProperty.call(errorReasons, message)) {
        reason = errorReasons[message];
      }
    } catch { reason = 'unreadable'; }
    try {
      const version = process.versions?.node;
      const major = typeof version === 'string' && /^\d{1,3}\./.test(version)
        ? Number(version.split('.')[0]) : 0;
      if (major >= 1 && major <= 255) nodeMajor = major;
    } catch {}
    finish(6, { bridge_failure: [2, 'error', phase, 'none', reason, nodeMajor] });
  });
  socket.addEventListener('close', event => {
    if (done) return;
    let code = 'other';
    try { if (closeCodes.includes(event.code)) code = event.code; } catch {}
    finish(6, mode === 'frame'
      ? { bridge_failure: [1, 'early_close', phase, code] } : undefined);
  });
}
`;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function browserBridgeCommand(port: number, mode: "frame" | "input") {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid private browser stream port");
  return `node -e ${quote(BROWSER_BRIDGE_PROGRAM)} ${port} ${mode}`;
}
