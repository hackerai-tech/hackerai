import { consumeStream } from "ai";

type AgentUiStreamPipe = {
  stream: ReadableStream<unknown>;
  waitUntilComplete: () => Promise<unknown>;
};

export async function waitForAgentUiStream(
  pipe: AgentUiStreamPipe,
): Promise<void> {
  // Trigger tees output to its remote writer and this local consumer. Leaving
  // the consumer unread retains every chunk for the lifetime of a long run.
  // Drain only that copy; remote delivery must still confirm completion.
  await Promise.all([
    consumeStream({
      stream: pipe.stream,
      onError: (error) => {
        throw error;
      },
    }),
    pipe.waitUntilComplete(),
  ]);
}
