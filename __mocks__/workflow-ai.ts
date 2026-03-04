export class WorkflowChatTransport {
  constructor() {}
  async sendMessages() {
    return new ReadableStream();
  }
  async reconnectToStream() {
    return new ReadableStream();
  }
}
