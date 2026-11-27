/**
 * Convex gives up on a WebSocket whose handshake never completes only after
 * 60 seconds, and then abandons it without closing it. Browsers run one
 * handshake per server address at a time, so each retry waits behind the
 * abandoned socket until the browser's own handshake limit expires, minutes
 * later. Closing the socket here cancels the handshake, and Convex's normal
 * close handling schedules the retry.
 */
export const CONVEX_CONNECT_TIMEOUT_MS = 10_000;

export function withConnectTimeout(
  Base: typeof WebSocket,
  timeoutMs: number,
): typeof WebSocket {
  return class ConnectTimeoutWebSocket extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const timer = setTimeout(() => {
        if (this.readyState === this.CONNECTING) this.close();
      }, timeoutMs);
      const cancel = () => clearTimeout(timer);
      this.addEventListener("open", cancel, { once: true });
      this.addEventListener("close", cancel, { once: true });
    }
  };
}
