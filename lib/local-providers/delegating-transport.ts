"use client";

import type { UIMessage } from "ai";

interface TransportLike {
  sendMessages: (options: any) => Promise<ReadableStream<any>>;
  reconnectToStream: (options: any) => Promise<ReadableStream<any> | null>;
}

/**
 * A ChatTransport wrapper that delegates to a dynamically-resolved transport.
 *
 * Supports an optional `beforeSend` callback that runs before each sendMessages
 * call — used to ensure the Codex sidecar is running before sending.
 */
export class DelegatingTransport<T extends UIMessage = UIMessage> {
  private getTransport: () => TransportLike;
  private beforeSend?: () => Promise<void | false>;

  constructor(
    getTransport: () => TransportLike,
    beforeSend?: () => Promise<void | false>,
  ) {
    this.getTransport = getTransport;
    this.beforeSend = beforeSend;
  }

  async sendMessages(options: any): Promise<ReadableStream<any>> {
    if (this.beforeSend) {
      const result = await this.beforeSend();
      // If beforeSend returns false, abort without throwing so the message
      // stays in the input and useChat doesn't enter an error state.
      if (result === false) {
        return new ReadableStream({
          start(c) {
            c.close();
          },
        });
      }
    }
    const transport = this.getTransport();
    return transport.sendMessages(options);
  }

  reconnectToStream(options: any): Promise<ReadableStream<any> | null> {
    return this.getTransport().reconnectToStream(options);
  }
}
